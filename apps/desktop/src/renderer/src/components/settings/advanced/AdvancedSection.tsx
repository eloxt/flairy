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

/** Thrown by the import parser when the JSON is valid but a section's shape is not. */
class ImportShapeError extends Error {
  constructor(public readonly path: string) {
    super(`invalid structure at ${path}`)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Assert `obj[key]` is a string (missing/non-string → ImportShapeError). */
function reqStr(obj: Record<string, unknown>, key: string, path: string): void {
  if (typeof obj[key] !== 'string') throw new ImportShapeError(`${path}.${key}`)
}

/**
 * Validate + normalize one `llm.<role>` entry. The editors dereference these
 * fields unconditionally, so a malformed import must fail HERE with a readable
 * path instead of white-screening the page. Optional fields the server may
 * omit are defaulted (`input` → ['text']).
 */
function normalizeActiveLlm(v: unknown, path: string): NonNullable<LocalConfigDraft['llm']['main']> {
  if (!isObj(v) || !isObj(v.provider) || !isObj(v.model)) throw new ImportShapeError(path)
  const provider = v.provider
  const model = v.model
  for (const k of ['id', 'name', 'api', 'credential']) reqStr(provider, k, `${path}.provider`)
  for (const k of ['id', 'providerId', 'name', 'model']) reqStr(model, k, `${path}.model`)
  const input = Array.isArray(model.input) && model.input.length ? model.input : ['text']
  return { ...v, provider, model: { ...model, input } } as unknown as NonNullable<
    LocalConfigDraft['llm']['main']
  >
}

/**
 * Parse a pasted server-delivered config (a `config:snapshot` payload or a
 * LocalConfigDraft-shaped export) into the editor draft. Sections present in
 * the JSON replace the current draft's; absent sections are kept. Snapshot
 * skills are summaries (no bodies) and can't run detached — they are skipped
 * and surfaced as a warning; only full skills (with `files`) import.
 */
function parseImportedConfig(
  text: string,
  current: LocalConfigDraft
): { draft: LocalConfigDraft; skippedSkills: number } {
  const raw = JSON.parse(text) as unknown
  if (!isObj(raw)) throw new ImportShapeError('$')
  const obj = raw
  let idSeq = 0
  // Editors key rows by `id`; hand-authored imports may omit it, so synthesize one.
  const idOr = (v: unknown, prefix: string): string =>
    typeof v === 'string' && v ? v : `import-${prefix}-${++idSeq}`
  const arr = (v: unknown, path: string): Record<string, unknown>[] | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v)) throw new ImportShapeError(path)
    return v.map((item, i) => {
      if (!isObj(item)) throw new ImportShapeError(`${path}[${i}]`)
      return item
    })
  }

  const draft: LocalConfigDraft = { ...current }
  if (obj.llm !== undefined) {
    if (!isObj(obj.llm)) throw new ImportShapeError('llm')
    const llm = obj.llm
    draft.llm = {
      main: llm.main ? normalizeActiveLlm(llm.main, 'llm.main') : null,
      tool: llm.tool ? normalizeActiveLlm(llm.tool, 'llm.tool') : null,
      visual: llm.visual ? normalizeActiveLlm(llm.visual, 'llm.visual') : null
    }
  }
  const mcp = arr(obj.mcpServers, 'mcpServers')
  if (mcp) {
    draft.mcpServers = mcp.map((srv, i) => {
      const path = `mcpServers[${i}]`
      reqStr(srv, 'name', path)
      if (!isObj(srv.transport)) throw new ImportShapeError(`${path}.transport`)
      const transport = srv.transport
      if (transport.kind === 'stdio') reqStr(transport, 'command', `${path}.transport`)
      else if (transport.kind === 'sse' || transport.kind === 'http')
        reqStr(transport, 'url', `${path}.transport`)
      else throw new ImportShapeError(`${path}.transport.kind`)
      if (srv.allowedTools !== undefined && !Array.isArray(srv.allowedTools))
        throw new ImportShapeError(`${path}.allowedTools`)
      return {
        allowedTools: [],
        enabled: true,
        ...srv,
        id: idOr(srv.id, 'mcp')
      } as unknown as LocalConfigDraft['mcpServers'][number]
    })
  }
  const prompts = arr(obj.systemPrompts, 'systemPrompts')
  if (prompts) {
    draft.systemPrompts = prompts.map((p, i) => {
      reqStr(p, 'name', `systemPrompts[${i}]`)
      reqStr(p, 'body', `systemPrompts[${i}]`)
      return {
        enabled: true,
        ...p,
        id: idOr(p.id, 'prompt')
      } as unknown as LocalConfigDraft['systemPrompts'][number]
    })
  }
  const services = arr(obj.services, 'services')
  if (services) {
    draft.services = services.map((s, i) => {
      // ServicesEditor dereferences `settings.*` unconditionally.
      if (s.settings !== undefined && !isObj(s.settings))
        throw new ImportShapeError(`services[${i}].settings`)
      return {
        kind: 'exa',
        name: '',
        secret: '',
        enabled: true,
        settings: {},
        ...s,
        id: idOr(s.id, 'service')
      } as unknown as LocalConfigDraft['services'][number]
    })
  }

  let skippedSkills = 0
  const skills = arr(obj.skills, 'skills')
  if (skills) {
    const full = skills.filter((s) => Array.isArray(s.files))
    skippedSkills = skills.length - full.length
    draft.skills = full.map((s, i) => {
      const path = `skills[${i}]`
      reqStr(s, 'name', path)
      const files = (s.files as unknown[]).map((f, j) => {
        if (!isObj(f)) throw new ImportShapeError(`${path}.files[${j}]`)
        return { path: '', sourceType: 'text', ...f, id: idOr(f.id, 'file') }
      })
      return {
        description: '',
        metadata: {},
        extraFrontmatter: {},
        skillMdBody: '',
        enabled: true,
        ...s,
        id: idOr(s.id, 'skill'),
        files
      } as unknown as LocalConfigDraft['skills'][number]
    })
  }
  return { draft, skippedSkills }
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
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importNotice, setImportNotice] = useState<string | null>(null)

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

  const applyImport = (): void => {
    setImportError(null)
    try {
      const { draft: next, skippedSkills } = parseImportedConfig(importText, draft)
      setDraft(next)
      setImportOpen(false)
      setImportText('')
      setImportNotice(
        skippedSkills > 0
          ? t('settings.advanced.importedSkippedSkills', { count: skippedSkills })
          : t('settings.advanced.importedHint')
      )
    } catch (err) {
      setImportError(
        err instanceof ImportShapeError
          ? t('settings.advanced.importErrorShape', { path: err.path })
          : t('settings.advanced.importError')
      )
    }
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

      {/* Import a server-delivered config JSON (local mode only): parsing fills
          the editor draft; nothing persists until the user reviews and saves. */}
      {mode === 'local' && (
        <div className="rounded-[10px] bg-card p-3.5 shadow-[inset_0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('settings.advanced.importLabel')}</div>
              <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                {t('settings.advanced.importDescription')}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setImportOpen((v) => !v)
                setImportError(null)
              }}
            >
              {importOpen ? t('settings.advanced.importCancel') : t('settings.advanced.importButton')}
            </Button>
          </div>
          {importOpen && (
            <div className="mt-3 space-y-2">
              <textarea
                value={importText}
                rows={8}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t('settings.advanced.importPlaceholder')}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              {importError && <p className="text-[12px] text-destructive">{importError}</p>}
              <Button
                type="button"
                size="sm"
                onClick={applyImport}
                disabled={!importText.trim()}
              >
                {t('settings.advanced.importApply')}
              </Button>
            </div>
          )}
          {importNotice && !importOpen && (
            <p className="mt-2 text-[12px] text-muted-foreground">{importNotice}</p>
          )}
        </div>
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
