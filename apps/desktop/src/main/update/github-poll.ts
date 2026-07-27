import { app } from 'electron'
import type { UpdateInfo } from '@shared/ipc'

/**
 * The fallback update path: poll GitHub's "latest release" API and report a
 * newer version, nothing more. Used wherever the app can't install its own
 * update — macOS and Linux builds, plus any unpackaged dev run (electron-updater
 * refuses to operate outside a packaged app). The badge it drives just opens the
 * release page in the browser.
 */

const REPO = 'eloxt/flairy'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** Fallback page when no specific release URL is known. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** Re-check periodically so a long-running app still notices a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
/** Small delay after launch so the check never competes with startup work. */
const INITIAL_DELAY_MS = 10 * 1000

/** Parse "1.2.3" / "v1.2.3" into numeric parts; non-numeric segments → 0. */
function parseVersion(v: string): number[] {
  return (
    v
      .trim()
      .replace(/^v/i, '')
      // Drop any pre-release/build suffix (e.g. "1.2.3-beta.1") for the comparison.
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  )
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

export class GithubReleasePoll {
  private timer: ReturnType<typeof setInterval> | null = null

  /** `onFound` may fire repeatedly with the same release; the caller dedupes. */
  constructor(private readonly onFound: (info: UpdateInfo) => void) {}

  /** Begin checking: once shortly after launch, then on a fixed interval. */
  start(): void {
    setTimeout(() => void this.check(), INITIAL_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Query GitHub for the latest published release and, if it's newer than the
   * running version, hand it to `onFound`. Network/parse failures are swallowed
   * — an update hint is best-effort, never fatal.
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
        this.onFound({
          version: tag.replace(/^v/i, ''),
          url: data.html_url ?? RELEASES_PAGE,
          notes: data.name || undefined
        })
      }
    } catch {
      // Offline / rate-limited / malformed response: ignore and retry next tick.
    }
  }
}
