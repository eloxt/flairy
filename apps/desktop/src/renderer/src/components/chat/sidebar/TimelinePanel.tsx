import { History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UiMessage } from '@/store/chat-store'
import { useChat } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

/** First non-empty line of a message body, for a compact one-line preview. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? ''
}

function clockTime(ts: number | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * The conversation's user prompts as a vertical timeline: a hairline rail with
 * one node per prompt, breaking at day boundaries under a date label. The
 * latest prompt's node is filled ("you are here"); past ones are hollow.
 * Clicking an entry scrolls the thread to that message. Derived purely from
 * the chat store's `messages` (same in-memory objects the thread renders, so
 * the id match works live or on replay).
 */
export function TimelinePanel({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation()
  const scrollToMessage = useChat((s) => s.scrollToMessage)

  const prompts = messages.filter((m) => m.role === 'user' && (m.text.trim() || m.images?.length))

  if (!prompts.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
        <History className="size-5 text-muted-foreground/50" strokeWidth={1.5} />
        {t('panel.timelineEmpty')}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <ol className="flex flex-col px-2 py-2">
        {prompts.map((m, i) => {
          const preview =
            firstLine(m.text) ||
            (m.images?.length ? t('chat.imageCount', { count: m.images.length }) : '')
          const isLatest = i === prompts.length - 1
          // A date label sits between days; the rail breaks around it.
          const prevTs = i > 0 ? prompts[i - 1].timestamp : undefined
          const newDay =
            m.timestamp && (!prevTs || new Date(prevTs).toDateString() !== new Date(m.timestamp).toDateString())
          return (
            <li key={m.id}>
              {newDay ? (
                <div
                  className={cn(
                    'pb-1 pl-7 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground/70',
                    i > 0 && 'pt-3'
                  )}
                >
                  {dayLabel(m.timestamp!)}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => scrollToMessage(m.id)}
                title={preview}
                className="group relative flex min-w-0 w-full flex-col gap-0.5 rounded-lg py-2 pl-7 pr-2 text-left transition-colors hover:bg-accent"
              >
                {/* Rail segments: above and below the node, so the line stays
                    continuous between touching rows but breaks at day labels
                    and at both ends of the timeline. */}
                {i > 0 && !newDay ? (
                  <span aria-hidden className="absolute left-[11.5px] top-0 h-3 w-px bg-border" />
                ) : null}
                {!isLatest ? (
                  <span aria-hidden className="absolute bottom-0 left-[11.5px] top-5 w-px bg-border" />
                ) : null}
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-2 top-3 size-2 rounded-full transition-colors',
                    isLatest
                      ? 'bg-foreground ring-4 ring-foreground/10'
                      : 'border border-muted-foreground/60 group-hover:border-foreground group-hover:bg-foreground/20'
                  )}
                />
                {m.timestamp ? (
                  <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                    {clockTime(m.timestamp)}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'block min-w-0 w-full text-[0.8rem] leading-snug line-clamp-2 transition-colors',
                    isLatest ? 'text-foreground' : 'text-foreground/80 group-hover:text-foreground'
                  )}
                >
                  {preview}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </ScrollArea>
  )
}
