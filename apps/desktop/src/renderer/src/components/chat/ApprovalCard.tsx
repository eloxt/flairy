import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toolDisplayKey } from '@/lib/tool-display'
import { useChat } from '@/store/chat-store'
import type { ApprovalRequestPayload } from '@shared/ipc'

/**
 * Inline, non-blocking approval request rendered in the message stream.
 * Replaces the old full-screen modal: it flows with the conversation (just
 * above the composer) so the user can keep scrolling and reading context
 * instead of being interrupted. Raw arguments are tucked behind a collapsible
 * "Details" section so non-technical users never see JSON by default.
 */
export function ApprovalCard({ payload }: { payload: ApprovalRequestPayload }): React.JSX.Element {
  const { t } = useTranslation()
  const respondApproval = useChat((s) => s.respondApproval)
  const [showDetails, setShowDetails] = useState(false)
  const id = payload.approvalId

  return (
    <div className="animate-message-in mx-auto w-full max-w-3xl px-6 py-2.5">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
            <ShieldQuestion className="size-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight">{t('approval.allowThisAction')}</h3>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {t('approval.wantsTo', { tool: t(toolDisplayKey(payload.toolName)) })}
            </p>
          </div>
        </div>

        <div className="px-4 pb-1">
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
            <pre className="mt-2 max-h-44 overflow-auto rounded-lg border border-border bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(payload.args, null, 2)}
            </pre>
          )}
        </div>

        <div className="mt-2 flex justify-end gap-2 border-t border-border/70 bg-secondary/30 px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => respondApproval(id, false)}>
            {t('approval.deny')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => respondApproval(id, true, 'once')}>
            {t('approval.allowOnce')}
          </Button>
          <Button size="sm" onClick={() => respondApproval(id, true, 'session')}>
            {t('approval.allowSession')}
          </Button>
        </div>
      </div>
    </div>
  )
}
