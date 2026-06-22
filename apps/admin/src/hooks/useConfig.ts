import { useCallback, useEffect, useState } from 'react'
import type { AdminConfigSnapshot } from '@flairy/shared'
import { ApiError, getConfig } from '@/api/client'

interface UseConfigResult {
  config: AdminConfigSnapshot | null
  loading: boolean
  error: string | null
  /** True while a mutation is in flight. */
  saving: boolean
  /** Last successful mutation timestamp (ms) for transient "Saved" UI. */
  savedAt: number | null
  reload: () => Promise<void>
  /**
   * Run a CRUD call, then reload the snapshot. Tracks `saving`/`error`/`savedAt`.
   * Rethrows so callers can keep editor state open on failure.
   */
  mutate: <T>(fn: () => Promise<T>) => Promise<T>
}

export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<AdminConfigSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setConfig(await getConfig())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  const mutate = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      setSaving(true)
      setError(null)
      try {
        const result = await fn()
        setConfig(await getConfig())
        setSavedAt(Date.now())
        return result
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to save configuration')
        throw err
      } finally {
        setSaving(false)
      }
    },
    []
  )

  useEffect(() => {
    void reload()
  }, [reload])

  return { config, loading, error, saving, savedAt, reload, mutate }
}
