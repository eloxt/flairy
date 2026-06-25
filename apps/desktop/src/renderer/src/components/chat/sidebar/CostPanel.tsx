import { useTranslation } from 'react-i18next'
import type { UiMessage } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

/** Dollars with up to 4 decimals — costs are often fractions of a cent. */
function formatCost(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  })
}

/**
 * Per-session spend summary. Sums the token usage + already-computed dollar cost
 * pi reports on each assistant turn (attached to the turn's first bubble). If the
 * active model has no cost configured server-side, costs read $0 but token counts
 * still show.
 */
export function CostPanel({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation()

  const totals = messages.reduce(
    (acc, m) => {
      const u = m.usage
      if (!u) return acc
      return {
        cost: acc.cost + u.cost.total,
        input: acc.input + u.input,
        output: acc.output + u.output,
        cache: acc.cache + u.cacheRead + u.cacheWrite,
        tokens: acc.tokens + u.totalTokens,
        any: true
      }
    },
    { cost: 0, input: 0, output: 0, cache: 0, tokens: 0, any: false }
  )

  if (!totals.any) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t('panel.costEmpty')}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 px-3 py-3">
        {/* Headline totals */}
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
          <div className="text-[0.7rem] font-medium text-muted-foreground uppercase tracking-wide">
            {t('panel.totalCost')}
          </div>
          <div className="mt-0.5 text-2xl font-semibold tabular-nums">{formatCost(totals.cost)}</div>
          <div className="mt-1 text-xs text-muted-foreground tabular-nums">
            {numberFmt.format(totals.tokens)} {t('panel.tokensSuffix')}
          </div>
        </div>

        {/* Token breakdown */}
        <div className="grid grid-cols-3 gap-2">
          <Stat label={t('panel.input')} value={numberFmt.format(totals.input)} />
          <Stat label={t('panel.output')} value={numberFmt.format(totals.output)} />
          <Stat label={t('panel.cache')} value={numberFmt.format(totals.cache)} />
        </div>
      </div>
    </ScrollArea>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="text-[0.65rem] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}
