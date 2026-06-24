import { randomUUID } from 'node:crypto'
import { Notification, type BrowserWindow } from 'electron'
import { IPC, type QuestionAnswer, type QuestionRequestPayload } from '@shared/ipc'
import { t } from '../locale'
import { getMainWindow } from '../windows'

/**
 * Bridges the agent's blocking `ask` tool to an async user reply in the renderer.
 * Mirrors ApprovalRegistry (see ./approvals): the tool calls request(), which
 * sends a question card to the renderer and returns a Promise that settles when
 * the user submits (IPC.AgentQuestionResponse -> resolve()).
 *
 * Unlike approvals there is NO inFlight coalescing: each `ask` call is a distinct
 * user-facing question and must never be deduped onto another's card.
 *
 * A cancelled/aborted question (session deleted or run aborted) resolves to
 * `null`; the tool maps that to a thrown cancellation so pi returns a tool error.
 */
class QuestionRegistry {
  // questionId -> how to settle it, plus the owning session so we can reject
  // everything for a session when it's deleted/aborted mid-question.
  private pending = new Map<
    string,
    { resolve: (answers: QuestionAnswer[] | null) => void; sessionId: string }
  >()

  request(
    payload: Omit<QuestionRequestPayload, 'questionId'>
  ): Promise<QuestionAnswer[] | null> {
    // Resolve the live main window at request time so the card reaches the
    // renderer even after a window close→reopen. With no window, settle as
    // cancelled (null) — the `ask` tool maps that to a thrown cancellation.
    const win = getMainWindow()
    if (!win) return Promise.resolve(null)

    const questionId = randomUUID()
    return new Promise<QuestionAnswer[] | null>((resolve) => {
      this.pending.set(questionId, { resolve, sessionId: payload.sessionId })
      win.webContents.send(IPC.QuestionRequest, { questionId, ...payload })
      this.notify(win, payload)
    })
  }

  /**
   * Raise a desktop notification when Flairy isn't focused so the user knows
   * their input is needed — the inline question card is non-blocking and an
   * out-of-focus user would otherwise miss it. Silent when already focused.
   * Clicking the notification brings the window forward.
   */
  private notify(win: BrowserWindow, payload: Omit<QuestionRequestPayload, 'questionId'>): void {
    if (!Notification.isSupported() || win.isDestroyed() || win.isFocused()) return
    const n = new Notification({ title: t('questionNotificationTitle'), body: payload.reason })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  }

  resolve(questionId: string, answers: QuestionAnswer[] | null): void {
    const entry = this.pending.get(questionId)
    if (entry) {
      this.pending.delete(questionId)
      entry.resolve(answers)
    }
  }

  /** Cancel everything still pending (e.g. on session abort/close). */
  rejectAll(): void {
    for (const entry of this.pending.values()) entry.resolve(null)
    this.pending.clear()
  }

  /**
   * Cancel and clear every pending question belonging to one session — used when
   * the session is deleted while a question is open, so the blocked Promise
   * settles and no map entries leak.
   */
  rejectSession(sessionId: string): void {
    for (const [questionId, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(questionId)
      entry.resolve(null)
    }
  }
}

export const questions = new QuestionRegistry()
