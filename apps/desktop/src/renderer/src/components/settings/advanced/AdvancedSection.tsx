import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigMode, LocalConfigDraft } from '@shared/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { LlmEditor } from './LlmEditor'
import { McpEditor } from './McpEditor'
import { ServicesEditor } from './ServicesEditor'
import { PromptsEditor } from './PromptsEditor'
import { SkillsEditor } from './SkillsEditor'

type Section = 'llm' | 'mcp' | 'services' | 'prompts' | 'skills'

const EMPTY_DRAFT: LocalConfigDraft = {
  llm: { main: null, tool: null, visual: null },
  mcpServers: [],
  systemPrompts: [],
  services: [],
  skills: []
}

/**
 * The hidden Advanced-settings tab: a "local mode" switch that detaches the
 * client from the server, plus a five-part editor for the configuration the
 * server would otherwise push (models / tools / web search / prompts / skills).
 * Secrets are entered here and stored (encrypted) in the main process; they
 * round-trip back only masked.
 */
export function AdvancedSection(): React.JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ConfigMode>('server')
  const [draft, setDraft] = useState<LocalConfigDraft>(EMPTY_DRAFT)
  const [section, setSection] = useState<Section>('llm')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.getConfigMode().then(setMode)
    void window.api.getLocalConfig().then((d) => {
      if (d) setDraft(d)
    })
    return window.api.onConfigModeChanged(setMode)
  }, [])

  const toggleMode = (on: boolean): void => {
    const next: ConfigMode = on ? 'local' : 'server'
    setMode(next)
    void window.api.setConfigMode(next)
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

  const sections: { id: Section; label: string }[] = [
    { id: 'llm', label: t('settings.advanced.sectionLlm') },
    { id: 'mcp', label: t('settings.advanced.sectionMcp') },
    { id: 'services', label: t('settings.advanced.sectionServices') },
    { id: 'prompts', label: t('settings.advanced.sectionPrompts') },
    { id: 'skills', label: t('settings.advanced.sectionSkills') }
  ]

  return (
    <div className="space-y-5">
      <p className="text-[12px] leading-snug text-muted-foreground">{t('settings.advanced.intro')}</p>

      {/* Local mode switch */}
      <div className="flex items-start justify-between gap-4 rounded-[10px] bg-card p-3.5 shadow-[inset_0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{t('settings.advanced.localModeLabel')}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            {t('settings.advanced.localModeDescription')}
          </div>
        </div>
        <Switch checked={mode === 'local'} onCheckedChange={toggleMode} />
      </div>

      {mode !== 'local' && (
        <p className="text-[12px] text-muted-foreground">{t('settings.advanced.localModeOffHint')}</p>
      )}

      {/* Sub-nav */}
      <div className="flex flex-wrap gap-1">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={cn(
              'rounded-full px-3 py-1 text-[12px] transition-colors',
              section === s.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-foreground/[0.06] text-foreground/70 hover:bg-foreground/10'
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Editor */}
      <div className={cn(mode !== 'local' && 'opacity-70')}>
        {section === 'llm' && (
          <LlmEditor value={draft.llm} onChange={(llm) => setDraft((d) => ({ ...d, llm }))} />
        )}
        {section === 'mcp' && (
          <McpEditor
            value={draft.mcpServers}
            onChange={(mcpServers) => setDraft((d) => ({ ...d, mcpServers }))}
          />
        )}
        {section === 'services' && (
          <ServicesEditor
            value={draft.services}
            onChange={(services) => setDraft((d) => ({ ...d, services }))}
          />
        )}
        {section === 'prompts' && (
          <PromptsEditor
            value={draft.systemPrompts}
            onChange={(systemPrompts) => setDraft((d) => ({ ...d, systemPrompts }))}
          />
        )}
        {section === 'skills' && (
          <SkillsEditor value={draft.skills} onChange={(skills) => setDraft((d) => ({ ...d, skills }))} />
        )}
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 border-t border-border/60 pt-4">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? t('settings.advanced.saving') : t('settings.advanced.save')}
        </Button>
        {saved && <span className="text-[12px] text-muted-foreground">{t('settings.advanced.saved')}</span>}
      </div>

      {/* Re-hide */}
      <div className="flex items-start justify-between gap-4 rounded-[10px] bg-card p-3.5 shadow-[inset_0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{t('settings.advanced.rehideLabel')}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
            {t('settings.advanced.rehideDescription')}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void window.api.setAdvancedUnlocked(false)}
        >
          {t('settings.advanced.rehideButton')}
        </Button>
      </div>
    </div>
  )
}
