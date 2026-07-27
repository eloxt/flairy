import electronUpdater, { type ProgressInfo, type UpdateInfo as ReleaseInfo } from 'electron-updater'
import type { UpdateProgress } from '@shared/ipc'

/**
 * The self-updating path, Windows/NSIS only.
 *
 * electron-updater downloads the new one-click installer itself and runs it
 * with `/S`, so the whole thing is silent. Two things make that work without a
 * code-signing certificate: the publisher-name check is skipped when the running
 * app is unsigned, and the installer is fetched over plain HTTP by us rather
 * than by a browser — so it never gets a Mark-of-the-Web and SmartScreen never
 * fires. (macOS is the opposite: Squirrel.Mac hard-requires a valid signature,
 * which is why that platform falls back to `github-poll.ts`.)
 */

// electron-updater is CommonJS and defines `autoUpdater` as a lazy getter via
// Object.defineProperty. Under `"type": "module"` our main bundle is ESM, and
// Node's CJS named-export detection can't see getter-defined exports — a named
// `import { autoUpdater }` throws at runtime. Destructure off the default import.
const { autoUpdater } = electronUpdater

/** How often to re-check while the app stays open. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
/** Small delay after launch so the check never competes with startup work. */
const INITIAL_DELAY_MS = 10 * 1000

export interface AutoUpdaterHooks {
  /** A newer release exists (nothing downloaded yet — `autoDownload` is off). */
  onAvailable: (version: string, notes?: string) => void
  onProgress: (progress: UpdateProgress) => void
  /** The installer is on disk; the app can now quit into it. */
  onReady: (version: string) => void
  onError: (message: string) => void
}

export class AutoUpdater {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly hooks: AutoUpdaterHooks) {}

  start(): void {
    // Downloading is user-initiated (the badge): never spend someone's bandwidth
    // on a background download they didn't ask for. If they do download and then
    // just close the app instead of restarting, install it on the way out.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false

    autoUpdater.on('update-available', (info: ReleaseInfo) => {
      this.hooks.onAvailable(info.version, releaseName(info))
    })
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      this.hooks.onProgress({
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond
      })
    })
    autoUpdater.on('update-downloaded', (event) => {
      this.hooks.onReady(event.version)
    })
    autoUpdater.on('error', (err: Error) => {
      this.hooks.onError(err?.message ?? String(err))
    })

    setTimeout(() => void this.check(), INITIAL_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Start fetching the installer. Progress arrives via `onProgress`. */
  async download(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      // downloadUpdate() rejects *and* emits 'error'; onError already ran.
      void err
    }
  }

  /**
   * Quit into the downloaded installer: silent (`/S`) and relaunch afterwards.
   * This calls app.quit(), so the app's before-quit teardown still runs.
   */
  install(): void {
    autoUpdater.quitAndInstall(true, true)
  }

  /** Ask GitHub whether a newer release is published. Failures surface via 'error'. */
  private async check(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      // Offline / rate-limited / no published release yet: retry next tick.
    }
  }
}

/** electron-updater's releaseName is `string | null | undefined`; normalize it. */
function releaseName(info: ReleaseInfo): string | undefined {
  return info.releaseName ?? undefined
}
