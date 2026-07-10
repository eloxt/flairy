import { useEffect, useState } from 'react'

/**
 * Track the app's light/dark appearance reactively. `lib/theme.ts`
 * (followSystemTheme) is the single source of truth — it toggles the `.dark`
 * class on the document root — and the @pierre libraries need an explicit
 * theme/themeType to pick the matching Shiki variant, so we observe that class
 * rather than subscribing to the media query a second time.
 */
export function useRootDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}
