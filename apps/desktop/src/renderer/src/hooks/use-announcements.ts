import { useCallback, useEffect, useState } from 'react'
import type { AnnouncementConfig } from '@flairy/shared'

/** Where per-install dismissed announcement ids live. Never sensitive. */
const DISMISSED_KEY = 'flairy.announcements.dismissed'

/** Read the dismissed-id set from localStorage (best-effort). */
function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch {
    // Private mode / corrupt value: treat as nothing dismissed.
    return new Set()
  }
}

/** Persist the dismissed-id set (best-effort; dismissing still works in-memory). */
function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]))
  } catch {
    // Best-effort persistence.
  }
}

/**
 * The enabled, not-yet-dismissed system announcements, tracked live off the
 * server-pushed config (initial snapshot + later `config:updated` deltas), plus a
 * `dismiss` that hides one and remembers it locally (localStorage, never synced to
 * the server). Used by the empty chat screen to show banners atop a fresh session.
 */
export function useAnnouncements(): {
  announcements: AnnouncementConfig[]
  dismiss: (id: string) => void
} {
  const [all, setAll] = useState<AnnouncementConfig[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed)

  useEffect(() => {
    void window.api.getConfig().then((c) => setAll(c?.announcements ?? []))
    return window.api.onConfigChanged((c) => setAll(c.announcements ?? []))
  }, [])

  const dismiss = useCallback((id: string): void => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      saveDismissed(next)
      return next
    })
  }, [])

  const announcements = all.filter((a) => a.enabled && !dismissed.has(a.id))
  return { announcements, dismiss }
}
