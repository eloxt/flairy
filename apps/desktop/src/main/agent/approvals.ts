import { randomUUID } from 'node:crypto'
import { Notification, type BrowserWindow } from 'electron'
import { IPC, type ApprovalRequestPayload, type ApprovalScope } from '@shared/ipc'
import { t } from '../locale'
import { getMainWindow } from '../windows'

/** A settled approval decision: whether to run, and how long to remember it. */
export interface ApprovalDecision {
  approved: boolean
  scope: ApprovalScope
}

const DENIED: ApprovalDecision = { approved: false, scope: 'once' }

/**
 * Bridges pi-agent-core's synchronous-looking `beforeToolCall` hook to an async
 * user decision in the renderer.
 *
 * Flow:
 *   1. main calls request() -> sends 'agent:approval-request' to renderer, returns a Promise
 *   2. renderer shows a dialog, user clicks -> invoke('agent:approval-response')
 *   3. handler calls resolve(approvalId, decision) -> the awaited Promise settles
 *
 * Concurrent calls for the SAME (session, tool) are coalesced onto one dialog:
 * pi can fire parallel tool calls, and we don't want two prompts for the same
 * tool racing. The first opens the dialog; the rest await its decision.
 */
class ApprovalRegistry {
  // approvalId -> how to settle it, plus the owning session and inFlight key so
  // we can reject everything for a session (e.g. when it's deleted mid-prompt).
  private pending = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; sessionId: string; key: string }
  >()
  private inFlight = new Map<string, Promise<ApprovalDecision>>()

  request(payload: Omit<ApprovalRequestPayload, 'approvalId'>): Promise<ApprovalDecision> {
    const key = `${payload.sessionId}:${payload.toolName}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    // Resolve the live main window at request time (not a captured reference) so
    // the prompt reaches the renderer even after a window close→reopen. With no
    // window there's nobody to ask — deny rather than hang the tool call.
    const win = getMainWindow()
    if (!win) return Promise.resolve(DENIED)

    const approvalId = randomUUID()
    const decision = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(approvalId, { resolve, sessionId: payload.sessionId, key })
      win.webContents.send(IPC.ApprovalRequest, { approvalId, ...payload })
      this.notify(win, payload)
    }).finally(() => this.inFlight.delete(key))

    this.inFlight.set(key, decision)
    return decision
  }

  /**
   * Raise a desktop notification so the user knows their input is needed when
   * Flairy isn't the focused window — the inline approval card is intentionally
   * non-blocking, so an out-of-focus user would otherwise miss it. Stays silent
   * when the window is already focused (the card is right there). Clicking the
   * notification brings the window forward.
   */
  private notify(win: BrowserWindow, payload: Omit<ApprovalRequestPayload, 'approvalId'>): void {
    if (!Notification.isSupported() || win.isDestroyed() || win.isFocused()) return
    const n = new Notification({ title: t('notificationTitle'), body: payload.reason })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  }

  resolve(approvalId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(approvalId)
    if (entry) {
      this.pending.delete(approvalId)
      entry.resolve(decision)
    }
  }

  /** Deny everything still pending (e.g. on session abort/close). */
  rejectAll(): void {
    for (const entry of this.pending.values()) entry.resolve(DENIED)
    this.pending.clear()
  }

  /**
   * Deny and clear every pending approval belonging to one session — used when
   * the session is deleted while a tool call is awaiting confirmation, so the
   * blocked Promise settles and no map entries leak.
   */
  rejectSession(sessionId: string): void {
    for (const [approvalId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(approvalId)
      this.inFlight.delete(entry.key)
      entry.resolve(DENIED)
    }
  }
}

export const approvals = new ApprovalRegistry()
