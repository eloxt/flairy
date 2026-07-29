import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconArrowLeft, IconCheck, IconChevronDown } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useChat } from '@/store/chat-store'
import type { AskQuestion, QuestionAnswer, QuestionRequestPayload } from '@shared/ipc'

/** Per-question working state: ticked option labels + the free-text "other". */
interface AnswerState {
  selected: Set<string>
  custom: string
}

/**
 * The `ask` tool's question card, hosted on the composer's outer shell (it
 * slides out above the input — the answer is the next thing the user types,
 * so the question belongs where their hands already are). One quiet surface:
 * the question text leads (no title bar), options are chip-like rows that
 * invert to the primary fill when picked, and the free-text "other" is a bare
 * underline field. Multiple questions become a horizontal slide deck — one
 * question at a time with dot progress and back/next — instead of a long
 * vertical form. The model's turn is blocked until the user submits; submit
 * is disabled until every question has at least one ticked option or
 * non-empty custom text. The card leaves when the store drops the request
 * from `questionQueue` on submit.
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
  const [index, setIndex] = useState(0)
  // Temporarily fold the card to a one-line summary so the conversation
  // behind it is readable; a new ask remounts the card (keyed) expanded.
  const [collapsed, setCollapsed] = useState(false)
  const total = payload.questions.length

  // The slide deck is a flex row, so its natural height is the tallest
  // question's. Track the active slide's measured height instead and animate
  // the clipping container to it, so short questions don't leave dead space.
  const slideRefs = useRef<(HTMLDivElement | null)[]>([])
  const [deckHeight, setDeckHeight] = useState<number>()
  useLayoutEffect(() => {
    if (collapsed) return
    const el = slideRefs.current[index]
    if (!el) return
    const sync = (): void => setDeckHeight(el.offsetHeight)
    sync()
    // Width changes (composer resize) reflow the slide; keep the height synced.
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [index, collapsed])

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

  const answered = (q: AskQuestion): boolean => {
    const a = stateFor(q.id)
    return a.selected.size > 0 || a.custom.trim().length > 0
  }

  // Every question must have at least one ticked option or non-empty custom text.
  const canSubmit = payload.questions.every(answered)
  const isLast = index === total - 1

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

  // Collapse/expand animate via the grid 0fr↔1fr row trick: both the summary
  // row and the full card stay mounted (answers survive), one folds shut while
  // the other unfolds, and the composer's total height glides between them.
  const foldBase =
    'grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none'

  return (
    <div>
      <div
        className={cn(foldBase, collapsed ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
        inert={!collapsed}
        aria-hidden={!collapsed}
      >
        <div className="min-h-0 overflow-hidden">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-expanded={false}
            aria-label={t('common.expand')}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{payload.questions[index].question}</span>
            {total > 1 && (
              <span className="shrink-0 tabular-nums">
                {index + 1}/{total}
              </span>
            )}
            <IconChevronDown className="size-3.5 shrink-0 rotate-180" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div
        className={cn(foldBase, collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]')}
        inert={collapsed}
        aria-hidden={collapsed}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="relative px-4 pb-3.5 pt-3">
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        aria-expanded
        aria-label={t('common.collapse')}
        className="absolute right-2.5 top-2 z-10 flex size-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <IconChevronDown className="size-3.5" strokeWidth={2} />
      </button>
        <div
          className="overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
          style={total > 1 ? { height: deckHeight } : undefined}
        >
          <div
            className="flex items-start transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(-${index * 100}%)` }}
          >
            {payload.questions.map((q, i) => {
              const a = stateFor(q.id)
              const multi = Boolean(q.multiSelect)
              return (
                <div
                  key={q.id}
                  ref={(el) => {
                    slideRefs.current[i] = el
                  }}
                  inert={i !== index}
                  aria-hidden={i !== index}
                  className={cn(
                    'w-full shrink-0 space-y-2.5 transition-opacity duration-300',
                    i !== index && 'opacity-0'
                  )}
                >
                  {(q.header || multi) && (
                    <div className="flex items-baseline gap-2 pr-8 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      {q.header && <span>{q.header}</span>}
                      {multi && (
                        <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
                          {t('question.multi')}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="pr-8 text-sm font-medium leading-relaxed text-foreground">{q.question}</p>
                  <div className="flex flex-col gap-1.5">
                    {q.options.map((opt) => {
                      const checked = a.selected.has(opt.label)
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() => toggleOption(q.id, opt.label, multi)}
                          aria-pressed={checked}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                            // Unchecked rows sit on the composer's muted shell,
                            // so they take the card surface (same nesting cue as
                            // the input card) rather than a secondary wash that
                            // would blend into the shell.
                            checked
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-card hover:bg-accent'
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block text-sm leading-snug">{opt.label}</span>
                            {opt.description && (
                              <span
                                className={cn(
                                  'mt-0.5 block text-xs leading-snug',
                                  checked ? 'text-primary-foreground/65' : 'text-muted-foreground'
                                )}
                              >
                                {opt.description}
                              </span>
                            )}
                          </span>
                          {checked && <IconCheck className="size-3.5 shrink-0" strokeWidth={2.5} />}
                        </button>
                      )
                    })}
                  </div>
                  <input
                    type="text"
                    value={a.custom}
                    onChange={(e) => setCustom(q.id, e.target.value)}
                    placeholder={t('question.other')}
                    className="w-full border-b border-border/60 bg-transparent px-1 pb-1.5 pt-1 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-foreground/40"
                  />
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {total > 1 &&
              payload.questions.map((q, i) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`${i + 1} / ${total}`}
                  aria-current={i === index}
                  className={cn(
                    'size-1.5 rounded-full transition-colors',
                    i === index
                      ? 'bg-foreground'
                      : answered(q)
                        ? 'bg-foreground/35 hover:bg-foreground/60'
                        : 'bg-border hover:bg-foreground/40'
                  )}
                />
              ))}
          </div>
          <div className="flex items-center gap-2">
            {total > 1 && index > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full px-3 text-muted-foreground"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                <IconArrowLeft className="size-3.5" strokeWidth={2} />
                {t('question.back')}
              </Button>
            )}
            {isLast ? (
              <Button size="sm" className="rounded-full px-4" disabled={!canSubmit} onClick={submit}>
                {t('question.submit')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="rounded-full px-4"
                disabled={!answered(payload.questions[index])}
                onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
              >
                {t('question.next')}
              </Button>
            )}
          </div>
        </div>
          </div>
        </div>
      </div>
    </div>
  )
}
