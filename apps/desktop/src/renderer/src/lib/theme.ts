/**
 * Follow the OS light/dark appearance on the document root. Graphite ships a
 * fully-tuned light *and* dark palette; we mirror the system rather than
 * shipping a manual toggle. Called once per renderer entry (every window).
 */
export function followSystemTheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (dark: boolean): void => {
    document.documentElement.classList.toggle('dark', dark)
  }
  apply(media.matches)
  media.addEventListener('change', (e) => apply(e.matches))
}
