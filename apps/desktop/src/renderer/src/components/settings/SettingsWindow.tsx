import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth-store'
import { SettingsPage } from './SettingsPage'

/**
 * Root of the standalone Settings window (its own `settings.html` renderer
 * entry). It shares the auth session with the main window via the main process:
 * it restores status on open, follows cross-window auth changes, and closes
 * itself if the user signs out anywhere.
 */
export function SettingsWindow(): React.JSX.Element {
  const { t } = useTranslation()
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

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="app-drag flex h-12 shrink-0 items-center border-b border-border/70 pl-20 pr-4">
        <span className="text-[0.9rem] font-semibold tracking-tight">{t('common.settings')}</span>
      </header>
      {phase === 'authed' ? <SettingsPage /> : <div className="flex-1" />}
    </div>
  )
}
