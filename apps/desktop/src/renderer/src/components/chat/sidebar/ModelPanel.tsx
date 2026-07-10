import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RedactedConfigSnapshot } from '@shared/ipc'
import type { UiMessage } from '@/store/chat-store'
import { useChat } from '@/store/chat-store'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'

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

/** Dollars per 1M tokens — pricing rates; whole cents are typical. */
function formatRate(value: number | undefined): string {
  if (value === undefined) return '—'
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

interface Totals {
  cost: number
  input: number
  output: number
  cache: number
  tokens: number
  any: boolean
}

interface ContextState {
  /** Prompt tokens of the most recent assistant turn (input + cache). */
  used: number
  hasUsage: boolean
}

/**
 * The "Model" details panel. Surfaces everything about the active main model the
 * server pushed (identity + specs + pricing), the current conversation's context
 * length against the model's window, and the per-session spend. Reads the live
 * config (initial snapshot + later deltas) and the same `messages` mirror the
 * thread renders, so it stays in lockstep with the conversation.
 */
export function ModelPanel({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation()
  const running = useChat((s) => s.running)
  const compressing = useChat((s) => s.compressing)
  const compressContext = useChat((s) => s.compressContext)

  const [config, setConfig] = useState<RedactedConfigSnapshot | null>(null)
  useEffect(() => {
    void window.api.getConfig().then(setConfig)
    return window.api.onConfigChanged(setConfig)
  }, [])

  const main = config?.llm.main ?? null
  const model = main?.model ?? null
  const provider = main?.provider ?? null

  // Current context length = the prompt token count of the latest assistant
  // turn (non-cached input + cached read + cached write — everything that was
  // in the request). Falls back to 0 until the first turn reports usage.
  const ctx: ContextState = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const u = messages[i].usage
      if (u) return { used: u.input + u.cacheRead + u.cacheWrite, hasUsage: true }
    }
    return { used: 0, hasUsage: false }
  })()

  const totals = messages.reduce<Totals>(
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

  if (!model || !provider) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t('panel.modelEmpty')}
      </div>
    )
  }

  const contextWindow = model.contextWindow
  const pct =
    contextWindow && ctx.hasUsage ? Math.min(100, (ctx.used / contextWindow) * 100) : null

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 px-3 py-3">
        {/* Model: identity + context window + specs + pricing, all in one card */}
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
          {/* Identity */}
          <div className="text-[0.7rem] font-medium text-muted-foreground tracking-wide">
            {model.name.trim() || model.model}
          </div>

          {/* Context window usage */}
          {contextWindow ? (
            <>
              <Divider />
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[0.7rem] font-medium text-muted-foreground uppercase tracking-wide">
                  {t('panel.contextUsed')}
                </div>
                {pct !== null && (
                  <div className="text-[0.7rem] tabular-nums text-muted-foreground">
                    {pct.toFixed(1)}%
                  </div>
                )}
              </div>
              <Progress className="mt-1.5 h-1.5" value={pct ?? 0} />
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {ctx.hasUsage ? (
                  <>
                    {numberFmt.format(ctx.used)} / {numberFmt.format(contextWindow)}{' '}
                    {t('panel.tokensSuffix')}
                  </>
                ) : (
                  <>
                    {numberFmt.format(contextWindow)} {t('panel.tokensSuffix')}
                  </>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 h-7 w-full text-xs"
                disabled={!ctx.hasUsage || running || compressing}
                onClick={() => void compressContext()}
              >
                {compressing ? t('panel.compressingContext') : t('panel.compressContext')}
              </Button>
            </>
          ) : null}

          {/* Specs */}
          <Divider />
          <Field
            label={t('panel.maxOutput')}
            value={model.maxTokens ? `${numberFmt.format(model.maxTokens)}` : t('panel.notSet')}
          />
          <Field label={t('panel.thinking')} value={model.thinkingLevel ?? t('panel.notSet')} />
          <Field
            label={t('panel.inputs')}
            value={model.input.join(', ') || t('panel.notSet')}
          />

          {/* Pricing */}
          {model.cost ? (
            <>
              <Divider />
              <div className="mb-0.5 text-[0.7rem] font-medium text-muted-foreground uppercase tracking-wide">
                {t('panel.pricing')}{' '}
                <span className="font-normal normal-case text-muted-foreground/80">
                  {t('panel.perMillion')}
                </span>
              </div>
              <Field label={t('panel.input')} value={formatRate(model.cost.input)} />
              <Field label={t('panel.output')} value={formatRate(model.cost.output)} />
              <Field label={t('panel.cache')} value={formatRate(model.cost.cacheRead)} />
            </>
          ) : null}
        </div>

        {/* Total cost — headline spend + input/output/cache token breakdown */}
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
          <div className="text-[0.7rem] font-medium text-muted-foreground uppercase tracking-wide">
            {t('panel.totalCost')}
          </div>
          <Divider />
          {totals.any ? (
            <>
              <div className="mt-0.5 text-2xl font-semibold tabular-nums">
                {formatCost(totals.cost)}
              </div>
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {numberFmt.format(totals.tokens)} {t('panel.tokensSuffix')}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Stat label={t('panel.input')} value={numberFmt.format(totals.input)} />
                <Stat label={t('panel.output')} value={numberFmt.format(totals.output)} />
                <Stat label={t('panel.cache')} value={numberFmt.format(totals.cache)} />
              </div>
            </>
          ) : (
            <div className="mt-1 text-xs text-muted-foreground">{t('panel.noUsage')}</div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function Divider(): React.JSX.Element {
  return <div className="my-2.5 h-px bg-border/70" />
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/70 p-2">
      <div className="text-[0.65rem] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xs font-medium tabular-nums">{value}</div>
    </div>
  )
}
