import type { AgentStreamEvent } from '@shared/ipc'

/**
 * Which front-end authored a given agent turn.
 *
 * One `AgentService` is shared per `sessionId`, so a session can be driven by both
 * the desktop window and (later) a Telegram chat. Modeling the front-end-specific
 * concerns (event sink, approval/question channel, permission posture) as
 * session-global state is ambiguous the moment two front-ends touch one session —
 * so instead every turn carries an origin, and the sink / interaction channel /
 * gate decision follow the turn's origin rather than the session.
 *
 * This is an internal main-process value: it is stripped from the event envelope
 * before it crosses IPC to the renderer (the renderer never sees it).
 */
export type TurnOrigin =
  | { kind: 'desktop' }
  | { kind: 'telegram'; chatId: string; threadKey: number /* message_thread_id ?? 0 */ }

/** The default origin: the desktop window. Every turn starts here unless told otherwise. */
export const DESKTOP_ORIGIN: TurnOrigin = { kind: 'desktop' }

/**
 * The envelope an AgentService emits onto AgentManager's bus: the renderer-facing
 * `{ sessionId, event }` plus the internal-only `origin` tag that selects which
 * front-end a subscriber should act on. The default window sink strips `origin`
 * before the payload crosses IPC (the renderer never sees it).
 */
export interface AgentEventInternalEnvelope {
  sessionId: string
  event: AgentStreamEvent
  origin: TurnOrigin
}
