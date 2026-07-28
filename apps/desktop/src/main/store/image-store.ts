import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app, protocol } from 'electron'

/**
 * Content-addressed on-disk store for chat images.
 *
 * Base64 image payloads used to live inside the persisted message blobs (and in
 * every in-memory copy of them: agent state, sync payloads, renderer stores).
 * A single screenshot could exist as 4-5 multi-megabyte JS strings at once.
 * Instead, images are written once to `userData/images/<sha256>.<ext>` and the
 * message keeps a small REF string in the image part's `data` field:
 *
 *     { type: 'image', data: 'flairy-img:<sha256>.<ext>', mimeType }
 *
 * - SQLite / agent state / renderer stores carry only the ref.
 * - The LLM-bound view rehydrates refs back to base64 (see rehydrateImages),
 *   as does the server sync payload — the wire contract is unchanged, so other
 *   devices still receive full images (and dehydrate them into their own store
 *   on write, see saveMessages/upsertRemoteSession).
 * - Renderers display refs via the `flairy-img://` protocol (registered below),
 *   so no base64 string ever crosses IPC for a replayed image.
 *
 * Old sessions with inline base64 keep working everywhere (every consumer
 * passes base64 through untouched) and are dehydrated lazily on their next save.
 */

export const IMAGE_REF_PREFIX = 'flairy-img:'

/** Custom scheme the renderer uses to load stored images (`flairy-img://<file>`). */
export const IMAGE_PROTOCOL_SCHEME = 'flairy-img'

/** Stored file names are strictly `<sha256 hex>.<known ext>` — nothing else resolves. */
const FILE_NAME_RE = /^[a-f0-9]{64}\.(png|jpg|webp|gif|bin)$/

/**
 * Finds ref occurrences inside a raw persisted-messages JSON string (no parse
 * needed — refs are stored literally). Capture group 1 is the file name. Safe
 * to share: String.prototype.matchAll never mutates the source regex.
 */
export const IMAGE_REF_SCAN_RE = /flairy-img:([a-f0-9]{64}\.(?:png|jpg|webp|gif|bin))/g

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bin: 'application/octet-stream'
}

/** Image parts smaller than this stay inline — not worth a file + read round-trip. */
const MIN_EXTRACT_CHARS = 8 * 1024

let dir: string | null = null

function imagesDir(): string {
  if (!dir) {
    dir = join(app.getPath('userData'), 'images')
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** Whether an image part's `data` is a store ref rather than inline base64. */
export function isImageRef(data: unknown): data is string {
  return typeof data === 'string' && data.startsWith(IMAGE_REF_PREFIX)
}

/**
 * Write a base64 image to the store (no-op if the content already exists) and
 * return its ref string. Falls back to returning the base64 unchanged if the
 * payload doesn't decode or the write fails — the caller then keeps the old
 * inline behavior instead of losing the image.
 */
export function putImage(base64: string, mimeType: string): string {
  try {
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0) return base64
    const hash = createHash('sha256').update(buf).digest('hex')
    const ext = EXT_BY_MIME[mimeType] ?? 'bin'
    const name = `${hash}.${ext}`
    const path = join(imagesDir(), name)
    if (!existsSync(path)) writeFileSync(path, buf)
    return IMAGE_REF_PREFIX + name
  } catch (err) {
    console.error('[image-store] putImage failed:', err)
    return base64
  }
}

/** Read a stored image back as base64, or null for an invalid/missing ref. */
export function readImageBase64(ref: string): string | null {
  const name = ref.slice(IMAGE_REF_PREFIX.length)
  if (!FILE_NAME_RE.test(name)) return null
  try {
    return readFileSync(join(imagesDir(), name)).toString('base64')
  } catch {
    return null
  }
}

type ImagePart = { type?: unknown; data?: unknown; mimeType?: unknown }

function isInlineImagePart(p: unknown): p is ImagePart & { data: string } {
  return (
    Boolean(p) &&
    typeof p === 'object' &&
    (p as ImagePart).type === 'image' &&
    typeof (p as ImagePart).data === 'string' &&
    !isImageRef((p as ImagePart).data) &&
    ((p as ImagePart).data as string).length >= MIN_EXTRACT_CHARS
  )
}

function isRefImagePart(p: unknown): p is ImagePart & { data: string } {
  return (
    Boolean(p) &&
    typeof p === 'object' &&
    (p as ImagePart).type === 'image' &&
    isImageRef((p as ImagePart).data)
  )
}

/**
 * Replace inline base64 image parts with store refs across a message array.
 * Clones only along modified paths (untouched messages keep their identity), so
 * callers can cheaply detect "nothing changed" via reference equality.
 */
export function dehydrateImages(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content) || !content.some(isInlineImagePart)) return m
    changed = true
    return {
      ...(m as object),
      content: content.map((p) =>
        isInlineImagePart(p)
          ? { ...p, data: putImage(p.data, String((p as ImagePart).mimeType ?? 'image/png')) }
          : p
      )
    }
  })
  return changed ? out : messages
}

/**
 * Resolve store refs back to inline base64 across a message array (the inverse
 * of {@link dehydrateImages}) — for LLM requests and server sync, which both
 * need real image bytes. A ref whose file is gone becomes a text note so the
 * provider never sees a bogus payload. Clones only along modified paths.
 */
export function rehydrateImages(messages: unknown[]): unknown[] {
  let changed = false
  const out = messages.map((m) => {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content) || !content.some(isRefImagePart)) return m
    changed = true
    return {
      ...(m as object),
      content: content.map((p) => {
        if (!isRefImagePart(p)) return p
        const base64 = readImageBase64(p.data)
        return base64
          ? { ...p, data: base64 }
          : { type: 'text', text: '(image unavailable)' }
      })
    }
  })
  return changed ? out : messages
}

/**
 * Never garbage-collect a file younger than this. A freshly attached image is
 * written by putImage BEFORE its message reaches SQLite (persist runs at the
 * turn boundary), so a concurrent sweep would otherwise see it as an orphan
 * and delete it out from under the in-flight turn. One hour is far beyond any
 * turn's lifetime and still reclaims real orphans on the next day's sweep.
 */
const MIN_ORPHAN_AGE_MS = 60 * 60_000

/**
 * Delete stored images that are no longer referenced by any persisted message
 * (`liveNames` = file names collected from SQLite, see collectLiveImageNames)
 * and are older than {@link MIN_ORPHAN_AGE_MS}. Orphans accrue from deleted
 * sessions and remote history rewrites — content-addressed files are shared, so
 * deletion can't be done per-session. Returns the number of files removed.
 */
export function sweepOrphanImages(liveNames: Set<string>): number {
  let entries: string[]
  try {
    entries = readdirSync(imagesDir())
  } catch {
    return 0
  }
  const cutoff = Date.now() - MIN_ORPHAN_AGE_MS
  let deleted = 0
  for (const name of entries) {
    if (!FILE_NAME_RE.test(name) || liveNames.has(name)) continue
    const path = join(imagesDir(), name)
    try {
      if (statSync(path).mtimeMs > cutoff) continue
      unlinkSync(path)
      deleted++
    } catch {
      // Racing viewer/read is harmless; try again on the next sweep.
    }
  }
  return deleted
}

/**
 * Remove EVERY stored image, age guard included (sign-out): the session wipe
 * orphans them all at once, and a signed-out machine must not keep the previous
 * account's pictures on disk — mirrors clearAllSessions/clearAllMemories.
 */
export function clearAllImages(): void {
  let entries: string[]
  try {
    entries = readdirSync(imagesDir())
  } catch {
    return
  }
  for (const name of entries) {
    if (!FILE_NAME_RE.test(name)) continue
    try {
      unlinkSync(join(imagesDir(), name))
    } catch {
      // Best-effort; a straggler is caught by the next sweep.
    }
  }
}

/**
 * Grant the scheme fetch/streaming semantics. MUST run before app `ready`
 * (Electron requirement); the actual handler registers in {@link registerImageProtocol}.
 */
export function registerImageProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL_SCHEME,
      privileges: { supportFetchAPI: true, stream: true }
    }
  ])
}

/**
 * Serve `flairy-img://<sha256>.<ext>` from the on-disk store. File names are
 * validated against the strict content-hash pattern, so the scheme cannot be
 * used to read arbitrary paths. Registered once after app `ready`.
 */
export function registerImageProtocol(): void {
  protocol.handle(IMAGE_PROTOCOL_SCHEME, (request) => {
    // Manual parse: with a non-standard scheme the URL may arrive as
    // `flairy-img://name`, `flairy-img:name`, or with a trailing slash.
    const name = request.url
      .slice(request.url.indexOf(':') + 1)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    if (!FILE_NAME_RE.test(name)) {
      return new Response('not found', { status: 404 })
    }
    const path = join(imagesDir(), name)
    if (!existsSync(path)) return new Response('not found', { status: 404 })
    const ext = name.slice(name.lastIndexOf('.') + 1)
    // Read + respond directly (chat images are small, ≤ a few MB): net.fetch's
    // `headers` option sets REQUEST headers, so it can't stamp the Content-Type.
    return new Response(new Uint8Array(readFileSync(path)), {
      headers: {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Cache-Control': 'max-age=31536000, immutable'
      }
    })
  })
}
