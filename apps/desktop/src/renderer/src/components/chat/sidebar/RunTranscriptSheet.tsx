import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconAlertTriangle,
  IconBrain,
  IconChecklist,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconFileDescription,
  IconLock,
  IconLockOpen,
  IconRobot,
  IconTerminal2,
  IconTool
} from '@tabler/icons-react'
import type { TranscriptEvent, WorkerRun } from '@shared/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'

/**
 * In-app structured view of a worker run's transcript: what the agent said and
 * thought, every tool call with its raw input, permission decisions, stderr,
 * and the outcome — a timeline in the same card language as the chat's tool
 * detail views. While the run is live the sheet re-reads the transcript on a
 * short interval; consecutive same-type text blocks (split by the writer's
 * time-sliced flushes) are merged back together for display.
 */
export function RunTranscriptSheet({
  run,
  open,
  onOpenChange
}: {
  run: WorkerRun
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [rawEvents, setRawEvents] = useState<TranscriptEvent[]>([])
  const [truncated, setTruncated] = useState(false)
  const events = mergeTextEvents(rawEvents)

  const live = ['preparing', 'running', 'pushing'].includes(run.status)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = (): void => {
      void window.api.readWorkerRunTranscript(run.id).then((r) => {
        if (!alive) return
        setRawEvents(r.events)
        setTruncated(r.truncated)
      })
    }
    load()
    // Live runs keep appending — refresh while the sheet is open.
    const timer = live ? setInterval(load, 3000) : undefined
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [open, run.id, live])

  const title =
    run.kind === 'review' && run.prNumber != null
      ? t('panel.runReviewLabel', { pr: run.prNumber })
      : run.issueNumber != null
        ? `#${run.issueNumber}`
        : run.id.slice(0, 8)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* app-no-drag: the sheet overlays the window's draggable header strip;
          -webkit-app-region ignores DOM stacking, so without this the close
          button (top-right) sits on the drag region and never receives clicks. */}
      <SheetContent side="right" className="app-no-drag gap-0 data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b border-border/60">
          <SheetTitle className="flex items-center gap-2">
            {t('panel.transcriptTitle', { run: title })}
            <StatusChip status={run.status} live={live} />
          </SheetTitle>
          <SheetDescription>
            {run.backend}
            {truncated ? ` · ${t('panel.transcriptTruncated')}` : ''}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2.5 px-4 py-3">
            {events.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t('panel.transcriptEmpty')}
              </p>
            )}
            {events.map((e, i) => (
              <TranscriptRow key={i} event={e} />
            ))}
          </div>
        </ScrollArea>

        <div className="border-t border-border/60 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => void window.api.openWorkerRunTranscript(run.id)}
          >
            <IconFileDescription className="size-3.5" />
            {t('panel.transcriptOpenRaw')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function StatusChip({ status, live }: { status: WorkerRun['status']; live: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'rounded-full px-2 py-px text-[10px] font-medium',
        live
          ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
          : status === 'failed' || status === 'timeout'
            ? 'bg-destructive/15 text-destructive'
            : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      )}
    >
      {t(`panel.runStatus.${status}`)}
      {live && <span className="ml-0.5 inline-block animate-pulse">·</span>}
    </span>
  )
}

const time = (t: number): string =>
  new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Merge runs of consecutive same-type text events (message/thought/stderr). */
function mergeTextEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  const TEXTUAL = new Set(['message', 'thought', 'stderr'])
  const out: TranscriptEvent[] = []
  for (const e of events) {
    const prev = out[out.length - 1]
    if (prev && TEXTUAL.has(e.type) && prev.type === e.type && 'text' in prev && 'text' in e) {
      out[out.length - 1] = { ...prev, text: prev.text + e.text }
    } else {
      out.push(e)
    }
  }
  return out
}

/* ── shared surfaces (same card language as the chat's ToolDetail) ────────── */

function Card({ error, children }: { error?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[10px] border bg-card',
        error ? 'border-destructive/30' : 'border-border'
      )}
    >
      {children}
    </div>
  )
}

function CardHead({
  icon,
  primary,
  mono,
  chip,
  meta,
  error
}: {
  icon: React.ReactNode
  primary: string
  mono?: boolean
  chip?: string
  meta?: string
  error?: boolean
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <span
        className={cn(
          'shrink-0 [&>svg]:size-3.5',
          error ? 'text-destructive' : 'text-muted-foreground/60'
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'min-w-0 truncate text-xs font-medium',
          mono && 'font-mono',
          error ? 'text-destructive' : 'text-foreground'
        )}
        title={primary}
      >
        {primary}
      </span>
      {chip && (
        <span className="shrink-0 rounded bg-foreground/[0.06] px-1.5 py-px text-[10px] text-muted-foreground">
          {chip}
        </span>
      )}
      {meta && (
        <span className="ml-auto shrink-0 pl-3 text-[11px] tabular-nums text-muted-foreground/70">
          {meta}
        </span>
      )}
    </div>
  )
}

function MonoBody({ children, dim }: { children: string; dim?: boolean }): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-48 overflow-auto border-t border-border whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed',
        dim && 'text-muted-foreground'
      )}
    >
      {children}
    </pre>
  )
}

/** A card whose body expands on demand (thoughts, stderr, tool input). */
function CollapsibleCard({
  head,
  body,
  dim,
  error
}: {
  head: Omit<Parameters<typeof CardHead>[0], 'icon'> & { icon: React.ReactNode }
  body: string
  dim?: boolean
  error?: boolean
}): React.JSX.Element {
  return (
    <Card error={error}>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center text-left">
          <span className="min-w-0 flex-1">
            <CardHead {...head} />
          </span>
          <IconChevronRight className="mr-2.5 size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-data-[panel-open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <MonoBody dim={dim}>{body}</MonoBody>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

/* ── event rows ───────────────────────────────────────────────────────────── */

function TranscriptRow({ event: e }: { event: TranscriptEvent }): React.JSX.Element | null {
  const { t } = useTranslation()
  switch (e.type) {
    case 'meta':
      return (
        <Card>
          <CardHead
            icon={<IconRobot />}
            primary={e.backend}
            chip={e.readOnly ? t('panel.transcriptReadOnly') : undefined}
            meta={time(e.t)}
          />
          <div
            className="truncate border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
            title={e.command}
          >
            {e.command}
          </div>
        </Card>
      )
    case 'message':
      return (
        <div className="px-0.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {e.text.trim()}
        </div>
      )
    case 'thought':
      return (
        <CollapsibleCard
          head={{ icon: <IconBrain />, primary: t('panel.transcriptThought'), meta: time(e.t) }}
          body={e.text.trim()}
          dim
        />
      )
    case 'stderr':
      return (
        <CollapsibleCard
          head={{ icon: <IconTerminal2 />, primary: 'stderr', meta: time(e.t) }}
          body={e.text.trim()}
          dim
        />
      )
    case 'tool':
      return e.input ? (
        <CollapsibleCard
          head={{
            icon: <IconTool />,
            primary: e.title,
            mono: true,
            chip: e.kind,
            meta: time(e.t)
          }}
          body={e.input}
        />
      ) : (
        <Card>
          <CardHead icon={<IconTool />} primary={e.title} mono chip={e.kind} meta={time(e.t)} />
        </Card>
      )
    case 'tool_failed':
      return (
        <Card error>
          <CardHead icon={<IconAlertTriangle />} primary={e.title} mono error meta={time(e.t)} />
          {e.output && <MonoBody dim>{e.output}</MonoBody>}
        </Card>
      )
    case 'plan':
      return (
        <Card>
          <CardHead icon={<IconChecklist />} primary={t('panel.transcriptPlan')} meta={time(e.t)} />
          <ul className="space-y-0.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {e.entries.map((entry, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-muted-foreground/50">·</span>
                <span className="min-w-0">{entry}</span>
              </li>
            ))}
          </ul>
        </Card>
      )
    case 'permission':
      return (
        <div
          className={cn(
            'flex items-center gap-2 rounded-[10px] border px-3 py-1.5 text-xs',
            e.allowed
              ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
              : 'border-destructive/30 bg-destructive/5 text-destructive'
          )}
        >
          {e.allowed ? (
            <IconLockOpen className="size-3.5 shrink-0" />
          ) : (
            <IconLock className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate" title={e.locations.join('\n')}>
            {e.allowed ? t('panel.transcriptAllowed') : t('panel.transcriptDenied')} · {e.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums opacity-70">{time(e.t)}</span>
        </div>
      )
    case 'config_error':
      return (
        <div className="flex items-center gap-2 rounded-[10px] border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <IconAlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{e.text}</span>
        </div>
      )
    case 'outcome': {
      const ok = e.outcome === 'completed'
      return (
        <div
          className={cn(
            'flex items-center gap-2 rounded-[10px] border px-3 py-2 text-xs font-medium',
            ok
              ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
              : 'border-destructive/30 bg-destructive/5 text-destructive'
          )}
        >
          {ok ? (
            <IconCircleCheck className="size-4 shrink-0" />
          ) : (
            <IconCircleX className="size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            {t('panel.transcriptOutcome', { outcome: e.outcome })}
            {e.error && <span className="block font-normal opacity-80">{e.error}</span>}
          </span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums opacity-70">
            {time(e.t)}
          </span>
        </div>
      )
    }
    default:
      return null
  }
}
