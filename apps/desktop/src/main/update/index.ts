import { app, shell } from 'electron'
import { IPC, type UpdateInfo, type UpdateProgress, type UpdateState } from '@shared/ipc'
import { broadcast } from '../windows'
import { GithubReleasePoll, RELEASES_PAGE } from './github-poll'
import { AutoUpdater } from './auto-updater'

/**
 * The single owner of update state, fronting two very different strategies:
 *
 * - Packaged Windows → `AutoUpdater` (electron-updater/NSIS). Downloads and
 *   installs in place; the badge walks available → downloading → ready.
 * - Everything else → `GithubReleasePoll`. Only ever reaches `available`; the
 *   badge opens the release page and the user installs by hand. macOS is here
 *   because Squirrel.Mac requires a Developer ID signature we don't have yet;
 *   dev runs are here because electron-updater refuses to run unpackaged.
 *
 * Every transition is broadcast to all windows, and `getState()` lets a window
 * that mounted late catch up on the broadcasts it missed.
 */

/** Whether this build can install its own update. */
const CAN_SELF_INSTALL = process.platform === 'win32' && app.isPackaged

export class UpdateManager {
  private state: UpdateState = {
    stage: 'idle',
    info: null,
    progress: null,
    canInstall: CAN_SELF_INSTALL
  }

  private auto: AutoUpdater | null = null
  private poll: GithubReleasePoll | null = null
  /** Last percent we broadcast, so progress events don't spam every renderer. */
  private lastPercent = -1

  start(): void {
    if (CAN_SELF_INSTALL) {
      this.auto = new AutoUpdater({
        onAvailable: (version, notes) =>
          this.markAvailable({ version, url: RELEASES_PAGE, notes }),
        onProgress: (progress) => this.markProgress(progress),
        onReady: (version) => {
          this.lastPercent = -1
          this.set({
            stage: 'ready',
            info: this.state.info ?? { version, url: RELEASES_PAGE },
            progress: null,
            error: undefined
          })
        },
        onError: (message) => {
          // Background check failures are routine (offline, no published release
          // yet, rate limit) and must not paint an error badge. Only a failure
          // during a download the user actually asked for is worth showing.
          if (this.state.stage !== 'downloading') return
          this.lastPercent = -1
          this.set({ stage: 'error', progress: null, error: message })
        }
      })
      this.auto.start()
    } else {
      this.poll = new GithubReleasePoll((info) => this.markAvailable(info))
      this.poll.start()
    }
  }

  /** Stop timers (app teardown). */
  stop(): void {
    this.auto?.stop()
    this.poll?.stop()
  }

  /** The state a newly-mounted window should render. */
  getState(): UpdateState {
    return this.state
  }

  /** Open the release page externally — the manual path, and the error escape hatch. */
  openReleasePage(): void {
    void shell.openExternal(this.state.info?.url ?? RELEASES_PAGE)
  }

  /** Begin downloading. Ignored unless we're self-installing and idle-ish. */
  download(): void {
    if (!this.auto) return
    if (this.state.stage !== 'available' && this.state.stage !== 'error') return
    this.lastPercent = -1
    this.set({
      stage: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      error: undefined
    })
    void this.auto.download()
  }

  /** Quit into the installer. Ignored until the download has finished. */
  install(): void {
    if (!this.auto || this.state.stage !== 'ready') return
    this.auto.install()
  }

  private markAvailable(info: UpdateInfo): void {
    // Both strategies re-report the same release on every interval tick; without
    // this a repeat check mid-download would rewind the stage to `available`.
    if (this.state.info?.version === info.version) return
    this.set({ stage: 'available', info, progress: null, error: undefined })
  }

  private markProgress(progress: UpdateProgress): void {
    // Chunk events land many times a second; only push whole-percent changes.
    const percent = Math.floor(progress.percent)
    if (percent === this.lastPercent) return
    this.lastPercent = percent
    this.set({ stage: 'downloading', progress })
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    broadcast(IPC.UpdateStateChanged, this.state)
  }
}
