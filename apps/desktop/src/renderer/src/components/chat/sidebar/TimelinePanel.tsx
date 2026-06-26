import { useTranslation } from 'react-i18next'
import type { UiMessage } from '@/store/chat-store'
import { useChat } from '@/store/chat-store'
import { ScrollArea } from '@/components/ui/scroll-area'

/** First non-empty line of a message body, for a compact one-line preview. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim()) ?? ''
}

function clockTime(ts: number | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/**
 * The conversation's user prompts, in order. Clicking one scrolls the thread to
 * that message. Derived purely from the chat store's `messages` (same in-memory
 * objects the thread renders, so the id match works live or on replay).
 */
export function TimelinePanel({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const { t } = useTranslation()
  const scrollToMessage = useChat((s) => s.scrollToMessage)

  const prompts = messages.filter((m) => m.role === 'user' && (m.text.trim() || m.images?.length))

  if (!prompts.length) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        {t('panel.timelineEmpty')}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <ol className="flex flex-col gap-1 px-2 py-2">
        {prompts.map((m) => {
          const preview = firstLine(m.text) || (m.images?.length ? t('chat.imageCount', { count: m.images.length }) : '')
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => scrollToMessage(m.id)}
                title={preview}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
              >
                <span className="truncate text-[0.8rem] text-foreground">{preview}</span>
                {m.timestamp ? (
                  <span className="text-[0.65rem] text-muted-foreground tabular-nums">
                    {clockTime(m.timestamp)}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ol>
    </ScrollArea>
  )
}
