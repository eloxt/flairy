import type { AskQuestion, QuestionAnswer } from '@shared/ipc'
import { approvals, type ApprovalDecision } from './approvals'
import { questions } from './questions'
import type { TurnOrigin } from './turn-origin'

/**
 * The user-interaction surface a turn needs: confirm a dangerous tool, ask the
 * user a structured question, and settle anything still pending. Resolved per
 * turn origin (desktop window vs. Telegram chat) so a session driven by both
 * front-ends prompts the front-end that authored the turn.
 *
 * The return shapes preserve the full desktop semantics so nothing regresses:
 *   - `requestApproval` returns the whole `ApprovalDecision`, including `scope`
 *     (so "Allow for this session" still works).
 *   - `askQuestion` returns the structured `QuestionAnswer[]`, or `null` for a
 *     cancellation (the `ask` tool maps `null` to a thrown "User cancelled").
 */
export interface InteractionChannel {
  requestApproval(req: {
    sessionId: string
    origin: TurnOrigin
    toolName: string
    args: unknown
    /** The session's working directory, so a remote approval card can show it. */
    cwd: string
  }): Promise<ApprovalDecision>
  askQuestion(req: {
    sessionId: string
    origin: TurnOrigin
    questions: AskQuestion[]
  }): Promise<QuestionAnswer[] | null>
  rejectSession(sessionId: string): void
  /**
   * Optional: the session's auto-generated title changed. A front-end that mirrors
   * the session elsewhere (e.g. a Telegram topic) may rename it. No-op for desktop.
   */
  onTitleChanged?(sessionId: string, title: string): void
  /**
   * Optional: the session was deleted. A front-end mirroring it elsewhere (e.g. a
   * Telegram topic) can delete its copy too. No-op for desktop.
   */
  onSessionDeleted?(sessionId: string): void
}

/**
 * The desktop channel: a thin wrapper over the existing `approvals`/`questions`
 * registries (renderer IPC). Semantics are identical to the pre-refactor inline
 * calls — same `reason` strings, same `ApprovalDecision.scope`, same `null`
 * cancellation — so desktop approvals and `ask` are byte-for-byte unchanged.
 * Stateless (it only forwards to the singletons), so one shared instance is used
 * process-wide.
 */
export class DesktopChannel implements InteractionChannel {
  requestApproval(req: {
    sessionId: string
    origin: TurnOrigin
    toolName: string
    args: unknown
    cwd: string
  }): Promise<ApprovalDecision> {
    // Desktop renders its own approval card in the renderer (which already shows
    // the cwd in the chat header); `cwd` here is for the remote (Telegram) card.
    return approvals.request({
      sessionId: req.sessionId,
      toolName: req.toolName,
      args: req.args,
      reason: `Agent wants to run "${req.toolName}"`
    })
  }

  askQuestion(req: {
    sessionId: string
    origin: TurnOrigin
    questions: AskQuestion[]
  }): Promise<QuestionAnswer[] | null> {
    return questions.request({
      sessionId: req.sessionId,
      questions: req.questions,
      reason: 'Flairy needs your input'
    })
  }

  rejectSession(sessionId: string): void {
    approvals.rejectSession(sessionId)
    questions.rejectSession(sessionId)
  }
}

/** Shared desktop channel instance (stateless; safe to reuse everywhere). */
export const desktopChannel = new DesktopChannel()
