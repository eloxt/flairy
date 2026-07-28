import { useEffect, useState } from 'react'
import type { ActiveLlm } from '@flairy/shared'

/**
 * The effective main model plus the user-selectable candidates, tracked live
 * off the config broadcasts. `preferredId` is the user's own pick (null =
 * following the admin assignment); it is normalized to null when the pick no
 * longer matches a delivered candidate so the "default" row shows as selected.
 *
 * `setPreferred` only invokes IPC — state flows back through the events, so
 * the main process stays the single source of truth.
 */
export function useMainModel(): {
  current: ActiveLlm | null
  options: ActiveLlm[]
  preferredId: string | null
  setPreferred: (id: string | null) => void
} {
  const [current, setCurrent] = useState<ActiveLlm | null>(null)
  const [options, setOptions] = useState<ActiveLlm[]>([])
  const [rawPreferred, setRawPreferred] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getConfig().then((c) => {
      setCurrent(c?.llm.main ?? null)
      setOptions(c?.modelOptions ?? [])
    })
    void window.api.getPreferredMainModel().then(setRawPreferred)
    const offConfig = window.api.onConfigChanged((c) => {
      setCurrent(c.llm.main ?? null)
      setOptions(c.modelOptions ?? [])
    })
    const offPreferred = window.api.onPreferredMainModelChanged(setRawPreferred)
    return () => {
      offConfig()
      offPreferred()
    }
  }, [])

  const preferredId =
    rawPreferred && options.some((o) => o.model.id === rawPreferred) ? rawPreferred : null

  return {
    current,
    options,
    preferredId,
    setPreferred: (id) => void window.api.setPreferredMainModel(id)
  }
}
