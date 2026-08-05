import { useState, type FormEvent } from 'react'
import { BrandMark } from '@/components/BrandMark'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Mode = 'login' | 'register'

/**
 * Full-screen gate shown when the client has no session. The app is unusable
 * until the user signs in or registers; success flips the auth store to
 * `authed` and the shell mounts in its place.
 *
 * Load sequence lives under "Auth gate" in globals.css: the brand glyph draws
 * itself stroke by stroke, then greeting, form and footer rise in staggered.
 */
export function AuthScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { login, register, skip, busy, error, clearError } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const isLogin = mode === 'login'

  const switchMode = (): void => {
    setMode(isLogin ? 'register' : 'login')
    clearError()
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (busy) return
    if (isLogin) void login(email.trim(), password)
    else void register(email.trim(), password, displayName.trim())
  }

  const canSubmit =
    email.trim() !== '' && password !== '' && (isLogin || displayName.trim() !== '')

  return (
    <div className="auth-gate app-drag flex h-screen w-screen items-center justify-center bg-background p-6">
      <div className="app-no-drag w-full max-w-xs">
        <BrandMark className="auth-mark size-12 [stroke-width:1.5]" />

        <div className="animate-rise-in mt-7" style={{ animationDelay: '200ms' }}>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isLogin ? t('auth.welcomeBack') : t('auth.createYourAccount')}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isLogin ? t('auth.signInToContinue') : t('auth.syncNote')}
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="animate-rise-in mt-8 space-y-4"
          style={{ animationDelay: '320ms' }}
        >
          {!isLogin && (
            <Field label={t('auth.name')}>
              <Input
                className="h-10"
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
              className="h-10"
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
              className="h-10"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              disabled={busy}
            />
          </Field>

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="h-10 w-full" disabled={!canSubmit || busy}>
            {busy ? t('auth.pleaseWait') : isLogin ? t('auth.signIn') : t('auth.createAccount')}
          </Button>
        </form>

        <p
          className="animate-rise-in mt-6 text-sm text-muted-foreground"
          style={{ animationDelay: '440ms' }}
        >
          {isLogin ? t('auth.noAccountPrompt') : t('auth.haveAccountPrompt')}{' '}
          <button
            type="button"
            onClick={switchMode}
            disabled={busy}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {isLogin ? t('auth.createAccount') : t('auth.signIn')}
          </button>
        </p>

        {/* Local, account-less use: enters the app in local mode; models and
            the rest are configured in the regular Settings tabs. */}
        <div
          className="animate-rise-in mt-10 border-t border-border pt-4"
          style={{ animationDelay: '560ms' }}
        >
          <button
            type="button"
            onClick={() => void skip()}
            disabled={busy}
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('auth.skipLogin')}
          </button>
        </div>
      </div>
    </div>
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
      <span className="block text-[13px] font-medium">{label}</span>
      {children}
    </label>
  )
}
