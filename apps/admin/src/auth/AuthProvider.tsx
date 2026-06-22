import { useCallback, useMemo, useState } from 'react'
import type { LoginRequest, User } from '@flairy/shared'
import * as api from '@/api/client'
import { AuthContext, type AuthContextValue } from './context'

const USER_KEY = 'flairy.admin.user'

function loadStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [token, setTokenState] = useState<string | null>(() => api.getToken())
  const [user, setUser] = useState<User | null>(() => loadStoredUser())

  const login = useCallback(async (credentials: LoginRequest) => {
    const res = await api.login(credentials)
    // The admin web is for administrators only. Non-admin accounts authenticate
    // fine but the server rejects every admin endpoint with 403, so refuse here
    // with a clear message instead of letting them in to hit walls.
    if (res.user.role !== 'admin') {
      throw new Error('This account is not an administrator.')
    }
    api.setToken(res.token)
    localStorage.setItem(USER_KEY, JSON.stringify(res.user))
    setTokenState(res.token)
    setUser(res.user)
  }, [])

  const logout = useCallback(() => {
    api.clearToken()
    localStorage.removeItem(USER_KEY)
    setTokenState(null)
    setUser(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, token, login, logout }),
    [user, token, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
