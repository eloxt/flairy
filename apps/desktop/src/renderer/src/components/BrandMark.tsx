/**
 * The Flairy mark — the same glyph `build/icon.svg` rasterizes into the dock,
 * tray and installer icons (`pnpm icons`).
 *
 * Inlined rather than pulled from an icon package: the packaged app icon is a
 * checked-in SVG, so anywhere the mark appears in-app has to draw those exact
 * paths or the About panel stops matching the icon in the dock. Keep this in
 * sync with `build/icon.svg` — they are one asset in two places.
 */
export function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="4" cy="4" r="2" />
      <path d="m14 5 3-3 3 3" />
      <path d="m14 10 3-3 3 3" />
      <path d="M17 14V2" />
      <path d="M17 14H7l-5 8h20Z" />
      <path d="M8 14v8" />
      <path d="m9 14 5 8" />
    </svg>
  )
}
