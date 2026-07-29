/**
 * Machine-injected user turns. Worker completion reports (acp/dispatch.ts)
 * enter a session as `user` messages via AgentManager.submit — that is what
 * wakes the orchestrator and survives idle eviction — but they are not
 * something the user typed, so the chat view must not render them as user
 * bubbles. Each carries this prefix; the renderer detects it (live stream and
 * replay alike) and shows a system event row instead.
 */
export const WORKER_REPORT_PREFIX = '[worker report]'

/**
 * Scheduled-task trigger messages (schedule/scheduler.ts) enter the task's
 * session the same way: a machine-authored `user` message carrying the task
 * instruction, rendered as a quiet system row rather than a user bubble.
 */
export const SCHEDULE_RUN_PREFIX = '[scheduled run]'

export type InjectedEventKind = 'worker' | 'schedule'

/**
 * Detect an injected event message; returns its kind and the body with the
 * prefix stripped, or null for a genuine user message.
 */
export function parseInjectedEvent(
  text: string
): { kind: InjectedEventKind; body: string } | null {
  if (text.startsWith(WORKER_REPORT_PREFIX))
    return { kind: 'worker', body: text.slice(WORKER_REPORT_PREFIX.length).trim() }
  if (text.startsWith(SCHEDULE_RUN_PREFIX))
    return { kind: 'schedule', body: text.slice(SCHEDULE_RUN_PREFIX.length).trim() }
  return null
}
