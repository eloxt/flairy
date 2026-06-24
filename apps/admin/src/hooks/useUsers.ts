import { useCallback, useEffect, useState } from 'react'
import type { UserSummary } from '@flairy/shared'
import { ApiError, listUsers } from '@/api/client'

interface UseUsersResult {
  users: UserSummary[] | null
  loading: boolean
  error: string | null
  /** True while a create/update/delete is in flight. */
  saving: boolean
  reload: () => Promise<void>
  /**
   * Run a CRUD call, then reload the list. Tracks `saving`/`error`. Rethrows so
   * callers can keep an editor open on failure.
   */
  mutate: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * Loads the admin user list. Deliberately separate from `useConfig`: users are
 * not part of the broadcast config snapshot, they live behind their own
 * admin-only `/api/users` endpoints.
 */
export function useUsers(): UseUsersResult {
  const [users, setUsers] = useState<UserSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await listUsers())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  const mutate = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSaving(true)
    setError(null)
    try {
      const result = await fn()
      setUsers(await listUsers())
      return result
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save user')
      throw err
    } finally {
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { users, loading, error, saving, reload, mutate }
}
