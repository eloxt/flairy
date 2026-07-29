/**
 * Machine-injected user turns. Worker completion reports (acp/dispatch.ts)
 * enter a session as `user` messages via AgentManager.submit — that is what
 * wakes the orchestrator and survives idle eviction — but they are not
 * something the user typed, so the chat view must not render them as user
 * bubbles. Each carries one of these prefixes; the renderer detects it (live
 * stream and replay alike) and shows a system event row instead.
 *
 * The github prefix belonged to the removed GitHub poller (merge state is now
 * relayed by the user); it stays here so historical transcripts keep rendering
 * as event rows.
 */
export const WORKER_REPORT_PREFIX = '[worker report]'
export const GITHUB_EVENT_PREFIX = '[github event]'

export type InjectedEventKind = 'worker' | 'github'

/**
 * Detect an injected event message; returns its kind and the body with the
 * prefix stripped, or null for a genuine user message.
 */
export function parseInjectedEvent(
  text: string
): { kind: InjectedEventKind; body: string } | null {
  if (text.startsWith(WORKER_REPORT_PREFIX))
    return { kind: 'worker', body: text.slice(WORKER_REPORT_PREFIX.length).trim() }
  if (text.startsWith(GITHUB_EVENT_PREFIX))
    return { kind: 'github', body: text.slice(GITHUB_EVENT_PREFIX.length).trim() }
  return null
}
