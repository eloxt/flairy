/**
 * Resolve a favicon URL for a citation source. Prefers the favicon the search
 * provider returned (Exa includes one per result — usually the site's own);
 * falls back to the conventional `/favicon.ico` at the source URL's own origin
 * (NOT a third-party favicon service, so lookups don't leak browsing to Google).
 * Returns undefined when neither is derivable, so callers render a generic icon.
 *
 * The fallback misses sites that only declare their icon via `<link rel>` —
 * the `Favicon` component swaps to a globe glyph when the image fails to load.
 */
export function getFaviconUrl(favicon?: string | null, sourceUrl?: string): string | undefined {
  if (favicon && favicon.trim()) return favicon
  if (sourceUrl) {
    try {
      const origin = new URL(sourceUrl).origin
      // CSP only allows https: images; a derived http origin would just 404 the
      // chip into its globe fallback, so don't bother emitting it.
      if (origin.startsWith('https://')) return `${origin}/favicon.ico`
    } catch {
      // Unparseable source URL — nothing to derive.
    }
  }
  return undefined
}
