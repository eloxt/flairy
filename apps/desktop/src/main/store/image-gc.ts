import { collectLiveImageNames } from './db'
import { sweepOrphanImages } from './image-store'

/**
 * Debounced orchestrator for the orphaned-image sweep. Sits between db.ts
 * (which knows the live refs) and image-store.ts (which owns the files) so
 * neither has to import the other's sweep trigger.
 *
 * Callers just fire-and-forget scheduleImageSweep() at every point that can
 * orphan files — startup, session delete (local or remote), a bulk pull that
 * rewrites history. Bursts coalesce into one sweep; the run itself is cheap
 * (one streamed regex scan over the messages blobs + a readdir), and the
 * 1-hour age guard inside sweepOrphanImages keeps it safe to run any time.
 */

let timer: ReturnType<typeof setTimeout> | null = null

export function scheduleImageSweep(delayMs = 30_000): void {
  if (timer) return // one already pending — the coming sweep covers this event
  timer = setTimeout(() => {
    timer = null
    try {
      const deleted = sweepOrphanImages(collectLiveImageNames())
      if (deleted > 0) console.log(`[image-gc] removed ${deleted} orphaned image file(s)`)
    } catch (err) {
      console.error('[image-gc] sweep failed:', err)
    }
  }, delayMs)
  timer.unref()
}
