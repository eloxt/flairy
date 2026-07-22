import { useTranslation } from 'react-i18next'
import type { SystemPromptConfig } from '@flairy/shared'
import { AddButton, ItemCard, SwitchRow, TextAreaField, TextField } from './primitives'

let counter = 0
function newId(): string {
  counter += 1
  return `local-prompt-${Date.now()}-${counter}`
}

function blankPrompt(): SystemPromptConfig {
  return { id: newId(), name: 'main', body: '', enabled: true }
}

export function PromptsEditor({
  value,
  onChange
}: {
  value: SystemPromptConfig[]
  onChange: (next: SystemPromptConfig[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<SystemPromptConfig>): void =>
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">{t('settings.advanced.promptReservedHint')}</p>
      {value.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('settings.advanced.promptsEmpty')}</p>
      )}
      {value.map((prompt, i) => (
        <ItemCard
          key={prompt.id}
          title={prompt.name || t('settings.advanced.promptsAdd')}
          onRemove={() => onChange(value.filter((_, idx) => idx !== i))}
        >
          <SwitchRow
            label={t('settings.advanced.enabled')}
            checked={prompt.enabled}
            onChange={(enabled) => update(i, { enabled })}
          />
          <TextField
            label={t('settings.advanced.promptName')}
            value={prompt.name}
            onChange={(name) => update(i, { name })}
          />
          <TextAreaField
            label={t('settings.advanced.promptBody')}
            value={prompt.body}
            rows={8}
            mono
            onChange={(body) => update(i, { body })}
          />
        </ItemCard>
      ))}
      <AddButton label={t('settings.advanced.promptsAdd')} onClick={() => onChange([...value, blankPrompt()])} />
    </div>
  )
}
