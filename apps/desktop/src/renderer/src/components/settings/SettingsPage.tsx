import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ActiveLlm,
  McpServerConfig,
  McpTransport,
  RoleModels,
  SkillSummary
} from '@flairy/shared'
import type { AppLanguage, RedactedConfigSnapshot } from '@shared/ipc'
import { useAuth } from '@/store/auth-store'
import { Button } from '@/components/ui/button'

/**
 * Debug-only settings view. Offers NO configuration controls yet — it just
 * renders the configuration the server pushed to this client (with secrets
 * masked in the main process) so we can verify delivery end-to-end.
 */
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [config, setConfig] = useState<RedactedConfigSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)

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
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <header className="mb-6">
          <p className="eyebrow">{t('settings.debug')}</p>
          <h1 className="text-lg font-semibold tracking-tight">{t('settings.serverConfiguration')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings.serverConfigurationDescription')}
          </p>
        </header>

        <div className="space-y-6">
          <AccountSection />
          <LanguageSection />

          {!loaded ? (
            <Empty>{t('settings.loading')}</Empty>
          ) : !config ? (
            <Empty>{t('settings.noConfig')}</Empty>
          ) : (
            <>
              <Section title={t('settings.overview')}>
                <Row label={t('settings.configVersion')} value={`#${config.version}`} />
                <Row label={t('settings.mcpServers')} value={String(config.mcpServers.length)} />
                <Row label={t('settings.skills')} value={String(config.skills.length)} />
              </Section>

              <LlmSection llm={config.llm} />
              <McpSection servers={config.mcpServers} />
              <SkillsSection skills={config.skills} />
              <RawSection config={config} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Signed-in identity + sign out. Logging out drops the session and shows the gate. */
function AccountSection(): React.JSX.Element {
  const { t } = useTranslation()
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)

  // Logging out broadcasts across windows: the main window re-gates and this
  // Settings window closes itself (see SettingsWindow).
  const onSignOut = (): void => void logout()

  return (
    <Section title={t('settings.account')}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{user?.displayName ?? t('settings.signedIn')}</p>
          {user?.email && (
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onSignOut}>
          {t('settings.signOut')}
        </Button>
      </div>
    </Section>
  )
}

/** Language switcher — two-button segmented toggle for English and 简体中文. */
function LanguageSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  const options: { lng: AppLanguage; label: string }[] = [
    { lng: 'en', label: 'English' },
    { lng: 'zh-CN', label: '简体中文' }
  ]

  const current = i18n.language

  const onSelect = (lng: AppLanguage): void => {
    void window.api.setLanguage(lng)
  }

  return (
    <Section title={t('settings.language')}>
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
  )
}

function LlmSection({ llm }: { llm: RoleModels }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section title={t('settings.languageModels')}>
      <LlmRole label={t('settings.mainModel')} llm={llm.main} />
      <div className="mt-4 border-t border-border/60 pt-4">
        <LlmRole label={t('settings.toolModel')} llm={llm.tool} />
      </div>
    </Section>
  )
}

function LlmRole({ label, llm }: { label: string; llm: ActiveLlm | null }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <Row label={label} value={llm ? `${llm.model.name} (${llm.model.model})` : t('settings.notSet')} />
      {llm && (
        <>
          <Row label={t('settings.provider')} value={llm.provider.name} />
          <Row label={t('settings.vendor')} value={llm.provider.provider} />
          {llm.provider.baseUrl && <Row label={t('settings.baseUrl')} value={llm.provider.baseUrl} />}
          <Row label={t('settings.credential')} value={<code className="text-xs">{llm.provider.credential}</code>} />
        </>
      )}
    </>
  )
}

function McpSection({ servers }: { servers: McpServerConfig[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section title={t('settings.mcpServers')}>
      {servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.none')}</p>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => (
            <div key={s.id} className="rounded-lg border border-border/70 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{s.name}</span>
                <StatusDot on={s.enabled} label={s.enabled ? t('settings.enabled') : t('settings.disabled')} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{describeTransport(s.transport)}</p>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function SkillsSection({ skills }: { skills: SkillSummary[] }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section title={t('settings.skills')}>
      {skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.none')}</p>
      ) : (
        <div className="space-y-3">
          {skills.map((s) => (
            <div key={s.id} className="rounded-lg border border-border/70 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{s.name}</span>
                <StatusDot on={s.enabled} label={s.enabled ? t('settings.enabled') : t('settings.disabled')} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              <p className="mt-1 text-[0.6875rem] text-muted-foreground/70">
                {t('settings.fileCount', { count: s.fileCount })}
              </p>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function RawSection({ config }: { config: RedactedConfigSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Section title={t('settings.rawPayload')}>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">{t('settings.showJson')}</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-xs">
          {JSON.stringify(config, null, 2)}
        </pre>
      </details>
    </Section>
  )
}

/** Human-readable one-liner for an MCP transport (secret values already masked). */
function describeTransport(t: McpTransport): string {
  switch (t.kind) {
    case 'stdio':
      return `stdio · ${[t.command, ...(t.args ?? [])].join(' ')}`
    case 'sse':
      return `sse · ${t.url}`
    case 'http':
      return `http · ${t.url}`
  }
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

function StatusDot({ on, label }: { on: boolean; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`size-1.5 rounded-full ${on ? 'bg-foreground' : 'bg-muted-foreground/40'}`} />
      {label}
    </span>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
