import { create } from 'zustand'
import type { AuthUser } from '@shared/ipc'

/**
 * `loading` — checking persisted status on launch (avoid flashing the login form).
 * `anon`    — no valid session; the gate shows the auth screen.
 * `authed`  — signed in; the app shell is usable.
 */
type AuthPhase = 'loading' | 'anon' | 'authed'

interface AuthState {
  phase: AuthPhase
  user: AuthUser | null
  /** Last auth error, surfaced on the login/register form. */
  error: string | null
  /** A login/register request is in flight. */
  busy: boolean

  /** Restore session from the main process on launch. */
  checkStatus: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuth = create<AuthState>((set) => ({
  phase: 'loading',
  user: null,
  error: null,
  busy: false,

  checkStatus: async () => {
    const status = await window.api.authStatus()
    set({
      phase: status.authenticated ? 'authed' : 'anon',
      user: status.user ?? null
    })
  },

  login: async (email, password) => {
    set({ busy: true, error: null })
    try {
      const status = await window.api.login({ email, password })
      set({ phase: 'authed', user: status.user ?? null, busy: false })
    } catch (err) {
      set({ busy: false, error: friendlyError(err) })
    }
  },

  register: async (email, password, displayName) => {
    set({ busy: true, error: null })
    try {
      const status = await window.api.register({ email, password, displayName })
      set({ phase: 'authed', user: status.user ?? null, busy: false })
    } catch (err) {
      set({ busy: false, error: friendlyError(err) })
    }
  },

  logout: async () => {
    await window.api.logout()
    set({ phase: 'anon', user: null, error: null })
  },

  clearError: () => set({ error: null })
}))

/** Strip the technical prefix the main process adds, leaving a readable message. */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Surface the server's detail when present; otherwise a generic fallback.
  if (/invalid credentials/i.test(msg)) return 'Incorrect email or password.'
  if (/already registered/i.test(msg)) return 'That email is already registered.'
  if (/failed to fetch|networkerror|ECONNREFUSED/i.test(msg)) {
    return 'Cannot reach the server. Check your connection and try again.'
  }
  return msg
}
