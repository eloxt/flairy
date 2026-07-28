/**
 * Resolve a chat image's `data` field into an `<img src>`.
 *
 * `data` is either raw base64 (a freshly-attached image, or a legacy persisted
 * message) or an on-disk store ref (`flairy-img:<hash>.<ext>`, see the main
 * process's image-store). Refs load through the `flairy-img://` protocol so the
 * base64 never crosses IPC or sits in renderer memory — Chromium streams the
 * file and caches the decoded bitmap itself.
 */
const REF_PREFIX = 'flairy-img:'

export function imageSrc(img: { data: string; mimeType: string }): string {
  return img.data.startsWith(REF_PREFIX)
    ? `flairy-img://${img.data.slice(REF_PREFIX.length)}`
    : `data:${img.mimeType};base64,${img.data}`
}
