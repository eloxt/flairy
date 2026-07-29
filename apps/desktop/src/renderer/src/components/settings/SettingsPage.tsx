import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconBrandGithub, IconChevronDown, IconChevronRight, IconClock, IconInfoCircle, IconRefresh, IconRobot, IconSend, IconAdjustmentsHorizontal, IconSparkles, IconTool } from '@tabler/icons-react'
import { BrandMark } from '@/components/BrandMark'
import type {
  AcpBackendView,
  AppLanguage,
  ChatWidth,
  GithubStatus,
  LauncherShortcutStatus,
  Memory,
  RedactedConfigSnapshot,
  ScheduledTask,
  TelegramStatus
} from '@shared/ipc'
import { useAuth } from '@/store/auth-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { AdvancedSection } from './advanced/AdvancedSection'
import { CopyButton } from '@/components/chat/MessageActions'

type Tab = 'general' | 'account' | 'memory' | 'schedule' | 'telegram' | 'github' | 'acp' | 'about' | 'advanced'

/**
 * End-user settings, macOS System Settings style: a frosted sidebar on the left
 * (account card on top — the Apple-ID position — then section nav), and a
 * content pane of inset groups on the right. Each setting is a single row:
 * label + plain-language description on the left, the control in place on the
 * right (switch / segmented / popup), instead of form-like sections.
 */
const TABS: Tab[] = ['general', 'account', 'memory', 'schedule', 'telegram', 'github', 'acp', 'about', 'advanced']

/**
 * One-shot deep link: the Settings window can be opened with `?tab=advanced`
 * in its URL (openSettingsWindow's query; used by skip-login) to preselect a tab.
 */
function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get('tab')
  return requested && (TABS as string[]).includes(requested) ? (requested as Tab) : 'general'
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>(initialTab)
  const user = useAuth((s) => s.user)
  // null = not yet known; distinct from false so the fallback effect below
  // doesn't kick a deep-linked 'advanced' tab back to General before the
  // async read lands.
  const [advancedUnlocked, setAdvancedUnlocked] = useState<boolean | null>(null)

  // The Advanced tab is hidden until the user taps the version number 10× (in
  // AboutSection). The flag lives in main; follow it live across windows.
  useEffect(() => {
    void window.api.getAdvancedUnlocked().then(setAdvancedUnlocked)
    return window.api.onAdvancedUnlockedChanged(setAdvancedUnlocked)
  }, [])

  // If the tab is hidden again while it's open, fall back to General.
  useEffect(() => {
    if (advancedUnlocked === false && tab === 'advanced') setTab('general')
  }, [advancedUnlocked, tab])

  const navItems: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] =
    [
      { id: 'general', label: t('settings.navGeneral'), icon: IconAdjustmentsHorizontal },
      { id: 'memory', label: t('settings.tabMemory'), icon: IconSparkles },
      { id: 'schedule', label: t('settings.tabSchedule'), icon: IconClock },
      { id: 'telegram', label: t('settings.tabTelegram'), icon: IconSend },
      { id: 'github', label: t('settings.tabGithub'), icon: IconBrandGithub },
      { id: 'acp', label: t('settings.tabAcp'), icon: IconRobot },
      { id: 'about', label: t('settings.tabAbout'), icon: IconInfoCircle },
      ...(advancedUnlocked
        ? [{ id: 'advanced' as const, label: t('settings.tabAdvanced'), icon: IconTool }]
        : [])
    ]

  const titles: Record<Tab, string> = {
    general: t('settings.navGeneral'),
    account: t('settings.account'),
    memory: t('settings.tabMemory'),
    schedule: t('settings.tabSchedule'),
    telegram: t('settings.tabTelegram'),
    github: t('settings.tabGithub'),
    acp: t('settings.tabAcp'),
    about: t('settings.tabAbout'),
    advanced: t('settings.tabAdvanced')
  }

  const displayName = user?.displayName || t('settings.signedIn')
  const initial = (user?.displayName || user?.email || '?').charAt(0).toUpperCase()

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* ── Frosted sidebar rail ── */}
      <aside className="app-drag flex w-[212px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2.5 pb-3">
        {/* Traffic-light zone (frameless window, hiddenInset) */}
        <div className="h-[52px] shrink-0" />

        {/* Account card — tapping it opens the Account section */}
        <button
          type="button"
          onClick={() => setTab('account')}
          className={cn(
            'app-no-drag mb-3 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
            tab === 'account' ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
          )}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-[15px] font-semibold text-primary-foreground">
            {initial}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] leading-tight font-semibold">
              {displayName}
            </span>
            {user?.email && (
              <span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>
            )}
          </span>
        </button>

        <nav className="flex flex-col gap-px" aria-label={t('settings.title')}>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id}
              className={cn(
                'app-no-drag flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[5px] text-left text-[13px] transition-colors',
                tab === id ? 'bg-sidebar-accent font-medium' : 'hover:bg-sidebar-accent/60'
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] dark:bg-foreground/10">
                <Icon className="size-3.5 opacity-85" />
              </span>
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* ── Content pane (opaque over the vibrancy material) ── */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="app-drag flex h-[52px] shrink-0 items-center border-b border-border/60 px-6">
          <h1 className="text-[15px] font-semibold tracking-tight">{titles[tab]}</h1>
        </header>
        <div className="app-no-drag flex-1 overflow-y-auto px-6 pt-5 pb-7">
          {tab === 'general' && <GeneralSection />}
          {tab === 'account' && <AccountSection />}
          {tab === 'memory' && <MemorySection />}
          {tab === 'schedule' && <ScheduleSection />}
          {tab === 'telegram' && <TelegramSection />}
          {tab === 'github' && <GithubSection />}
          {tab === 'acp' && <AcpSection />}
          {tab === 'about' && <AboutSection />}
          {tab === 'advanced' && <AdvancedSection />}
        </div>
      </main>
    </div>
  )
}

/* ── General: language, chat width, close-to-tray ─────────────────────────── */

function GeneralSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const languages: { lng: AppLanguage; label: string }[] = [
    { lng: 'en', label: 'English' },
    { lng: 'zh-CN', label: '简体中文' }
  ]
  const currentLanguage =
    languages.find((l) => l.lng === i18n.language)?.label ?? languages[0].label

  // Chat width: read once, then follow live changes (e.g. undone from another
  // window). Setting goes through main, which broadcasts back to every window.
  const [chatWidth, setChatWidth] = useState<ChatWidth>('standard')
  useEffect(() => {
    void window.api.getChatWidth().then(setChatWidth)
    return window.api.onChatWidthChanged(setChatWidth)
  }, [])
  const onSelectChatWidth = (w: ChatWidth): void => {
    setChatWidth(w)
    void window.api.setChatWidth(w)
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

  // Quick-launcher summon chord: a small preset menu (values are Electron
  // accelerator strings). Main persists + re-registers on the spot and reports
  // whether the chord actually registered — `registered: false` means another
  // app owns it, surfaced as a plain-language hint under the row.
  const isMac = window.api.platform === 'darwin'
  const [launcherShortcut, setLauncherShortcut] = useState<LauncherShortcutStatus | null>(null)
  useEffect(() => {
    void window.api.getLauncherShortcut().then(setLauncherShortcut)
  }, [])
  const onSelectLauncherShortcut = (accelerator: string): void => {
    void window.api.setLauncherShortcut(accelerator).then(setLauncherShortcut)
  }
  const shortcutOptions: { value: string; label: string }[] = [
    { value: 'Control+Space', label: isMac ? '⌃ Space' : 'Ctrl+Space' },
    { value: 'Control+Shift+Space', label: isMac ? '⌃⇧ Space' : 'Ctrl+Shift+Space' },
    { value: 'Alt+Space', label: isMac ? '⌥ Space' : 'Alt+Space' },
    { value: 'CommandOrControl+Shift+L', label: isMac ? '⌘⇧ L' : 'Ctrl+Shift+L' },
    { value: '', label: t('settings.launcherShortcutOff') }
  ]
  const currentShortcutLabel = launcherShortcut
    ? (shortcutOptions.find((o) => o.value === launcherShortcut.accelerator)?.label ??
      launcherShortcut.accelerator)
    : ''
  const shortcutTaken =
    !!launcherShortcut && !!launcherShortcut.accelerator && !launcherShortcut.registered

  return (
    <>
      <GroupLabel>{t('settings.sectionDisplay')}</GroupLabel>
      <Group>
        <Row label={t('settings.language')}>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex shrink-0 items-center gap-1.5 rounded-[6.5px] bg-background px-2.5 py-1 text-xs shadow-[inset_0_0_0_0.5px_var(--input),0_1px_1.5px_rgb(0_0_0/0.07)] transition-colors hover:bg-muted">
              {currentLanguage}
              <IconChevronDown className="size-3 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {languages.map(({ lng, label }) => (
                <DropdownMenuItem key={lng} onClick={() => void window.api.setLanguage(lng)}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
        <Row label={t('settings.chatWidth')} description={t('settings.chatWidthDescription')}>
          <Segmented
            ariaLabel={t('settings.chatWidth')}
            value={chatWidth}
            onChange={onSelectChatWidth}
            options={[
              { value: 'standard', label: t('settings.chatWidthStandard') },
              { value: 'wide', label: t('settings.chatWidthWide') },
              { value: 'full', label: t('settings.chatWidthFull') }
            ]}
          />
        </Row>
      </Group>

      <GroupLabel>{t('settings.sectionWindow')}</GroupLabel>
      <Group>
        <Row
          label={t('settings.closeToTrayLabel')}
          description={t('settings.closeToTrayDescription')}
        >
          <Switch
            checked={closeToTray}
            onCheckedChange={onToggleCloseToTray}
            aria-label={t('settings.closeToTrayLabel')}
          />
        </Row>
        <Row
          label={t('settings.launcherShortcutLabel')}
          description={
            <>
              {t(
                isMac
                  ? 'settings.launcherShortcutDescriptionMac'
                  : 'settings.launcherShortcutDescription'
              )}
              {shortcutTaken && (
                <span className="mt-0.5 block text-amber-600 dark:text-amber-500">
                  {t('settings.launcherShortcutTaken')}
                </span>
              )}
            </>
          }
        >
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex shrink-0 items-center gap-1.5 rounded-[6.5px] bg-background px-2.5 py-1 text-xs shadow-[inset_0_0_0_0.5px_var(--input),0_1px_1.5px_rgb(0_0_0/0.07)] transition-colors hover:bg-muted">
              {currentShortcutLabel}
              <IconChevronDown className="size-3 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {shortcutOptions.map(({ value, label }) => (
                <DropdownMenuItem key={value} onClick={() => onSelectLauncherShortcut(value)}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
      </Group>
    </>
  )
}

/* ── Account: identity + sign out ─────────────────────────────────────────── */

function AccountSection(): React.JSX.Element {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)

  const displayName = user?.displayName || t('settings.signedIn')
  const initial = (user?.displayName || user?.email || '?').charAt(0).toUpperCase()

  return (
    <>
      <Group>
        <div className="flex items-center gap-3.5 px-3.5 py-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">
            {initial}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{displayName}</div>
            {user?.email && (
              <div className="truncate text-[11.5px] text-muted-foreground">{user.email}</div>
            )}
          </div>
        </div>
        <Row label={t('settings.name')}>
          <RowValue>{displayName}</RowValue>
        </Row>
        {user?.email && (
          <Row label={t('settings.email')}>
            <RowValue>{user.email}</RowValue>
          </Row>
        )}
      </Group>

      {/* Logging out broadcasts across windows: the main window re-gates and
          this Settings window closes itself (see SettingsWindow). */}
      <Group className="mt-3.5">
        <RowButton onClick={() => void logout()}>{t('settings.signOut')}</RowButton>
      </Group>
      <Caption>{t('settings.signOutHint')}</Caption>
    </>
  )
}

/* ── Memory: review / forget what the assistant remembers ─────────────────── */

function MemorySection(): React.JSX.Element {
  const { t } = useTranslation()
  const [memories, setMemories] = useState<Memory[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  // Live-refreshes via onMemoriesChanged so a memory the assistant just wrote
  // (or one synced from another device) appears at once.
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
    <>
      <Lede>{t('settings.memoryDescription')}</Lede>
      <Group>
        {!loaded ? (
          <EmptyRow>{t('settings.loadingConfig')}</EmptyRow>
        ) : memories.length === 0 ? (
          <EmptyRow>{t('settings.memoryEmpty')}</EmptyRow>
        ) : (
          memories.map((m) => (
            <div key={m.id} className="group/mem flex min-h-[46px] items-center gap-4 px-3.5 py-2">
              <span className="flex-1 text-[13px] leading-snug break-words">{m.text}</span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => onForget(m.id)}
                className="opacity-0 transition-opacity group-hover/mem:opacity-100 focus-visible:opacity-100"
              >
                {t('settings.memoryForget')}
              </Button>
            </div>
          ))
        )}
      </Group>

      {memories.length > 0 && (
        <Group className="mt-3.5">
          {confirmingClear ? (
            <div className="flex items-center gap-2 px-3.5 py-2.5">
              <Button variant="destructive" size="sm" onClick={onClearAll}>
                {t('settings.memoryClearConfirm')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmingClear(false)}>
                {t('settings.cancel')}
              </Button>
            </div>
          ) : (
            <RowButton danger onClick={() => setConfirmingClear(true)}>
              {t('settings.memoryClearAll')}
            </RowButton>
          )}
        </Group>
      )}
    </>
  )
}

/* ── Scheduled tasks: list, pause/resume, delete ───────────────────────────── */

function ScheduleSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  // Live-refreshes via onScheduleChanged so a task the assistant just created
  // (or one that just ran) appears/updates at once.
  useEffect(() => {
    void window.api.listScheduledTasks().then((ts) => {
      setTasks(ts)
      setLoaded(true)
    })
    return window.api.onScheduleChanged(() => {
      void window.api.listScheduledTasks().then(setTasks)
    })
  }, [])

  const fmt = (ts?: number): string =>
    ts ? new Date(ts).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : ''

  const onToggle = (task: ScheduledTask): void => {
    void window.api
      .updateScheduledTask({ id: task.id, status: task.status === 'paused' ? 'active' : 'paused' })
      .then(setTasks)
  }

  const onDelete = (id: string): void => {
    void window.api.deleteScheduledTask(id).then((ts) => {
      setTasks(ts)
      setConfirmingId(null)
    })
  }

  return (
    <>
      <Lede>{t('settings.scheduleDescription')}</Lede>
      <Group>
        {!loaded ? (
          <EmptyRow>{t('settings.loadingConfig')}</EmptyRow>
        ) : tasks.length === 0 ? (
          <EmptyRow>{t('settings.scheduleEmpty')}</EmptyRow>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              className="group/task flex min-h-[52px] items-center gap-4 px-3.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] leading-snug font-medium">{task.title}</span>
                  {task.status !== 'active' && (
                    <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                      {t(`toolDetail.scheduleStatus.${task.status}`)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {task.scheduleText}
                  {task.status === 'active' && task.nextRunAt
                    ? ` · ${t('settings.scheduleNextRun')} ${fmt(task.nextRunAt)}`
                    : task.lastRunAt
                      ? ` · ${t('settings.scheduleLastRun')} ${fmt(task.lastRunAt)}`
                      : ''}
                </div>
              </div>
              {confirmingId === task.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="destructive" size="xs" onClick={() => onDelete(task.id)}>
                    {t('settings.scheduleDeleteConfirm')}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => setConfirmingId(null)}>
                    {t('settings.cancel')}
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover/task:opacity-100 focus-within:opacity-100">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void window.api.revealScheduleSession(task.sessionId)}
                  >
                    {t('settings.scheduleOpenChat')}
                  </Button>
                  {(task.status === 'active' || task.status === 'paused') && (
                    <Button variant="outline" size="xs" onClick={() => onToggle(task)}>
                      {task.status === 'paused'
                        ? t('settings.scheduleResume')
                        : t('settings.schedulePause')}
                    </Button>
                  )}
                  <Button variant="outline" size="xs" onClick={() => setConfirmingId(task.id)}>
                    {t('settings.scheduleDelete')}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </Group>
      <Caption>{t('settings.scheduleHint')}</Caption>
    </>
  )
}

/* ── Telegram: connection, pairing, receive toggle ─────────────────────────── */

/**
 * The old standalone "Pause" section is folded into the Connection group as a
 * single switch ("Receive Telegram messages"): off → pause, on → resume. The
 * token stays write-only: the form sends it to main but never gets it back.
 */
function TelegramSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [busy, setBusy] = useState(false)

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

  const onToggleReceive = (receive: boolean): void => {
    if (busy) return
    setBusy(true)
    const call = receive ? window.api.resumeTelegram() : window.api.pauseTelegram()
    void call.then(setStatus).finally(() => setBusy(false))
  }

  if (status === null) {
    return (
      <>
        <GroupLabel>{t('settings.telegramConnection')}</GroupLabel>
        <Group>
          <EmptyRow>{t('settings.loadingConfig')}</EmptyRow>
        </Group>
      </>
    )
  }

  const connected = status.connected
  // Paused = had a valid connection (botUsername known) but polling stopped.
  const paused = !status.enabled && !connected && !!status.botUsername
  // A token is stored → the receive switch is meaningful.
  const hasToken = connected || paused

  return (
    <>
      <GroupLabel>{t('settings.telegramConnection')}</GroupLabel>
      <Group>
        <Row
          label={
            <span className="flex items-center gap-2">
              <StatusDot ok={connected} />
              {connected
                ? t('settings.telegramStatusConnected', { username: status.botUsername ?? '' })
                : paused
                  ? t('settings.telegramStatusPaused')
                  : t('settings.telegramStatusNotConnected')}
            </span>
          }
          description={
            status.lastError && !connected ? (
              <span className="text-destructive">
                {t('settings.telegramStatusError', { error: status.lastError })}
              </span>
            ) : connected && status.lastInboundAt !== undefined ? (
              t('settings.telegramLastActive', {
                time: new Date(status.lastInboundAt).toLocaleString()
              })
            ) : !hasToken ? (
              t('settings.telegramConnectionDescription')
            ) : undefined
          }
        >
          {hasToken && (
            <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>
              {t('settings.telegramDisconnectButton')}
            </Button>
          )}
        </Row>

        {!hasToken && (
          <div className="flex items-center gap-2 px-3.5 py-2.5">
            <Input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('settings.telegramTokenPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConnect()
              }}
              disabled={busy}
              className="h-7 flex-1 text-[13px]"
            />
            <Button size="sm" onClick={onConnect} disabled={busy || !tokenInput.trim()}>
              {busy ? t('settings.telegramConnecting') : t('settings.telegramConnectButton')}
            </Button>
          </div>
        )}

        {hasToken && (
          <Row
            label={t('settings.telegramReceiveLabel')}
            description={t('settings.telegramKillSwitchDescription')}
          >
            <Switch
              checked={connected}
              onCheckedChange={onToggleReceive}
              disabled={busy}
              aria-label={t('settings.telegramReceiveLabel')}
            />
          </Row>
        )}
      </Group>

      {connected && (
        <>
          <GroupLabel>{t('settings.telegramLinkGroup')}</GroupLabel>
          <Group>
            {status.paired ? (
              <Row label={t('settings.telegramPaired', { chat: status.boundChatLabel ?? '' })}>
                <Button variant="outline" size="sm" onClick={onUnpair} disabled={busy}>
                  {t('settings.telegramUnpairButton')}
                </Button>
              </Row>
            ) : status.pairing ? (
              <>
                {/* Pairing code shown prominently so it's easy to copy */}
                <div className="px-3.5 pt-4 pb-3.5 text-center">
                  <p className="text-[11px] text-muted-foreground">
                    {t('settings.telegramPairingCodeLabel')} ·{' '}
                    {t('settings.telegramPairingCodeExpiry', {
                      time: new Date(status.pairing.expiresAt).toLocaleTimeString()
                    })}
                  </p>
                  <p className="mt-1 font-mono text-[26px] font-bold tracking-[0.28em] select-all">
                    {status.pairing.code}
                  </p>
                </div>
                <div className="space-y-1 px-3.5 py-2.5">
                  <p className="text-xs font-medium">{t('settings.telegramPairingStepsTitle')}</p>
                  {(
                    [
                      t('settings.telegramPairingStep1'),
                      t('settings.telegramPairingStep2'),
                      t('settings.telegramPairingStep3', { code: status.pairing.code })
                    ] as string[]
                  ).map((step) => (
                    <p key={step} className="text-xs leading-relaxed text-muted-foreground">
                      {step}
                    </p>
                  ))}
                </div>
              </>
            ) : (
              <Row
                label={t('settings.telegramNotPaired')}
                description={t('settings.telegramLinkGroupDescription')}
              >
                <Button variant="outline" size="sm" onClick={onStartPairing} disabled={busy}>
                  {t('settings.telegramPairButton')}
                </Button>
              </Row>
            )}
          </Group>
        </>
      )}

      <Caption>{t('settings.telegramWorkspaceDescription')}</Caption>
    </>
  )
}

/* ── GitHub: OAuth Device Flow connection ─────────────────────────────────── */

/**
 * Device Flow sign-in: main returns a user code, the user approves it on
 * github.com, and the grant lands via onGithubStatusChanged. The OAuth token
 * never crosses IPC — the renderer only ever sees GithubStatus. The OAuth App
 * client ID ships with the app; there is nothing to configure here.
 */
function GithubSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getGithubStatus().then(setStatus)
    return window.api.onGithubStatusChanged(setStatus)
  }, [])

  const onConnect = (): void => {
    if (busy) return
    setBusy(true)
    // The device code (and later the grant) arrive via onGithubStatusChanged.
    void window.api
      .startGithubAuth()
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }

  const onCancel = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.cancelGithubAuth().then(setStatus).finally(() => setBusy(false))
  }

  const onDisconnect = (): void => {
    if (busy) return
    setBusy(true)
    void window.api.disconnectGithub().then(setStatus).finally(() => setBusy(false))
  }

  if (status === null) {
    return (
      <>
        <GroupLabel>{t('settings.githubConnection')}</GroupLabel>
        <Group>
          <EmptyRow>{t('settings.loadingConfig')}</EmptyRow>
        </Group>
      </>
    )
  }

  const { connected, pending } = status

  return (
    <>
      <GroupLabel>{t('settings.githubConnection')}</GroupLabel>
      <Group>
        <Row
          label={
            <span className="flex items-center gap-2">
              <StatusDot ok={connected} />
              {connected
                ? status.login
                  ? t('settings.githubStatusConnected', { login: status.login })
                  : t('settings.githubStatusConnectedNoLogin')
                : t('settings.githubStatusNotConnected')}
            </span>
          }
          description={
            status.lastError && !connected ? (
              <span className="text-destructive">
                {t('settings.githubStatusError', { error: status.lastError })}
              </span>
            ) : !connected && !pending ? (
              t('settings.githubConnectionDescription')
            ) : undefined
          }
        >
          {connected ? (
            <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>
              {t('settings.githubDisconnectButton')}
            </Button>
          ) : pending ? (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
              {t('settings.githubCancelButton')}
            </Button>
          ) : (
            <Button size="sm" onClick={onConnect} disabled={busy}>
              {busy ? t('settings.githubConnecting') : t('settings.githubConnectButton')}
            </Button>
          )}
        </Row>

        {pending && (
          <>
            {/* Device code shown prominently so it's easy to type/copy */}
            <div className="px-3.5 pt-4 pb-3.5 text-center">
              <p className="text-[11px] text-muted-foreground">{t('settings.githubCodeLabel')}</p>
              <p className="mt-1 font-mono text-[26px] font-bold tracking-[0.28em] select-all">
                {pending.userCode}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('settings.githubCodeHint')}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void window.api.openExternal(pending.verificationUri)}
              >
                {t('settings.githubOpenButton')}
              </Button>
            </div>
          </>
        )}
      </Group>
    </>
  )
}

/* ── ACP: coding-agent worker backends (enable + probed options + command) ── */

/**
 * Which external coding agents Flairy may dispatch project work to (over the
 * Agent Client Protocol) and how each is configured. The configurable options
 * (model, effort, …) are not hardcoded: each agent reports them over ACP
 * (`configOptions` on session/new), so we probe the agent once and render
 * whatever it offers. The permission-mode option is deliberately NOT exposed —
 * Flairy's own worktree policy owns permissions, and e.g. "bypass permissions"
 * would defeat that fence.
 */
function AcpSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [backends, setBackends] = useState<AcpBackendView[] | null>(null)

  useEffect(() => {
    void window.api.listAcpBackends().then(setBackends)
  }, [])

  if (backends === null) {
    return (
      <>
        <GroupLabel>{t('settings.acpAgents')}</GroupLabel>
        <Group>
          <EmptyRow>{t('settings.loadingConfig')}</EmptyRow>
        </Group>
      </>
    )
  }

  return (
    <>
      <GroupLabel>{t('settings.acpAgents')}</GroupLabel>
      <div className="space-y-3">
        {backends.map((b) => (
          <AcpBackendCard key={b.id} backend={b} onChanged={setBackends} />
        ))}
      </div>
      <Caption>{t('settings.acpCaption')}</Caption>
    </>
  )
}

function AcpBackendCard({
  backend,
  onChanged
}: {
  backend: AcpBackendView
  onChanged: (next: AcpBackendView[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [model, setModel] = useState(backend.model ?? '')
  const [command, setCommand] = useState(backend.command ?? '')
  const [busy, setBusy] = useState(false)
  const [probing, setProbing] = useState(false)

  // Re-sync local drafts when main sends back a refreshed list.
  useEffect(() => {
    setModel(backend.model ?? '')
    setCommand(backend.command ?? '')
  }, [backend.model, backend.command])

  const probe = (): void => {
    if (probing) return
    setProbing(true)
    void window.api
      .probeAcpBackend(backend.id)
      .then(onChanged)
      .finally(() => setProbing(false))
  }

  // First enable: discover the agent's options automatically.
  useEffect(() => {
    if (backend.enabled && backend.probedAt === undefined) probe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend.enabled, backend.probedAt])

  const update = (patch: {
    enabled?: boolean
    model?: string | null
    command?: string | null
    values?: Record<string, string | boolean | null>
  }): void => {
    if (busy) return
    setBusy(true)
    void window.api
      .updateAcpBackend({ id: backend.id, ...patch })
      .then(onChanged)
      .finally(() => setBusy(false))
  }

  // Flairy's worktree policy owns the permission mode; never surface it.
  const options = (backend.options ?? []).filter((o) => o.category !== 'mode')
  const probeFailed = !probing && backend.probeError !== undefined && backend.options === undefined
  // Missing agent CLI → grayed out; the switch stays usable only to turn an
  // already-enabled backend OFF. The command row below remains the escape
  // hatch: pointing it at a custom binary counts as installed.
  const missing = !backend.installed

  return (
    <Group className={missing ? 'opacity-60' : undefined}>
      <Row
        label={backend.label}
        description={
          missing ? (
            <span className="text-destructive/80">
              {t('settings.acpNotInstalled', { bin: backend.detectBin })}
            </span>
          ) : (
            t(`settings.acpDesc.${backend.id}`)
          )
        }
      >
        <Switch
          checked={backend.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          disabled={busy || (missing && !backend.enabled)}
          aria-label={backend.label}
        />
      </Row>

      {missing && !backend.enabled && (
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <span className="w-16 shrink-0 text-xs text-muted-foreground">
            {t('settings.acpCommandLabel')}
          </span>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={backend.defaultCommand}
            onBlur={() => {
              if (command.trim() !== (backend.command ?? ''))
                update({ command: command.trim() || null })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            disabled={busy}
            className="h-7 flex-1 font-mono text-[12px]"
          />
        </div>
      )}

      {backend.enabled && probing && <EmptyRow>{t('settings.acpProbing')}</EmptyRow>}

      {backend.enabled && !probing && (
        <>
          {options.map((o) => (
            <Row key={o.id} label={o.name} description={o.description}>
              {o.type === 'boolean' ? (
                <Switch
                  checked={Boolean(backend.values[o.id] ?? o.defaultValue)}
                  onCheckedChange={(v) => update({ values: { [o.id]: v } })}
                  disabled={busy}
                  aria-label={o.name}
                />
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger className="inline-flex w-52 shrink-0 items-center justify-between gap-1.5 rounded-[6.5px] bg-background px-2.5 py-1 text-xs shadow-[inset_0_0_0_0.5px_var(--input),0_1px_1.5px_rgb(0_0_0/0.07)] transition-colors hover:bg-muted">
                    <span className="truncate">
                      {backend.values[o.id] !== undefined
                        ? (o.choices?.find((c) => c.value === backend.values[o.id])?.name ??
                          String(backend.values[o.id]))
                        : t('settings.acpDefaultOption')}
                    </span>
                    <IconChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    <DropdownMenuItem onClick={() => update({ values: { [o.id]: null } })}>
                      {t('settings.acpDefaultOption')}
                    </DropdownMenuItem>
                    {(o.choices ?? []).map((c) => (
                      <DropdownMenuItem
                        key={c.value}
                        onClick={() => update({ values: { [o.id]: c.value } })}
                      >
                        <span className="flex flex-col">
                          <span>{c.name}</span>
                          {c.description && (
                            <span className="text-[11px] text-muted-foreground">
                              {c.description}
                            </span>
                          )}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </Row>
          ))}

          {probeFailed && (
            <>
              <Row
                label={
                  <span className="text-destructive">
                    {t('settings.acpProbeFailed')}
                  </span>
                }
                description={backend.probeError}
              >
                <Button variant="outline" size="sm" onClick={probe} disabled={probing}>
                  {t('settings.acpProbeRetry')}
                </Button>
              </Row>
              {/* No option list to pick from → free-text model fallback. */}
              <div className="flex items-center gap-2 px-3.5 py-2.5">
                <span className="w-16 shrink-0 text-xs text-muted-foreground">
                  {t('settings.acpModelLabel')}
                </span>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t('settings.acpModelPlaceholder', {
                    model: backend.modelPlaceholder
                  })}
                  onBlur={() => {
                    if (model.trim() !== (backend.model ?? ''))
                      update({ model: model.trim() || null })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  disabled={busy}
                  className="h-7 flex-1 text-[13px]"
                />
              </div>
            </>
          )}

          <div className="flex items-center gap-2 px-3.5 py-2.5">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">
              {t('settings.acpCommandLabel')}
            </span>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={backend.defaultCommand}
              onBlur={() => {
                if (command.trim() !== (backend.command ?? ''))
                  update({ command: command.trim() || null })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              disabled={busy}
              className="h-7 flex-1 font-mono text-[12px]"
            />
            {backend.probedAt !== undefined && !probeFailed && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                title={t('settings.acpRefresh')}
                onClick={probe}
                disabled={probing}
              >
                <IconRefresh className="size-3.5" />
              </Button>
            )}
          </div>
        </>
      )}
    </Group>
  )
}

/* ── About: identity + collapsed raw config for support ───────────────────── */

function AboutSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [config, setConfig] = useState<RedactedConfigSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [version] = useState(() => window.api.getAppVersion())
  // Hidden gate: 10 taps on the version reveals the Advanced tab (Android-style).
  const [, setTaps] = useState(0)
  const [justUnlocked, setJustUnlocked] = useState(false)

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

  const onVersionTap = (): void => {
    setTaps((n) => {
      const next = n + 1
      if (next >= 10) {
        void window.api.getAdvancedUnlocked().then((already) => {
          if (!already) {
            void window.api.setAdvancedUnlocked(true)
            setJustUnlocked(true)
          }
        })
        return 0
      }
      return next
    })
  }

  return (
    <>
      <div className="pt-4 pb-6 text-center">
        {/* Mini of the app icon: white squircle tile + the same mark
            scripts/generate-icons.mjs rasterizes from build/icon.svg. */}
        <div className="mx-auto mb-3 grid size-16 place-items-center rounded-[15px] border border-black/10 bg-white shadow-lg">
          <BrandMark className="size-10 text-black" />
        </div>
        <h2 className="text-[17px] font-semibold tracking-tight">Flairy</h2>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('settings.appTagline')}</p>
      </div>

      <Group>
        <Row label={t('settings.version')}>
          <RowValue>
            <span
              onClick={onVersionTap}
              className="cursor-default select-none"
              title={justUnlocked ? t('settings.advancedUnlockedToast') : undefined}
            >
              {version}
            </span>
          </RowValue>
        </Row>
        {justUnlocked && (
          <Row label={t('settings.advancedUnlockedToast')}>
            <RowValue>
              <IconTool className="size-3.5 text-muted-foreground" />
            </RowValue>
          </Row>
        )}
        <details className="group/cfg">
          <summary className="flex min-h-[46px] cursor-pointer list-none items-center gap-4 px-3.5 py-2 select-none [&::-webkit-details-marker]:hidden">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-tight">{t('settings.showConfig')}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                {t('settings.troubleshootingDescription')}
              </div>
            </div>
            <IconChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/cfg:rotate-90" />
          </summary>
          <div className="relative border-t border-border/60">
            <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[10.5px] leading-relaxed text-muted-foreground select-text">
              {!loaded
                ? t('settings.loadingConfig')
                : !config
                  ? t('settings.noConfig')
                  : JSON.stringify(config, null, 2)}
            </pre>
            {loaded && config && (
              <div className="absolute top-1.5 right-1.5">
                <CopyButton text={JSON.stringify(config, null, 2)} />
              </div>
            )}
          </div>
        </details>
      </Group>
    </>
  )
}

/* ── Native-settings primitives ────────────────────────────────────────────── */

/** Inset list box: rounded hairline card, rows separated by hairlines. */
function Group({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // Hairline edge + faint lift in one box-shadow (the `.hairline` utility
        // and a Tailwind shadow-* would overwrite each other).
        'divide-y divide-border/60 overflow-hidden rounded-[10px] bg-card shadow-[inset_0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Tiny uppercase label above a group. */
function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="eyebrow mx-0.5 mt-6 mb-2 first:mt-0">{children}</div>
}

/** One setting: label + optional description left, the control in place right. */
function Row({
  label,
  description,
  children
}: {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-[46px] items-center gap-4 px-3.5 py-2">
      <div className="min-w-0 flex-1 py-0.5">
        <div className="text-[13px] leading-tight">{label}</div>
        {description && (
          <div className="mt-0.5 max-w-[46ch] text-[11.5px] leading-snug text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/** Right-aligned read-only value in a Row. */
function RowValue({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[13px] break-all text-muted-foreground">{children}</span>
}

/** Full-width tappable row (sign out, clear all). */
function RowButton({
  danger,
  onClick,
  children
}: {
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full items-center px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-accent',
        danger && 'text-destructive'
      )}
    >
      {children}
    </button>
  )
}

/** Centered muted placeholder inside a Group (loading / empty states). */
function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3.5 py-6 text-center text-[12.5px] text-muted-foreground">{children}</div>
  )
}

/** Introductory paragraph above a group. */
function Lede({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-3 max-w-[52ch] text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** Footnote below a group. */
function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mx-0.5 mt-2 max-w-[56ch] text-[11.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** Connection state dot: green = live, gray = off/paused. */
function StatusDot({ ok }: { ok: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        ok ? 'bg-emerald-500 ring-[3px] ring-emerald-500/20' : 'bg-muted-foreground/50'
      )}
    />
  )
}

/** macOS-style segmented control (muted track, raised thumb). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 gap-px rounded-[7px] bg-muted p-0.5"
    >
      {options.map(({ value: v, label }) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-[5.5px] px-3 py-1 text-xs transition-colors',
            v === value
              ? 'bg-background font-medium text-foreground shadow-sm dark:bg-[oklch(0.32_0_0)]'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
