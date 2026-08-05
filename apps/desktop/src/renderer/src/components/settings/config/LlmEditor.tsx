import { useTranslation } from 'react-i18next'
import type { ActiveLlm, LlmRole, ProviderApi, RoleModels, ThinkingLevel } from '@flairy/shared'
import { Button } from '@/components/ui/button'
import {
  ItemCard,
  NumberField,
  SecretField,
  SelectField,
  SwitchRow,
  TextField
} from './primitives'

const API_OPTIONS: ProviderApi[] = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai'
]

const THINKING_OPTIONS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** A sensible default base URL for each API type (the user can override it). */
const DEFAULT_BASE_URL: Record<ProviderApi, string> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-completions': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  'google-generative-ai': 'https://generativelanguage.googleapis.com'
}

function blankLlm(role: LlmRole): ActiveLlm {
  const providerId = `local-${role}-provider`
  return {
    provider: {
      id: providerId,
      name: role,
      api: 'anthropic-messages',
      credential: '',
      baseUrl: DEFAULT_BASE_URL['anthropic-messages']
    },
    model: {
      id: `local-${role}-model`,
      providerId,
      name: '',
      model: '',
      input: ['text']
    }
  }
}

export function LlmEditor({
  value,
  onChange,
  warnMissingMain
}: {
  value: RoleModels
  onChange: (next: RoleModels) => void
  /** Warn when no main model is set — only when the server's can't fill in. */
  warnMissingMain?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const roles: { role: LlmRole; title: string; description: string }[] = [
    { role: 'main', title: t('settings.config.roleMain'), description: t('settings.config.roleMainDescription') },
    { role: 'tool', title: t('settings.config.roleTool'), description: t('settings.config.roleToolDescription') },
    { role: 'visual', title: t('settings.config.roleVisual'), description: t('settings.config.roleVisualDescription') }
  ]

  return (
    <div className="space-y-4">
      {warnMissingMain && !value.main && (
        <p className="text-[12px] text-destructive">{t('settings.config.llmMainMissing')}</p>
      )}
      {roles.map(({ role, title, description }) => (
        <RoleEditor
          key={role}
          role={role}
          title={title}
          description={description}
          value={value[role]}
          onChange={(llm) => onChange({ ...value, [role]: llm })}
        />
      ))}
    </div>
  )
}

function RoleEditor({
  role,
  title,
  description,
  value,
  onChange
}: {
  role: LlmRole
  title: string
  description: string
  value: ActiveLlm | null
  onChange: (next: ActiveLlm | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  if (!value) {
    return (
      <ItemCard title={title}>
        <p className="text-[12px] text-muted-foreground">{description}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(blankLlm(role))}>
          {t('settings.config.roleEnable')}
        </Button>
      </ItemCard>
    )
  }

  const setProvider = (patch: Partial<ActiveLlm['provider']>): void =>
    onChange({ ...value, provider: { ...value.provider, ...patch } })
  const setModel = (patch: Partial<ActiveLlm['model']>): void =>
    onChange({ ...value, model: { ...value.model, ...patch } })

  return (
    <ItemCard title={title} onRemove={role === 'main' ? undefined : () => onChange(null)}>
      <p className="text-[12px] text-muted-foreground">{description}</p>
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label={t('settings.config.providerApi')}
          value={value.provider.api}
          options={API_OPTIONS.map((a) => ({ value: a, label: a }))}
          onChange={(api) => {
            // Auto-fill base URL when switching, unless the user set a custom one.
            const wasDefault =
              !value.provider.baseUrl ||
              Object.values(DEFAULT_BASE_URL).includes(value.provider.baseUrl)
            setProvider({ api, baseUrl: wasDefault ? DEFAULT_BASE_URL[api] : value.provider.baseUrl })
          }}
        />
        <TextField
          label={t('settings.config.baseUrl')}
          value={value.provider.baseUrl ?? ''}
          onChange={(baseUrl) => setProvider({ baseUrl })}
        />
      </div>
      <SecretField
        label={t('settings.config.credential')}
        hint={t('settings.config.secretKeepHint')}
        value={value.provider.credential}
        onChange={(credential) => setProvider({ credential })}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('settings.config.modelId')}
          value={value.model.model}
          placeholder="claude-sonnet-4-20250514"
          onChange={(model) => setModel({ model })}
        />
        <TextField
          label={t('settings.config.modelName')}
          value={value.model.name}
          onChange={(name) => setModel({ name })}
        />
      </div>
      <SwitchRow
        label={t('settings.config.acceptsImages')}
        checked={value.model.input.includes('image')}
        onChange={(on) => setModel({ input: on ? ['text', 'image'] : ['text'] })}
      />
      <div className="grid grid-cols-3 gap-3">
        <SelectField
          label={t('settings.config.thinkingLevel')}
          value={value.model.thinkingLevel ?? 'off'}
          options={THINKING_OPTIONS.map((l) => ({ value: l, label: l }))}
          onChange={(thinkingLevel) =>
            setModel({ thinkingLevel: thinkingLevel === 'off' ? undefined : thinkingLevel })
          }
        />
        <NumberField
          label={t('settings.config.contextWindow')}
          value={value.model.contextWindow}
          onChange={(contextWindow) => setModel({ contextWindow })}
        />
        <NumberField
          label={t('settings.config.maxTokens')}
          value={value.model.maxTokens}
          onChange={(maxTokens) => setModel({ maxTokens })}
        />
      </div>
    </ItemCard>
  )
}
