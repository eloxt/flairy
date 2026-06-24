import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useChat } from '@/store/chat-store'
import type { QuestionAnswer, QuestionRequestPayload } from '@shared/ipc'

/** Per-question working state: ticked option labels + the free-text "other". */
interface AnswerState {
  selected: Set<string>
  custom: string
}

/**
 * Inline, non-blocking card for an `ask` tool call. Mirrors ApprovalCard's shell
 * (same wrapper classes, store-driven submit) but renders one or more questions,
 * each single- or multi-select with a free-text "other" field. The model's turn
 * is blocked until the user submits; submit is disabled until every question has
 * at least one ticked option or non-empty custom text.
 */
export function QuestionCard({
  payload
}: {
  payload: QuestionRequestPayload
}): React.JSX.Element {
  const { t } = useTranslation()
  const respondQuestion = useChat((s) => s.respondQuestion)
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() =>
    Object.fromEntries(payload.questions.map((q) => [q.id, { selected: new Set<string>(), custom: '' }]))
  )

  const stateFor = (id: string): AnswerState => answers[id] ?? { selected: new Set(), custom: '' }

  const toggleOption = (questionId: string, label: string, multiSelect: boolean): void => {
    setAnswers((prev) => {
      const cur = prev[questionId] ?? { selected: new Set<string>(), custom: '' }
      const next = new Set(cur.selected)
      if (multiSelect) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        // Single-select: clicking replaces; clicking the same option clears it.
        const wasOnlySelected = next.has(label) && next.size === 1
        next.clear()
        if (!wasOnlySelected) next.add(label)
      }
      return { ...prev, [questionId]: { ...cur, selected: next } }
    })
  }

  const setCustom = (questionId: string, value: string): void => {
    setAnswers((prev) => {
      const cur = prev[questionId] ?? { selected: new Set<string>(), custom: '' }
      return { ...prev, [questionId]: { ...cur, custom: value } }
    })
  }

  // Every question must have at least one ticked option or non-empty custom text.
  const canSubmit = payload.questions.every((q) => {
    const a = stateFor(q.id)
    return a.selected.size > 0 || a.custom.trim().length > 0
  })

  const submit = (): void => {
    if (!canSubmit) return
    const result: QuestionAnswer[] = payload.questions.map((q) => {
      const a = stateFor(q.id)
      const custom = a.custom.trim()
      return {
        id: q.id,
        selected: [...a.selected],
        ...(custom ? { custom } : {})
      }
    })
    respondQuestion(payload.questionId, result)
  }

  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
            <MessageCircleQuestion className="size-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight">{t('question.title')}</h3>
          </div>
        </div>

        <div className="space-y-5 px-4 pb-4">
          {payload.questions.map((q) => {
            const a = stateFor(q.id)
            const multi = Boolean(q.multiSelect)
            return (
              <div key={q.id} className="space-y-2">
                {q.header && (
                  <span className="inline-block rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                    {q.header}
                  </span>
                )}
                <p className="text-sm font-medium leading-relaxed text-foreground">{q.question}</p>
                <div className="space-y-1.5">
                  {q.options.map((opt) => {
                    const checked = a.selected.has(opt.label)
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => toggleOption(q.id, opt.label, multi)}
                        aria-pressed={checked}
                        className={cn(
                          'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                          checked
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-background/40 hover:bg-muted/50'
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                            multi ? 'rounded' : 'rounded-full',
                            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                          )}
                        >
                          {checked && <Check className="size-3" strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm leading-snug text-foreground">{opt.label}</span>
                          {opt.description && (
                            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <input
                  type="text"
                  value={a.custom}
                  onChange={(e) => setCustom(q.id, e.target.value)}
                  placeholder={t('question.other')}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            )
          })}
        </div>

        <div className="flex justify-end gap-2 border-t border-border/70 bg-secondary/30 px-4 py-3">
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            {t('question.submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
