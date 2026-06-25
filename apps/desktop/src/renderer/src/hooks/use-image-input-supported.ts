import { useEffect, useState } from 'react'
import type { RedactedConfigSnapshot } from '@shared/ipc'

/** Does the given config's active `main` model accept image input? */
function supportsImages(config: RedactedConfigSnapshot | null): boolean {
  const input = config?.llm.main?.model.input
  // Unknown (no config/model yet) → assume yes, so we never flash a false
  // "images unsupported" warning before the snapshot has loaded.
  if (!input) return true
  return input.includes('image')
}

/**
 * Whether the active `main` model can be sent images, tracked live off the
 * server-pushed config (initial snapshot + later `config:updated` deltas). Drives
 * the composer's "this model ignores images" reminder. Defaults to `true` until
 * the first snapshot arrives so the warning never flashes on cold start.
 */
export function useImageInputSupported(): boolean {
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    void window.api.getConfig().then((c) => setSupported(supportsImages(c)))
    return window.api.onConfigChanged((c) => setSupported(supportsImages(c)))
  }, [])

  return supported
}
