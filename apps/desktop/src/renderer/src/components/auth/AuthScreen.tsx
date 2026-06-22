import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type Mode = 'login' | 'register'

/**
 * Full-screen gate shown when the client has no session. The app is unusable
 * until the user signs in or registers; success flips the auth store to
 * `authed` and the shell mounts in its place.
 */
export function AuthScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { login, register, busy, error, clearError } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const switchMode = (next: Mode): void => {
    if (next === mode) return
    setMode(next)
    clearError()
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (busy) return
    if (mode === 'login') void login(email.trim(), password)
    else void register(email.trim(), password, displayName.trim())
  }

  const canSubmit =
    email.trim() !== '' &&
    password !== '' &&
    (mode === 'login' || displayName.trim() !== '')

  return (
    <div className="app-drag flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="app-no-drag w-full max-w-sm">
        {/* Wordmark */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-foreground text-background">
            <span className="font-serif text-xl leading-none">F</span>
          </div>
          <div className="text-center">
            <h1 className="text-base font-semibold tracking-tight">Flairy</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {mode === 'login' ? t('auth.signInToContinue') : t('auth.createYourAccount')}
            </p>
          </div>
        </div>

        {/* Tab toggle */}
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1">
          <TabButton active={mode === 'login'} onClick={() => switchMode('login')}>
            {t('auth.signIn')}
          </TabButton>
          <TabButton active={mode === 'register'} onClick={() => switchMode('register')}>
            {t('auth.register')}
          </TabButton>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          {mode === 'register' && (
            <Field label={t('auth.name')}>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('auth.namePlaceholder')}
                autoComplete="name"
                disabled={busy}
              />
            </Field>
          )}
          <Field label={t('auth.email')}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.emailPlaceholder')}
              autoComplete="email"
              autoFocus
              disabled={busy}
            />
          </Field>
          <Field label={t('auth.password')}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={busy}
            />
          </Field>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="w-full" disabled={!canSubmit || busy}>
            {busy
              ? t('auth.pleaseWait')
              : mode === 'login'
                ? t('auth.signIn')
                : t('auth.createAccount')}
          </Button>
        </form>
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 rounded-md text-sm font-medium transition-colors',
        active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="eyebrow">{label}</span>
      {children}
    </label>
  )
}
