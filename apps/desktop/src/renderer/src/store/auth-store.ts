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
  /**
   * Enter the app without an account (local, non-synced use). Switches to
   * local mode; the user configures models/tools/prompts/skills in the regular
   * Settings tabs whenever they open Settings — nothing is opened for them.
   */
  skip: () => Promise<void>
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
    if (status.authenticated) {
      set({ phase: 'authed', user: status.user ?? null })
      return
    }
    // A detached (local-mode) client runs without an account — don't put the
    // login wall in front of it on relaunch.
    const mode = await window.api.getConfigMode().catch(() => 'server' as const)
    set({ phase: mode === 'local' ? 'authed' : 'anon', user: null })
  },

  skip: async () => {
    // "Use locally" means it: detach from the server right away. This is also
    // what lets the Settings window open at all for an anonymous session (its
    // auth gate resolves local-mode clients to `authed`) and what bypasses
    // the login wall on relaunch.
    await window.api.setConfigMode('local')
    set({ phase: 'authed', user: null, error: null })
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
