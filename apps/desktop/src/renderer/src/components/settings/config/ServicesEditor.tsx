import { useTranslation } from 'react-i18next'
import type { ServiceConfig } from '@flairy/shared'
import { AddButton, ItemCard, NumberField, SecretField, SwitchRow, TextField } from './primitives'

let counter = 0
function newId(): string {
  counter += 1
  return `local-exa-${Date.now()}-${counter}`
}

function blankService(): ServiceConfig {
  return {
    id: newId(),
    kind: 'exa',
    name: 'Exa',
    enabled: true,
    secret: '',
    settings: { numResults: 5, baseUrl: 'https://api.exa.ai' }
  }
}

export function ServicesEditor({
  value,
  onChange
}: {
  value: ServiceConfig[]
  onChange: (next: ServiceConfig[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<ServiceConfig>): void =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const setSetting = (i: number, key: string, v: unknown): void =>
    update(i, { settings: { ...value[i].settings, [key]: v } })

  return (
    <div className="space-y-4">
      {value.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('settings.config.servicesEmpty')}</p>
      )}
      {value.map((service, i) => (
        <ItemCard
          key={service.id}
          title={service.name || 'Exa'}
          onRemove={() => onChange(value.filter((_, idx) => idx !== i))}
        >
          <SwitchRow
            label={t('settings.config.enabled')}
            checked={service.enabled}
            onChange={(enabled) => update(i, { enabled })}
          />
          <TextField
            label={t('settings.config.name')}
            value={service.name}
            onChange={(name) => update(i, { name })}
          />
          <SecretField
            label={t('settings.config.credential')}
            hint={t('settings.config.secretKeepHint')}
            value={service.secret}
            onChange={(secret) => update(i, { secret })}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={t('settings.config.numResults')}
              value={typeof service.settings.numResults === 'number' ? service.settings.numResults : undefined}
              onChange={(n) => setSetting(i, 'numResults', n)}
            />
            <TextField
              label={t('settings.config.baseUrl')}
              value={typeof service.settings.baseUrl === 'string' ? service.settings.baseUrl : ''}
              onChange={(v) => setSetting(i, 'baseUrl', v)}
            />
          </div>
        </ItemCard>
      ))}
      <AddButton label={t('settings.config.servicesAdd')} onClick={() => onChange([...value, blankService()])} />
    </div>
  )
}
