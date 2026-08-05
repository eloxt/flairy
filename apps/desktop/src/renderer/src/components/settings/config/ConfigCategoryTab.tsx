import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconChevronDown } from '@tabler/icons-react'
import type { ConfigMode, ConfigSourceMode, ConfigSources, LocalConfigDraft } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Group, GroupLabel, Lede, Row } from '../rows'
import { LlmEditor } from './LlmEditor'
import { McpEditor } from './McpEditor'
import { ServicesEditor } from './ServicesEditor'
import { PromptsEditor } from './PromptsEditor'
import { SkillsEditor } from './SkillsEditor'

/** One user-configurable category = one Settings tab. */
export type ConfigCategory = 'llm' | 'mcpServers' | 'services' | 'systemPrompts' | 'skills'

const EMPTY_DRAFT: LocalConfigDraft = {
  llm: { main: null, tool: null, visual: null },
  mcpServers: [],
  systemPrompts: [],
  services: [],
  skills: []
}

/** i18n suffix per category (settings.config.lede<Suffix> / tab<Suffix>). */
const KEY: Record<ConfigCategory, string> = {
  llm: 'Models',
  mcpServers: 'Tools',
  services: 'WebSearch',
  systemPrompts: 'Prompts',
  skills: 'Skills'
}

const SOURCE_OPTIONS: ConfigSourceMode[] = ['server', 'local', 'merge']

/**
 * A Settings tab for one configuration category (models / tools / web search /
 * prompts / skills): a source dropdown choosing between the server-pushed
 * config, the user's own entries, or both merged (applies instantly, no save
 * needed), the editor for the user's OWN entries, and a save bar with an
 * on-demand "copy from server" seed.
 *
 * The whole draft is loaded on mount and saved whole — the tab remounts on
 * every tab switch, so each tab always starts from the persisted state. Under
 * `merge`, local entries go in front of the server's (a same-id/name server
 * item is overridden); under `local` the category runs on the local entries
 * only; under `server` the local entries are kept but ignored.
 */
export function ConfigCategoryTab({ category }: { category: ConfigCategory }): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<LocalConfigDraft>(EMPTY_DRAFT)
  const [sources, setSources] = useState<ConfigSources | null>(null)
  const [mode, setMode] = useState<ConfigMode>('server')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [seedNotice, setSeedNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getLocalConfig().then((d) => {
      if (d) setDraft(d)
    })
    void window.api.getConfigSources().then(setSources)
    void window.api.getConfigMode().then(setMode)
    const offSources = window.api.onConfigSourcesChanged(setSources)
    const offMode = window.api.onConfigModeChanged(setMode)
    return () => {
      offSources()
      offMode()
    }
  }, [])

  const source: ConfigSourceMode = sources?.[category] ?? 'server'

  const selectSource = (choice: ConfigSourceMode): void => {
    if (!sources) return
    const next = { ...sources, [category]: choice }
    setSources(next)
    void window.api.setConfigSources(next)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.saveLocalConfig(draft)
      // Re-read so secrets show masked again (main merged them in).
      const fresh = await window.api.getLocalConfig()
      if (fresh) setDraft(fresh)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  // Copy the server's entries for THIS category into the local draft (masked
  // secrets stay resolvable on save). Replaces the category's local entries;
  // nothing persists until the user reviews and saves.
  const copyFromServer = async (): Promise<void> => {
    const seed = await window.api.seedLocalConfigFromServer()
    if (!seed) {
      setSeedNotice(t('settings.config.copyFromServerEmpty'))
      return
    }
    setDraft((d) => ({ ...d, [category]: seed[category] }))
    setSeedNotice(t('settings.config.copyFromServerDone'))
  }

  return (
    <div className="space-y-5">
      <Lede>{t(`settings.config.lede${KEY[category]}`)}</Lede>

      {/* Account-less (local) mode has no server config — the source choice
          would be meaningless, so it only renders in server mode. */}
      {mode === 'server' && (
        <Group>
          <Row
            label={t('settings.config.sourceLabel')}
            description={t(`settings.config.sourceDescription.${source}`)}
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={sources === null}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[6.5px] bg-background px-2.5 py-1 text-xs shadow-[inset_0_0_0_0.5px_var(--input),0_1px_1.5px_rgb(0_0_0/0.07)] transition-colors hover:bg-muted"
              >
                {t(`settings.config.source.${source}`)}
                <IconChevronDown className="size-3 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {SOURCE_OPTIONS.map((choice) => (
                  <DropdownMenuItem key={choice} onClick={() => selectSource(choice)}>
                    <span className="flex flex-col">
                      <span>{t(`settings.config.source.${choice}`)}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t(`settings.config.sourceDescription.${choice}`)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </Row>
        </Group>
      )}

      <div>
        <GroupLabel>{t('settings.config.ownEntries')}</GroupLabel>
        {mode === 'server' && source === 'server' && (
          <p className="mb-3 text-[12px] text-muted-foreground">
            {t('settings.config.sourceServerHint')}
          </p>
        )}
        {category === 'llm' && (
          <LlmEditor
            value={draft.llm}
            onChange={(llm) => setDraft((d) => ({ ...d, llm }))}
            // Without the server's models (local mode / own-entries-only) a
            // missing main model means the assistant can't run at all.
            warnMissingMain={mode === 'local' || source === 'local'}
          />
        )}
        {category === 'mcpServers' && (
          <McpEditor
            value={draft.mcpServers}
            onChange={(mcpServers) => setDraft((d) => ({ ...d, mcpServers }))}
          />
        )}
        {category === 'services' && (
          <ServicesEditor
            value={draft.services}
            onChange={(services) => setDraft((d) => ({ ...d, services }))}
          />
        )}
        {category === 'systemPrompts' && (
          <PromptsEditor
            value={draft.systemPrompts}
            onChange={(systemPrompts) => setDraft((d) => ({ ...d, systemPrompts }))}
          />
        )}
        {category === 'skills' && (
          <SkillsEditor
            value={draft.skills}
            onChange={(skills) => setDraft((d) => ({ ...d, skills }))}
          />
        )}
      </div>

      {/* Save bar */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? t('settings.config.saving') : t('settings.config.save')}
        </Button>
        {mode === 'server' && (
          <Button type="button" variant="outline" size="sm" onClick={() => void copyFromServer()}>
            {t('settings.config.copyFromServer')}
          </Button>
        )}
        {saved ? (
          <span className="text-[12px] text-muted-foreground">{t('settings.config.saved')}</span>
        ) : (
          seedNotice && <span className="text-[12px] text-muted-foreground">{seedNotice}</span>
        )}
      </div>
    </div>
  )
}
