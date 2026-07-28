import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconAlertTriangle,
  IconFileDescription,
  IconLock,
  IconLockOpen,
  IconTerminal2,
  IconTool
} from '@tabler/icons-react'
import type { TranscriptEvent, WorkerRun } from '@shared/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
 * and the outcome — rendered as a timeline instead of a raw log file. While
 * the run is live the sheet re-reads the transcript on a short interval.
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
  const [events, setEvents] = useState<TranscriptEvent[]>([])
  const [truncated, setTruncated] = useState(false)

  const live = ['preparing', 'running', 'pushing'].includes(run.status)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = (): void => {
      void window.api.readWorkerRunTranscript(run.id).then((r) => {
        if (!alive) return
        setEvents(r.events)
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
      <SheetContent side="right" className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('panel.transcriptTitle', { run: title })}</SheetTitle>
          <SheetDescription>
            {run.backend} · {t(`panel.runStatus.${run.status}`)}
            {truncated ? ` · ${t('panel.transcriptTruncated')}` : ''}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
          {events.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t('panel.transcriptEmpty')}
            </p>
          )}
          {events.map((e, i) => (
            <TranscriptRow key={i} event={e} />
          ))}
        </div>
        <div className="border-t border-border/60 px-4 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => void window.api.openWorkerRunTranscript(run.id)}
          >
            <IconFileDescription className="mr-1 size-3.5" />
            {t('panel.transcriptOpenRaw')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

const time = (t: number): string => new Date(t).toLocaleTimeString()

function TranscriptRow({ event: e }: { event: TranscriptEvent }): React.JSX.Element | null {
  const { t } = useTranslation()
  switch (e.type) {
    case 'meta':
      return (
        <div className="rounded-md bg-foreground/[0.04] p-2 text-[11px] leading-relaxed text-muted-foreground">
          <div className="font-medium text-foreground/80">
            {e.backend}
            {e.readOnly && (
              <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[10px] text-amber-600 dark:text-amber-400">
                {t('panel.transcriptReadOnly')}
              </span>
            )}
            <span className="ml-2 font-normal">{time(e.t)}</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px]" title={e.command}>
            {e.command}
          </div>
        </div>
      )
    case 'message':
      return (
        <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{e.text.trim()}</div>
      )
    case 'thought':
      return (
        <details className="text-[11.5px] text-muted-foreground/80">
          <summary className="cursor-pointer select-none text-[11px] italic">
            {t('panel.transcriptThought')}
          </summary>
          <div className="mt-1 whitespace-pre-wrap pl-2">{e.text.trim()}</div>
        </details>
      )
    case 'tool':
      return (
        <div className="rounded-md border border-border/60 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <IconTool className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium" title={e.title}>
              {e.title}
            </span>
            {e.kind && (
              <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-px text-[10px] text-muted-foreground">
                {e.kind}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-muted-foreground">{time(e.t)}</span>
          </div>
          {e.input && (
            <details className="mt-1">
              <summary className="cursor-pointer select-none text-[10px] text-muted-foreground">
                {t('panel.transcriptInput')}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-foreground/[0.04] p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                {e.input}
              </pre>
            </details>
          )}
        </div>
      )
    case 'tool_failed':
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11.5px]">
          <div className="flex items-center gap-1.5">
            <IconAlertTriangle className="size-3 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-destructive">{e.title}</span>
          </div>
          {e.output && (
            <pre className="mt-1 max-h-32 overflow-auto font-mono text-[10px] whitespace-pre-wrap text-muted-foreground">
              {e.output}
            </pre>
          )}
        </div>
      )
    case 'plan':
      return (
        <div className="rounded-md bg-foreground/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground">
          {e.entries.map((entry, i) => (
            <div key={i}>· {entry}</div>
          ))}
        </div>
      )
    case 'permission':
      return (
        <div
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]',
            e.allowed
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/10 text-destructive'
          )}
        >
          {e.allowed ? (
            <IconLockOpen className="size-3 shrink-0" />
          ) : (
            <IconLock className="size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate" title={e.locations.join('\n')}>
            {e.allowed ? t('panel.transcriptAllowed') : t('panel.transcriptDenied')} · {e.title}
          </span>
        </div>
      )
    case 'stderr':
      return (
        <details className="text-[10.5px] text-muted-foreground/70">
          <summary className="flex cursor-pointer items-center gap-1 select-none text-[10.5px]">
            <IconTerminal2 className="size-3" /> stderr
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap">{e.text.trim()}</pre>
        </details>
      )
    case 'config_error':
      return <div className="text-[11px] text-amber-600 dark:text-amber-400">⚠ {e.text}</div>
    case 'outcome':
      return (
        <div
          className={cn(
            'rounded-md px-2 py-1.5 text-[11.5px] font-medium',
            e.outcome === 'completed'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/10 text-destructive'
          )}
        >
          {t('panel.transcriptOutcome', { outcome: e.outcome })}
          {e.error && <div className="mt-0.5 font-normal">{e.error}</div>}
        </div>
      )
    default:
      return null
  }
}
