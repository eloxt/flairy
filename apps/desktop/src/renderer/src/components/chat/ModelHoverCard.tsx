import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActiveLlm } from '@flairy/shared'

/**
 * Body of the hover card shown next to each entry of the composer's
 * main-model picker: the model's display name and id, capability chips, and a
 * small fact list (context window, output limit, prices, knowledge cutoff,
 * release date). Facts come from the admin catalog — the runtime params plus
 * the models.dev `metadata` the admin imported — and every row is optional, so
 * a hand-created model without metadata still gets a sensible (short) card.
 */
export function ModelHoverCardBody({ option }: { option: ActiveLlm }): React.JSX.Element {
  const { t } = useTranslation()
  const model = option.model
  const meta = model.metadata

  const chips: string[] = []
  if (model.input?.includes('image')) chips.push(t('composer.modelCard.capImage'))
  if (meta?.reasoning) chips.push(t('composer.modelCard.capReasoning'))
  if (meta?.toolCall) chips.push(t('composer.modelCard.capTools'))

  const rows: { label: string; value: string }[] = []
  if (model.contextWindow) {
    rows.push({
      label: t('composer.modelCard.context'),
      value: t('composer.modelCard.tokens', { value: formatTokens(model.contextWindow) })
    })
  }
  if (model.maxTokens) {
    rows.push({
      label: t('composer.modelCard.maxOutput'),
      value: t('composer.modelCard.tokens', { value: formatTokens(model.maxTokens) })
    })
  }
  if (model.cost) {
    rows.push({
      label: t('composer.modelCard.priceInput'),
      value: t('composer.modelCard.pricePerMillion', { price: formatPrice(model.cost.input) })
    })
    rows.push({
      label: t('composer.modelCard.priceOutput'),
      value: t('composer.modelCard.pricePerMillion', { price: formatPrice(model.cost.output) })
    })
  }
  if (meta?.knowledge) {
    rows.push({ label: t('composer.modelCard.knowledge'), value: meta.knowledge })
  }
  if (meta?.releaseDate) {
    rows.push({ label: t('composer.modelCard.released'), value: meta.releaseDate })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{model.name}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">{model.model}</div>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-accent-foreground"
            >
              {chip}
            </span>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right tabular-nums">{row.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  )
}

/** Compact token-count formatting: 8192 → "8.2K", 200000 → "200K", 1048576 → "1M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trimNum(n / 1_000_000)}M`
  if (n >= 1_000) return `${trimNum(n / 1_000)}K`
  return String(n)
}

/** One decimal at most, with a trailing ".0" dropped. */
function trimNum(v: number): string {
  const rounded = Math.round(v * 10) / 10
  return String(rounded)
}

/** Price for display: round to 3 decimals and drop trailing zeros ("0.30" → "0.3"). */
function formatPrice(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}
