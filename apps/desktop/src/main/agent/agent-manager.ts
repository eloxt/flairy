import { EventEmitter } from 'node:events'
import type { PermissionMode } from '@shared/ipc'
import type { ServerClient } from '../sync/server-client'
import type { McpManager } from './mcp'
import { AgentService } from './agent-service'
import { getSession, loadMessages, deleteTelegramThread } from '../store/db'
import type { TurnOrigin } from './turn-origin'
import { desktopChannel, type InteractionChannel } from './interaction'

/**
 * Process-level owner of the per-session `AgentService` instances (lifted out of
 * the IPC layer). It is the single seam every front-end goes through: the desktop
 * IPC handlers, and later the Telegram front-end, both drive sessions via the
 * methods here rather than reaching for a private map.
 *
 * Owning the services map centrally also lets cross-cutting concerns live in one
 * place: the global desktop approval posture, a fixed-channel event bus the
 * services emit onto (commit R-B), and a centralized interaction-rejection fan-out
 * so a session abort/dispose/delete settles every pending approval/question — and
 * later the Telegram channel — instead of leaving a blocked promise to hang.
 */
export class AgentManager {
  /** Live agent services keyed by sessionId. */
  private services = new Map<string, AgentService>()

  /**
   * The GLOBAL desktop tool-approval posture. One value for every session (not
   * per-session); `getOrCreate` applies it to each new service and
   * `setDesktopPermissionMode` fans a change out to the live ones. In-memory:
   * resets to the safe `'ask'` on restart.
   */
  private desktopPermissionMode: PermissionMode = 'ask'

  /**
   * Single fixed-channel event bus the AgentServices emit their (origin-tagged)
   * event envelopes onto. The channel name is `'event'` — deliberately NOT Node's
   * special `'error'` channel, which would throw if it ever had no listener. The
   * IPC layer registers the default window-forwarding sink; the Telegram sink
   * (commit 5) subscribes the same channel and filters by its owned-session set.
   * Declared here from birth; the emit/subscribe wiring lands in commit R-B.
   */
  readonly events = new EventEmitter()

  /**
   * The Telegram interaction channel, once registered (commit 5). When present,
   * `channelFor` routes telegram-origin turns to it and `rejectInteractions` also
   * settles its pending promises; until then, telegram-origin turns fall back to
   * the desktop channel.
   */
  private telegramChannel: InteractionChannel | undefined

  constructor(
    private readonly server: ServerClient,
    private readonly mcp: McpManager
  ) {}

  /**
   * The live service for a session, created on first use. `origin` is accepted for
   * the per-turn-origin routing wired up in later commits; it does not affect
   * creation today (desktop default). Throws "Unknown session" if no row exists —
   * the caller surfaces that as a visible error.
   */
  getOrCreate(sessionId: string, _origin?: TurnOrigin): AgentService {
    let svc = this.services.get(sessionId)
    if (!svc) {
      const meta = getSession(sessionId)
      if (!meta) throw new Error(`Unknown session: ${sessionId}`)
      svc = new AgentService({
        sessionId,
        cwd: meta.cwd,
        server: this.server,
        mcp: this.mcp,
        messages: loadMessages(sessionId),
        // Reach the centralized interaction fan-out from abort()/dispose() without
        // a circular dependency: the service calls this hook, the manager settles
        // approvals + questions (+ the Telegram channel, commit 5).
        onRejectInteractions: (id) => this.rejectInteractions(id),
        // Stream the service's (origin-tagged) event envelopes onto the shared bus
        // so every registered sink (the window forwarder, and later the Telegram
        // subscriber) sees them.
        emitEvent: (env) => this.events.emit('event', env),
        // Resolve the interaction channel (approval + ask) by the turn's origin at
        // call time, so the same session prompts the front-end that authored the
        // turn.
        resolveChannel: (origin) => this.channelFor(origin),
        // Mirror a newly generated session title to any front-end holding the
        // session elsewhere (e.g. rename the Telegram topic). No-op for desktop.
        onTitleChanged: (id, title) => this.telegramChannel?.onTitleChanged?.(id, title)
      })
      // Apply the global desktop approval posture to the fresh service.
      svc.setPermissionMode(this.desktopPermissionMode)
      this.services.set(sessionId, svc)
    }
    return svc
  }

  /** The live service for a session, or undefined if none is running. */
  get(sessionId: string): AgentService | undefined {
    return this.services.get(sessionId)
  }

  /**
   * Tear one session's service down (dispose + drop from the map). Also removes
   * any Telegram thread mapping for the session, so a deleted session can't leave
   * an orphaned (chat, thread) → session row behind (a later Telegram message then
   * self-heals into a fresh session rather than hitting the UNIQUE constraint).
   * Only ever called on session removal (delete / remote-delete), never on abort.
   */
  delete(sessionId: string, deleteTopic = false): void {
    this.services.get(sessionId)?.dispose()
    this.services.delete(sessionId)
    // Only a TRUE deletion (not a `/new` reset, which reuses this to swap runtimes)
    // mirrors to Telegram by deleting the mapped topic — BEFORE dropping the mapping
    // so the channel can still resolve it. Best-effort / no-op off-Telegram.
    if (deleteTopic) this.telegramChannel?.onSessionDeleted?.(sessionId)
    deleteTelegramThread(sessionId)
  }

  /**
   * Tear down every live service — aborts any in-flight turn and persists it
   * (better-sqlite3 writes synchronously, so this is safe inside `before-quit`).
   * Used on logout and app quit so MCP/agent work doesn't leak past exit.
   */
  disposeAll(): void {
    for (const svc of this.services.values()) svc.dispose()
    this.services.clear()
  }

  /** Iterate the live services (e.g. for a global posture fan-out). */
  values(): IterableIterator<AgentService> {
    return this.services.values()
  }

  /** Run `fn` for each live service. */
  forEach(fn: (svc: AgentService) => void): void {
    this.services.forEach(fn)
  }

  /**
   * Set the GLOBAL desktop tool-approval posture: remember it for sessions created
   * later, and push it to every live session so the change takes effect at once.
   */
  setDesktopPermissionMode(mode: PermissionMode): void {
    this.desktopPermissionMode = mode
    for (const svc of this.services.values()) svc.setPermissionMode(mode)
  }

  /**
   * Settle every pending interaction for a session across all channels: desktop
   * approvals + questions, plus the Telegram channel when registered. Invoked from
   * abort / dispose (via the injected hook) and from SessionDelete / remote-delete
   * in the IPC layer, so a blocked tool-approval or `ask` promise can never hang.
   * Idempotent — calling it when nothing is pending is a no-op.
   */
  rejectInteractions(sessionId: string): void {
    desktopChannel.rejectSession(sessionId)
    this.telegramChannel?.rejectSession(sessionId)
  }

  /**
   * Resolve the interaction channel (approval + `ask`) for a turn's origin:
   * desktop turns use the desktop channel; telegram turns use the registered
   * Telegram channel, falling back to the desktop channel until it is registered.
   */
  channelFor(origin: TurnOrigin): InteractionChannel {
    if (origin.kind === 'telegram' && this.telegramChannel) return this.telegramChannel
    return desktopChannel
  }

  /**
   * Register the Telegram interaction channel (commit 5). It then receives
   * telegram-origin approval/`ask` round-trips and joins the `rejectInteractions`
   * fan-out.
   */
  registerTelegramChannel(channel: InteractionChannel): void {
    this.telegramChannel = channel
  }
}
