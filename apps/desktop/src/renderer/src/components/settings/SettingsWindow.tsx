import { useEffect } from 'react'
import { useAuth } from '@/store/auth-store'
import { SettingsPage } from './SettingsPage'

/**
 * Root of the standalone Settings window (its own `settings.html` renderer
 * entry). It shares the auth session with the main window via the main process:
 * it restores status on open, follows cross-window auth changes, and closes
 * itself if the user signs out anywhere.
 *
 * The window chrome (sidebar + pane header) is drawn by SettingsPage itself —
 * macOS System Settings style — so this component is just the auth gate.
 */
export function SettingsWindow(): React.JSX.Element {
  const phase = useAuth((s) => s.phase)
  const checkStatus = useAuth((s) => s.checkStatus)

  useEffect(() => {
    void checkStatus()
    return window.api.onAuthChanged(() => void useAuth.getState().checkStatus())
  }, [checkStatus])

  // Signed out (here or in the main window) → this window is useless; close it.
  useEffect(() => {
    if (phase === 'anon') window.close()
  }, [phase])

  // While unauthenticated, paint an opaque surface: the window itself is
  // transparent under vibrancy and would otherwise show the raw desktop.
  return (
    <div className="flex h-screen flex-col">
      {phase === 'authed' ? <SettingsPage /> : <div className="app-drag flex-1 bg-background" />}
    </div>
  )
}
