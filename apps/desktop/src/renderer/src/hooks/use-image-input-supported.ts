import { useEffect, useState } from 'react'
import type { RedactedConfigSnapshot } from '@shared/ipc'

/**
 * How attached images will be handled by the active configuration:
 * - `native` — the `main` model accepts image input directly.
 * - `extract` — `main` can't see images, but a `visual` model is assigned: it
 *   will describe them before the turn, with possible loss of detail.
 * - `unsupported` — no model can read images; pi drops them from the request.
 */
export type ImageInputSupport = 'native' | 'extract' | 'unsupported'

function imageSupportOf(config: RedactedConfigSnapshot | null): ImageInputSupport {
  const input = config?.llm.main?.model.input
  // Unknown (no config/model yet) → assume native, so we never flash a false
  // warning before the snapshot has loaded.
  if (!input) return 'native'
  if (input.includes('image')) return 'native'
  return config?.llm.visual ? 'extract' : 'unsupported'
}

/**
 * How the active config handles image input, tracked live off the server-pushed
 * config (initial snapshot + later `config:updated` deltas). Drives the
 * composer's image warnings. Defaults to `native` until the first snapshot
 * arrives so no warning ever flashes on cold start.
 */
export function useImageInputSupport(): ImageInputSupport {
  const [support, setSupport] = useState<ImageInputSupport>('native')

  useEffect(() => {
    void window.api.getConfig().then((c) => setSupport(imageSupportOf(c)))
    return window.api.onConfigChanged((c) => setSupport(imageSupportOf(c)))
  }, [])

  return support
}
