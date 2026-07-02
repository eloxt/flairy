import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppLanguage, Memory, RedactedConfigSnapshot, TelegramStatus } from '@shared/ipc'
import { useAuth } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

type Tab = 'profile' | 'interface' | 'memory' | 'telegram' | 'about'

/**
 * End-user settings, split into tabs:
 *   - Profile   — signed-in identity + sign out
 *   - Interface — display language
 *   - Memory    — what the assistant remembers about the user (view/forget)
 *   - About     — app name/version, with the raw server config tucked behind a
 *                 collapsible for support/troubleshooting (no jargon up front).
 */
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('profile')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: t('settings.tabProfile') },
    { id: 'interface', label: t('settings.tabInterface') },
    { id: 'memory', label: t('settings.tabMemory') },
    { id: 'telegram', label: t('settings.tabTelegram') },
    { id: 'about', label: t('settings.tabAbout') }
  ]

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <nav className="mb-6 flex gap-1 border-b border-border/70">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'profile' && <ProfileTab />}
        {tab === 'interface' && <InterfaceTab />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'telegram' && <TelegramTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  )
}

/** Signed-in identity + sign out. Logging out drops the session and shows the gate. */
function ProfileTab(): React.JSX.Element {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)

  // Logging out broadcasts across windows: the main window re-gates and this
  // Settings window closes itself (see SettingsWindow).
  const onSignOut = (): void => void logout()

  return (
    <div className="space-y-6">
      <Section title={t('settings.account')}>
        <Row label={t('settings.name')} value={user?.displayName ?? t('settings.signedIn')} />
        {user?.email && <Row label={t('settings.email')} value={user.email} />}
        <div className="mt-4 border-t border-border/60 pt-4">
          <Button variant="outline" size="sm" onClick={onSignOut}>
            {t('settings.signOut')}
          </Button>
        </div>
      </Section>
    </div>
  )
}

/** Language switcher + close-to-tray toggle. */
function InterfaceTab(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const options: { lng: AppLanguage; label: string }[] = [
    { lng: 'en', label: 'English' },
    { lng: 'zh-CN', label: '简体中文' }
  ]

  const current = i18n.language

  const onSelect = (lng: AppLanguage): void => {
    void window.api.setLanguage(lng)
  }

  // Defaults to on; main resolves the real value (missing key → on).
  const [closeToTray, setCloseToTray] = useState(true)
  useEffect(() => {
    void window.api.getCloseToTray().then(setCloseToTray)
  }, [])
  const onToggleCloseToTray = (v: boolean): void => {
    setCloseToTray(v)
    void window.api.setCloseToTray(v)
  }

  return (
    <div className="space-y-6">
      <Section title={t('settings.language')}>
        <p className="mb-3 text-sm text-muted-foreground">{t('settings.languageDescription')}</p>
        <div className="flex gap-2">
          {options.map(({ lng, label }) => (
            <Button
              key={lng}
              variant={current === lng ? 'default' : 'outline'}
              size="sm"
              onClick={() => onSelect(lng)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Section>

      <Section title={t('settings.closeToTray')}>
        <p className="mb-3 text-sm text-muted-foreground">
          {t('settings.closeToTrayDescription')}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={closeToTray} onCheckedChange={onToggleCloseToTray} />
          {t('settings.closeToTrayLabel')}
        </label>
      </Section>
    </div>
  )
}

/**
 * What the assistant remembers about the user. Memories are written
 * automatically by the assistant during conversations; here the user can review
 * them and forget any (or all). Live-refreshes via onMemoriesChanged so a memory
 * the assistant just wrote (or one synced from another device) appears at once.
 */
function MemoryTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [memories, setMemories] = useState<Memory[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  useEffect(() => {
    void window.api.listMemories().then((m) => {
      setMemories(m)
      setLoaded(true)
    })
    return window.api.onMemoriesChanged(() => {
      void window.api.listMemories().then(setMemories)
    })
  }, [])

  const onForget = (id: string): void => {
    void window.api.deleteMemory(id).then(setMemories)
  }

  const onClearAll = (): void => {
    void window.api.clearMemories().then((m) => {
      setMemories(m)
      setConfirmingClear(false)
    })
  }

  return (
    <div className="space-y-6">
      <Section title={t('settings.memory')}>
        <p className="mb-3 text-sm text-muted-foreground">{t('settings.memoryDescription')}</p>

        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">{t('settings.loadingConfig')}</p>
        ) : memories.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('settings.memoryEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {memories.map((m) => (
              <li
                key={m.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
              >
                <span className="text-sm break-words">{m.text}</span>
                <button
                  type="button"
                  onClick={() => onForget(m.id)}
                  className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-destructive"
                >
                  {t('settings.memoryForget')}
                </button>
              </li>
            ))}
          </ul>
        )}

        {memories.length > 0 && (
          <div className="mt-4 border-t border-border/60 pt-4">
            {confirmingClear ? (
              <div className="flex items-center gap-2">
                <Button variant="destructive" size="sm" onClick={onClearAll}>
                  {t('settings.memoryClearConfirm')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setConfirmingClear(false)}>
                  {t('settings.cancel')}
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmingClear(true)}>
                {t('settings.memoryClearAll')}
              </Button>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

/**
 * Telegram remote-chat settings. Lets the user connect a bot token, pair their
 * private chat with the bot (native Threaded Mode), and manage the kill switch —
 * all in plain language.
 * The token is write-only: the form sends it to main but never gets it back.
 */
function TelegramTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)

  // Load initial status and subscribe to live updates.
  useEffect(() => {
    void window.api.getTelegramStatus().then(setStatus)
    return window.api.onTelegramStatusChanged(setStatus)
  }, [])

  const onConnect = (): void => {
    const tok = tokenInput.trim()
    if (!tok || busy) return
    setBusy(true)
    void window.api
      .connectTelegram({ token: tok })
      .then((s) => {
        setStatus(s)
        if (s.connected) setTokenInput('') // clear on success; keep on error so user can fix
      })
      .finally(() => setBusy(false))
  }

  const onDisconnect = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.disconnectTelegram().then(setStatus).finally(() => setBusy(false))
  }

  const onStartPairing = (): void => {
    if (busy) return
    setBusy(true)
    void window.api
      .startTelegramPairing()
      // The updated status (with the code) arrives via onTelegramStatusChanged.
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const onUnpair = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.unpairTelegram().then(setStatus).finally(() => setBusy(false))
  }

  const onPause = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.pauseTelegram().then(setStatus).finally(() => setBusy(false))
  }

  const onResume = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.resumeTelegram().then(setStatus).finally(() => setBusy(false))
  }

  if (status === null) {
    return (
      <div className="space-y-6">
        <Section title={t('settings.telegramConnection')}>
          <p className="text-sm text-muted-foreground">{t('settings.loadingConfig')}</p>
        </Section>
      </div>
    )
  }

  const connected = status.connected
  // Paused = had a valid connection (botUsername known) but polling stopped.
  const paused = !status.enabled && !status.connected && !!status.botUsername

  return (
    <div className="space-y-6">
      {/* ── Connection ── */}
      <Section title={t('settings.telegramConnection')}>
        <p className="mb-3 text-sm text-muted-foreground">
          {t('settings.telegramConnectionDescription')}
        </p>

        {connected ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">
              {t('settings.telegramStatusConnected', { username: status.botUsername ?? '' })}
            </span>
            <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>
              {t('settings.telegramDisconnectButton')}
            </Button>
          </div>
        ) : paused ? (
          // Paused: the token is still stored, so offer a one-click Resume (no
          // re-entry) with Disconnect as the secondary "forget the token" action.
          <>
            <p className="mb-3 text-sm text-amber-600 dark:text-amber-400">
              {t('settings.telegramStatusPaused')}
            </p>
            {status.lastError && (
              <p className="mb-3 text-sm text-destructive">
                {t('settings.telegramStatusError', { error: status.lastError })}
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={onResume} disabled={busy} size="sm">
                {busy ? t('settings.telegramConnecting') : t('settings.telegramResumeButton')}
              </Button>
              <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>
                {t('settings.telegramDisconnectButton')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {status.lastError && (
              <p className="mb-3 text-sm text-destructive">
                {t('settings.telegramStatusError', { error: status.lastError })}
              </p>
            )}
            <div className="flex gap-2">
              <Input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={t('settings.telegramTokenPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onConnect()
                }}
                disabled={busy}
                className="flex-1"
              />
              <Button onClick={onConnect} disabled={busy || !tokenInput.trim()} size="sm">
                {busy ? t('settings.telegramConnecting') : t('settings.telegramConnectButton')}
              </Button>
            </div>
          </>
        )}

        {status.lastInboundAt !== undefined && connected && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('settings.telegramLastActive', {
              time: new Date(status.lastInboundAt).toLocaleString()
            })}
          </p>
        )}
      </Section>

      {/* ── Link your chat (shown only when connected) ── */}
      {connected && (
        <Section title={t('settings.telegramLinkGroup')}>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('settings.telegramLinkGroupDescription')}
          </p>

          {status.paired ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">
                {t('settings.telegramPaired', { chat: status.boundChatLabel ?? '' })}
              </span>
              <Button variant="outline" size="sm" onClick={onUnpair} disabled={busy}>
                {t('settings.telegramUnpairButton')}
              </Button>
            </div>
          ) : status.pairing ? (
            <div className="space-y-4">
              {/* Pairing code shown prominently so it's easy to copy */}
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-center">
                <p className="mb-1 text-xs text-muted-foreground">
                  {t('settings.telegramPairingCodeLabel')}
                </p>
                <p className="font-mono text-2xl font-bold tracking-widest select-all">
                  {status.pairing.code}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('settings.telegramPairingCodeExpiry', {
                    time: new Date(status.pairing.expiresAt).toLocaleTimeString()
                  })}
                </p>
              </div>
              {/* Step-by-step setup instructions */}
              <div>
                <p className="mb-2 text-sm font-medium">
                  {t('settings.telegramPairingStepsTitle')}
                </p>
                <ol className="space-y-1.5">
                  {(
                    [
                      t('settings.telegramPairingStep1'),
                      t('settings.telegramPairingStep2'),
                      t('settings.telegramPairingStep3', { code: status.pairing.code })
                    ] as string[]
                  ).map((step) => (
                    <li key={step} className="text-sm text-muted-foreground">
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={onStartPairing} disabled={busy}>
              {t('settings.telegramPairButton')}
            </Button>
          )}
        </Section>
      )}

      {/* ── Pause / kill switch (shown only when connected) ── */}
      {connected && (
        <Section title={t('settings.telegramKillSwitch')}>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('settings.telegramKillSwitchDescription')}
          </p>
          <Button variant="outline" size="sm" onClick={onPause} disabled={busy}>
            {t('settings.telegramPauseButton')}
          </Button>
        </Section>
      )}

      {/* ── Telegram workspace info (always shown) ── */}
      <Section title={t('settings.telegramWorkspace')}>
        <p className="text-sm text-muted-foreground">
          {t('settings.telegramWorkspaceDescription')}
        </p>
      </Section>
    </div>
  )
}

/** App identity + collapsed raw config for support. */
function AboutTab(): React.JSX.Element {
  const { t } = useTranslation()
  const [config, setConfig] = useState<RedactedConfigSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [version] = useState(() => window.api.getAppVersion())

  useEffect(() => {
    void window.api.getConfig().then((c) => {
      setConfig(c)
      setLoaded(true)
    })
    return window.api.onConfigChanged((c) => {
      setConfig(c)
      setLoaded(true)
    })
  }, [])

  return (
    <div className="space-y-6">
      <Section title={t('settings.about')}>
        <div className="flex flex-col items-center py-2 text-center">
          <p className="text-base font-semibold tracking-tight">Flairy</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('settings.appTagline')}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {t('settings.version')} {version}
          </p>
        </div>
      </Section>

      <Section title={t('settings.troubleshooting')}>
        <p className="mb-3 text-sm text-muted-foreground">
          {t('settings.troubleshootingDescription')}
        </p>
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground select-none">
            {t('settings.showConfig')}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-xs">
            {!loaded
              ? t('settings.loadingConfig')
              : !config
                ? t('settings.noConfig')
                : JSON.stringify(config, null, 2)}
          </pre>
        </details>
      </Section>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="eyebrow mb-3">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  )
}
