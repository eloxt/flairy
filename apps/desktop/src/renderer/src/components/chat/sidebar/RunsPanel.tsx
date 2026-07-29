import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconExternalLink, IconFileText, IconPlayerStop } from '@tabler/icons-react'
import type { WorkerRun, WorkerRunStatus } from '@shared/ipc'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RunTranscriptSheet } from './RunTranscriptSheet'

/**
 * Worker runs for the active project session: one card per dispatch_task run —
 * status, issue, live activity tail while running, PR link when opened, abort.
 * Fed by an initial list + WorkerRunChanged pushes (both carry the merged tail).
 */
export function RunsPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<WorkerRun[]>([])

  useEffect(() => {
    let alive = true
    void window.api.listWorkerRuns(sessionId).then((rs) => {
      if (alive) setRuns(rs)
    })
    const off = window.api.onWorkerRunChanged((run) => {
      if (run.sessionId !== sessionId) return
      setRuns((cur) => {
        const idx = cur.findIndex((r) => r.id === run.id)
        if (idx === -1) return [run, ...cur]
        const next = [...cur]
        next[idx] = run
        return next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [sessionId])

  if (runs.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('panel.runsEmpty')}</p>
    )
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto px-3 py-3">
      {runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  )
}

const LIVE: WorkerRunStatus[] = ['preparing', 'running', 'pushing']

function RunCard({ run }: { run: WorkerRun }): React.JSX.Element {
  const { t } = useTranslation()
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const live = LIVE.includes(run.status)

  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-2.5">
      <div className="flex items-center gap-2">
        <StatusChip status={run.status} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {run.kind === 'review' && run.prNumber != null
            ? t('panel.runReviewLabel', { pr: run.prNumber })
            : run.issueNumber != null
              ? `#${run.issueNumber}`
              : run.id.slice(0, 8)}
          <span className="ml-1.5 font-normal text-muted-foreground">{run.backend}</span>
        </span>
        {live && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t('panel.runAbort')}
            onClick={() => void window.api.abortWorkerRun(run.id)}
          >
            <IconPlayerStop className="size-3.5" />
          </Button>
        )}
        {run.hasTranscript && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t('panel.runOpenLog')}
            onClick={() => setTranscriptOpen(true)}
          >
            <IconFileText className="size-3.5" />
          </Button>
        )}
        {run.prUrl && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={t('panel.runOpenPr')}
            onClick={() => void window.api.openExternal(run.prUrl!)}
          >
            <IconExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
      {live && run.tail && (
        <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-foreground/[0.04] p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {run.tail}
        </pre>
      )}
      {!live && run.summary && (
        <p className="mt-1.5 line-clamp-4 text-[11px] leading-relaxed text-muted-foreground">
          {run.summary}
        </p>
      )}
      {/* Keep the sheet mounted while open even if hasTranscript flickers on a
          partial run event — unmounting would slam it shut mid-read. */}
      {(run.hasTranscript || transcriptOpen) && (
        <RunTranscriptSheet run={run} open={transcriptOpen} onOpenChange={setTranscriptOpen} />
      )}
    </div>
  )
}

function StatusChip({ status }: { status: WorkerRunStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const styles: Record<WorkerRunStatus, string> = {
    preparing: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    running: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    pushing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    pr_opened: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    merged: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    reviewed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    failed: 'bg-destructive/15 text-destructive',
    cancelled: 'bg-foreground/10 text-muted-foreground',
    timeout: 'bg-destructive/15 text-destructive'
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium',
        styles[status]
      )}
    >
      {t(`panel.runStatus.${status}`)}
      {(status === 'preparing' || status === 'running' || status === 'pushing') && (
        <span className="ml-0.5 inline-block animate-pulse">·</span>
      )}
    </span>
  )
}
