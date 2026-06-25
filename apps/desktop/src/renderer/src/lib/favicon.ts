/**
 * Resolve a favicon URL for a citation source. Prefers the favicon the search
 * provider returned (Exa includes one per result); falls back to Google's public
 * favicon service keyed by domain. Returns undefined when neither is available,
 * so callers can render a generic icon instead.
 *
 * The favicon is hot-linked (remote `<img>`), same as any other remote image the
 * app already renders — acceptable for a desktop client.
 */
export function getFaviconUrl(favicon?: string, domain?: string): string | undefined {
  if (favicon && favicon.trim()) return favicon
  if (domain && domain.trim()) {
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`
  }
  return undefined
}
