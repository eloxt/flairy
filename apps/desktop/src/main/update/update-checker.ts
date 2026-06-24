import { app, shell } from 'electron'
import { IPC, type UpdateInfo } from '@shared/ipc'
import { broadcast } from '../windows'

/**
 * Lightweight update checker. We deliberately do NOT use electron-updater (which
 * is built around silent download + relaunch); the product just wants a gentle
 * "a newer version exists" hint in the header that opens the GitHub release page.
 *
 * So this only polls the GitHub "latest release" API, compares it to the running
 * version, and — when newer — remembers the release and tells every window. The
 * renderer surfaces a badge; clicking it opens the release page in the browser.
 */

const REPO = 'eloxt/flairy'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** Fallback page when no specific release URL is known. */
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** Re-check periodically so a long-running app still notices a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
/** Small delay after launch so the check never competes with startup work. */
const INITIAL_DELAY_MS = 10 * 1000

/** Parse "1.2.3" / "v1.2.3" into numeric parts; non-numeric segments → 0. */
function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    // Drop any pre-release/build suffix (e.g. "1.2.3-beta.1") for the comparison.
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
}

/** True if `latest` is strictly newer than `current` (semver-ish, numeric). */
function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const da = a[i] ?? 0
    const db = b[i] ?? 0
    if (da !== db) return da > db
  }
  return false
}

export class UpdateManager {
  /** The newest release seen that's ahead of the running version, else null. */
  private available: UpdateInfo | null = null

  /** Begin checking: once shortly after launch, then on a fixed interval. */
  start(): void {
    setTimeout(() => void this.check(), INITIAL_DELAY_MS)
    setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  /** The update the renderer should surface, or null when up to date. */
  getStatus(): UpdateInfo | null {
    return this.available
  }

  /** Open the available release page (or the generic releases page) externally. */
  openReleasePage(): void {
    void shell.openExternal(this.available?.url ?? RELEASES_PAGE)
  }

  /**
   * Query GitHub for the latest published release and, if it's newer than the
   * running version, record it and broadcast to all windows. Network/parse
   * failures are swallowed — an update hint is best-effort, never fatal.
   */
  private async check(): Promise<void> {
    try {
      const res = await fetch(LATEST_RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Flairy-Desktop'
        }
      })
      if (!res.ok) return
      const data = (await res.json()) as {
        tag_name?: string
        html_url?: string
        name?: string
        body?: string
      }
      const tag = data.tag_name
      if (!tag) return

      if (isNewer(tag, app.getVersion())) {
        const info: UpdateInfo = {
          version: tag.replace(/^v/i, ''),
          url: data.html_url ?? RELEASES_PAGE,
          notes: data.name || undefined
        }
        // Avoid re-broadcasting the same release on every interval tick.
        if (this.available?.version === info.version) return
        this.available = info
        broadcast(IPC.UpdateAvailable, info)
      }
    } catch {
      // Offline / rate-limited / malformed response: ignore and retry next tick.
    }
  }
}
