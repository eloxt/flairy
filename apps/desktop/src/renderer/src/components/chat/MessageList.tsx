import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Terminal, CircleAlert, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toolDisplayKey } from '@/lib/tool-display'
import { useChat } from '@/store/chat-store'
import type { UiMessage } from '@/store/chat-store'
import { ApprovalCard } from './ApprovalCard'

export function MessageList({ messages }: { messages: UiMessage[] }): React.JSX.Element {
  const approvalCount = useChat((s) => s.approvalQueue.length)
  // Pending approvals render inline in the footer, so keep the list mounted
  // whenever there's a message OR an approval to show.
  if (messages.length === 0 && approvalCount === 0) return <EmptyState />

  return (
    <Virtuoso
      className="absolute inset-0"
      data={messages}
      followOutput="smooth"
      components={{ Header: Spacer, Footer: ApprovalFooter }}
      itemContent={(_i, m) => <MessageRow key={m.id} m={m} />}
    />
  )
}

const Spacer = (): React.JSX.Element => <div className="h-6" />

/**
 * Renders any pending approval requests as inline, non-blocking cards, then
 * leaves room at the bottom so the last item clears the floating composer.
 * Height tracks the composer's live size via the `--composer-h` CSS variable it
 * publishes (falls back to 9rem before the composer has measured itself).
 */
const ApprovalFooter = (): React.JSX.Element => {
  const approvalQueue = useChat((s) => s.approvalQueue)
  return (
    <>
      <ThinkingRow />
      {approvalQueue.map((req) => (
        <ApprovalCard key={req.approvalId} payload={req} />
      ))}
      <div style={{ height: 'var(--composer-h, 9rem)' }} />
    </>
  )
}

/**
 * The pause between sending and the first token. Three dots breathing in place —
 * the only signal the agent is awake. Shown only in that gap: once text streams
 * the caret takes over, and once a tool runs its own row pulses instead.
 */
function ThinkingRow(): React.JSX.Element | null {
  const show = useChat((s) => {
    if (!s.running) return false
    const last = s.messages[s.messages.length - 1]
    return last?.role === 'user'
  })
  if (!show) return null
  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-muted-foreground"
            style={{ animation: 'var(--animate-thinking)', animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

/** First-run: a single quiet line. No hero, no ornament — just an invitation. */
function EmptyState(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto px-6">
      <div className="mx-auto max-w-md -translate-y-[8%] text-center">
        <h1 className="animate-rise-in text-2xl font-medium tracking-tight text-foreground">
          {t('chat.emptyTitle')}
        </h1>
        <p
          className="animate-rise-in mt-2 text-sm text-muted-foreground"
          style={{ animationDelay: '90ms' }}
        >
          {t('chat.emptySubtitle')}
        </p>
      </div>
    </div>
  )
}

function MessageRow({ m }: { m: UiMessage }): React.JSX.Element {
  if (m.role === 'tool') return <ToolRow m={m} />
  if (m.role === 'user') return <UserRow m={m} />
  return <AssistantRow m={m} />
}

/** User turn: a quiet, right-aligned chip. Restraint over a loud bubble. */
function UserRow({ m }: { m: UiMessage }): React.JSX.Element {
  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2.5 text-sm leading-relaxed text-secondary-foreground">
          {m.text}
        </div>
      </div>
    </div>
  )
}

/** Agent turn: full-width prose, no frame. The words carry it. */
function AssistantRow({ m }: { m: UiMessage }): React.JSX.Element {
  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div
        className={cn(
          'prose prose-sm prose-neutral max-w-none dark:prose-invert',
          'prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-card',
          'prose-code:font-mono prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none',
          'prose-headings:tracking-tight prose-p:leading-relaxed',
          m.streaming && 'blink-caret'
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
      </div>
    </div>
  )
}

/**
 * Tool run: a low-intrusion single line — just the tool name and a status dot,
 * collapsed by default. Click the row to reveal the output. Keeps the machine
 * surface quiet so it doesn't crowd the conversation.
 */
function ToolRow({ m }: { m: UiMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const running = m.running ?? false
  const [open, setOpen] = useState(false)
  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/70 transition-transform',
            open && 'rotate-90'
          )}
          strokeWidth={2}
        />
        {m.isError ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" strokeWidth={2} />
        ) : (
          <Terminal className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
        )}
        <span
          className={cn(
            'text-xs font-medium',
            m.isError ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {t(toolDisplayKey(m.toolName))}
        </span>
        <span
          className={cn(
            'ml-auto size-1.5 shrink-0 rounded-full',
            m.isError
              ? 'bg-destructive'
              : running
                ? 'animate-pulse bg-muted-foreground'
                : 'bg-foreground/60'
          )}
        />
      </button>
      {open && (
        <pre
          className={cn(
            'mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-card/60 px-3 py-2 font-mono text-xs leading-relaxed',
            m.isError ? 'border-destructive/30 text-destructive' : 'border-border text-muted-foreground'
          )}
        >
          {m.text}
        </pre>
      )}
    </div>
  )
}
