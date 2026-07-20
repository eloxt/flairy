import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toolDisplayKey } from '@/lib/tool-display'
import { useChat } from '@/store/chat-store'
import type { ApprovalRequestPayload } from '@shared/ipc'

/**
 * Tool-approval card, hosted on the composer's outer shell like the question
 * and plan cards (the decision is the user's next action, so it belongs where
 * their hands already are — not in the message stream). Shows the head of the
 * approval queue; parallel calls wait their turn behind a count hint and slide
 * in one by one as decisions land. Raw arguments stay tucked behind a
 * collapsible "Details" section so non-technical users never see JSON by
 * default. The card leaves when the store drops the request from
 * `approvalQueue` on respond.
 */
export function ApprovalCard({
  payload,
  queuedCount
}: {
  payload: ApprovalRequestPayload
  /** Approvals still waiting behind this one (>0 shows the queue hint). */
  queuedCount: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const respondApproval = useChat((s) => s.respondApproval)
  const [showDetails, setShowDetails] = useState(false)
  const id = payload.approvalId

  return (
    <div className="px-4 pb-3.5 pt-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldQuestion className="size-3.5 shrink-0" strokeWidth={2} />
        <span className="font-medium text-foreground">{t('approval.allowThisAction')}</span>
        <div className="flex-1" />
        {queuedCount > 0 && (
          <span className="tabular-nums">{t('approval.queued', { count: queuedCount })}</span>
        )}
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-foreground">
        {t('approval.wantsTo', { tool: t(toolDisplayKey(payload.toolName)) })}
      </p>

      <div className="mt-1">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', showDetails && 'rotate-180')}
            strokeWidth={2}
          />
          {t('approval.details')}
        </button>
        {showDetails && (
          <pre className="mt-2 max-h-44 overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(payload.args, null, 2)}
          </pre>
        )}
      </div>

      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-3"
          onClick={() => respondApproval(id, false)}
        >
          {t('approval.deny')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-3"
          onClick={() => respondApproval(id, true, 'once')}
        >
          {t('approval.allowOnce')}
        </Button>
        <Button size="sm" className="rounded-full px-4" onClick={() => respondApproval(id, true, 'session')}>
          {t('approval.allowSession')}
        </Button>
      </div>
    </div>
  )
}
