import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { Bot, InlineKeyboard, GrammyError, BotError, type Context } from 'grammy'
import {
  IPC,
  type TelegramStatus,
  type TelegramPairing,
  type AskQuestion,
  type QuestionAnswer,
  type Attachment
} from '@shared/ipc'
import type { ServerClient } from '../sync/server-client'
import type { AgentManager } from '../agent/agent-manager'
import type { InteractionChannel } from '../agent/interaction'
import type { ApprovalDecision } from '../agent/approvals'
import type { TurnOrigin, AgentEventInternalEnvelope } from '../agent/turn-origin'
import { broadcast } from '../windows'
import {
  getTelegramBinding,
  setTelegramBinding,
  clearTelegramBinding,
  getTelegramThread,
  getTelegramThreadBySession,
  createTelegramThread,
  updateTelegramThreadTitle,
  deleteTelegramThread,
  listTelegramSessionIds,
  appendTelegramAudit,
  createSession,
  getSession,
  deleteSession
} from '../store/db'
import {
  setTelegramToken,
  getTelegramToken,
  hasTelegramToken,
  clearTelegramToken
} from '../store/secrets'
import { toTelegramHtml, splitForTelegram, escapeHtml } from './format'

const PAIR_TTL_MS = 5 * 60 * 1000
const PAIR_MAX_ATTEMPTS = 5
const PAIR_LOCKOUT_MS = 10 * 60 * 1000
const TYPING_INTERVAL_MS = 4500
const ARGS_PREVIEW_LIMIT = 200
/** Min gap between live draft pushes — coalesces deltas to near-realtime. */
const STREAM_THROTTLE_MS = 250
/** sendMessageDraft text cap (Bot API: 0-4096 chars); we show the tail if longer. */
const DRAFT_MAX_CHARS = 4096

const DENIED: ApprovalDecision = { approved: false, scope: 'once' }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A pending Telegram approval, keyed by its one-time callback nonce. */
interface ApprovalEntry {
  sessionId: string
  chatId: string
  threadKey: number
  toolName: string
  argsHash: string
  argsPreview: string
  resolve: (decision: ApprovalDecision) => void
}

/** A live `ask` flow over Telegram (one question at a time), keyed by sessionId. */
interface QuestionFlow {
  flowId: string
  sessionId: string
  chatId: string
  threadKey: number
  questions: AskQuestion[]
  index: number
  answers: QuestionAnswer[]
  selected: Set<string>
  awaitingText: boolean
  messageId?: number
  resolve: (answers: QuestionAnswer[] | null) => void
}

/** Per-session "typing…" keepalive handle. */
interface TypingHandle {
  timer: ReturnType<typeof setInterval>
  chatId: string
  threadKey: number
  paused: boolean
}

/**
 * Per-session live-streaming state for the assistant's in-progress message,
 * pushed to Telegram's native draft (sendMessageDraft, Bot API 9.3). One non-zero
 * `draftId` is reused per assistant message so Telegram animates the updates; a
 * fresh id is allocated for each new assistant message in the turn.
 */
interface StreamState {
  chatId: string
  threadKey: number
  /** Current draft id (reused while a single assistant message streams). */
  draftId: number
  /** The current draftId hasn't been claimed by a message yet (turn-initial draft). */
  draftUnclaimed: boolean
  /** Id of the assistant message currently streaming, or undefined between messages. */
  messageId: string | undefined
  /** Accumulated text of the current assistant message. */
  text: string
  /** Last text actually pushed to the draft (skip redundant identical pushes). */
  pushed: string | undefined
  /** Timestamp of the last draft push, for throttling. */
  lastPushAt: number
  /** Skip draft pushes until this time after a 429 (drafts are best-effort). */
  backoffUntil: number
  /** Paused while blocked on an approval (text keeps accumulating, no pushes). */
  paused: boolean
  /** Pending coalesced-flush timer, if any. */
  flushTimer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Drives Flairy's local agent from a single paired Telegram chat.
 *
 * It is a second front-end onto the existing per-session runtime (AgentManager):
 * inbound topic messages submit telegram-origin turns, the final assistant answer
 * is delivered back into the originating topic, and dangerous tools raise an
 * inline approval keyboard that always gates (Telegram-origin turns never take the
 * desktop "Full access" bypass). The bot token lives only in `safeStorage`
 * (main-process) and is never logged — all error logging passes through a
 * redactor that strips the token / `bot<token>` URLs.
 *
 * Implements InteractionChannel so AgentManager routes telegram-origin approvals
 * and `ask` here; registers itself on construction.
 */
export class TelegramManager implements InteractionChannel {
  private bot: Bot | undefined
  private token: string | undefined
  private botUsername: string | undefined
  /** Polling is live. */
  private connected = false
  /** Whether inbound messages are processed (false after the kill switch). */
  private accepting = false
  private lastError: string | undefined
  private lastInboundAt: number | undefined

  /** Sessions this manager drives; seeded from the db on start, kept in memory. */
  private readonly owned = new Set<string>()
  /** Pending tool approvals by one-time nonce. */
  private readonly approvalsPending = new Map<string, ApprovalEntry>()
  /** Live `ask` flows, keyed by sessionId and by flowId. */
  private readonly questionFlows = new Map<string, QuestionFlow>()
  private readonly questionFlowsById = new Map<string, QuestionFlow>()
  /** Per-session typing keepalives. */
  private readonly typing = new Map<string, TypingHandle>()
  /** Per-session live-draft streaming state (Bot API 9.3 sendMessageDraft). */
  private readonly streams = new Map<string, StreamState>()
  /** Monotonic source of non-zero draft ids. */
  private draftSeq = 0

  /** Active pairing code (one at a time, short-lived). */
  private pairing: { code: string; expiresAt: number } | undefined
  /** Per-sender pairing attempt counters + lockout (`last` drives pruning). */
  private readonly pairAttempts = new Map<
    number,
    { count: number; lockedUntil: number; last: number }
  >()

  private workspace: string | undefined

  constructor(
    private readonly server: ServerClient,
    private readonly agents: AgentManager
  ) {
    // Route telegram-origin approvals / `ask` / interaction-rejects here.
    this.agents.registerTelegramChannel(this)
    // Outbound: react to telegram-origin turn boundaries on the shared bus.
    this.agents.events.on('event', (env: AgentEventInternalEnvelope) => {
      try {
        this.onAgentEvent(env)
      } catch (err) {
        this.logError('event sink', err)
      }
    })
  }

  /* ---------------- lifecycle ---------------- */

  /** Start polling if a stored token + an enabled binding exist. Safe to call on boot. */
  maybeAutoStart(): void {
    if (!hasTelegramToken()) return
    if (!getTelegramBinding()?.enabled) return
    const token = getTelegramToken()
    // The bot can start before sign-in; inbound is gated by the config-ready check
    // so an early start never constructs an AgentService without config.
    if (token) void this.start(token)
  }

  /**
   * Renderer "Connect": validate + start FIRST, and persist the token only once
   * polling is live (L5) — so an invalid/typo'd token is never written to
   * safeStorage and can't be auto-started on the next boot.
   */
  async connect(token: string): Promise<TelegramStatus> {
    await this.start(token)
    if (this.connected) setTelegramToken(token)
    return this.getStatus()
  }

  /**
   * Validate the token via getMe (so an invalid token surfaces "could not
   * connect" without starting polling), then long-poll with `drop_pending_updates`
   * so the backlog queued while the app was closed is never replayed.
   */
  async start(token: string): Promise<void> {
    await this.stop()
    this.lastError = undefined
    try {
      const bot = new Bot(token)
      const me = await bot.api.getMe()
      this.botUsername = me.username
      this.token = token
      this.registerHandlers(bot)
      bot.catch((err) => this.onBotError(err))
      for (const id of listTelegramSessionIds()) this.owned.add(id)
      this.bot = bot
      this.accepting = true
      this.connected = true
      void bot
        .start({
          drop_pending_updates: true,
          // MUST request callback_query explicitly: getUpdates without
          // allowed_updates reuses Telegram's *previously cached* list, which can
          // omit callback_query — so inline-button taps (approvals + `ask`) would
          // never arrive while text messages still do. List exactly the update
          // types we handle (message:text + callback_query:data).
          allowed_updates: ['message', 'callback_query'],
          onStart: () => {
            this.connected = true
            this.emitStatus()
          }
        })
        .catch((err) => {
          this.connected = false
          this.lastError = 'Polling stopped — it may be running on another device.'
          this.logError('poll', err)
          this.emitStatus()
        })
      this.emitStatus()
    } catch (err) {
      this.connected = false
      this.lastError = 'Could not connect — please check the bot token.'
      this.logError('start', err)
      this.emitStatus()
    }
  }

  /** Stop polling and clear typing keepalives. Keeps token + binding. */
  async stop(): Promise<void> {
    this.accepting = false
    this.connected = false
    for (const id of [...this.typing.keys()]) this.stopTyping(id)
    for (const id of [...this.streams.keys()]) this.clearStream(id)
    const bot = this.bot
    this.bot = undefined
    if (bot) {
      try {
        await bot.stop()
      } catch (err) {
        this.logError('stop', err)
      }
    }
    this.emitStatus()
  }

  /** Renderer "Disconnect": stop and forget the bot token. Binding is kept. */
  async disconnect(): Promise<TelegramStatus> {
    await this.stop()
    clearTelegramToken()
    this.token = undefined
    this.botUsername = undefined
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Kill switch: abort every owned turn (which fans out `rejectInteractions` and
   * settles pending approvals/questions), stop accepting inbound, and stop
   * polling — but keep the binding so the user can reconnect. NOTE: aborting only
   * reliably stops the *next* gated tool; a tool already executing (e.g. a long
   * shell run) stops only when it observes the abort signal.
   */
  async pause(): Promise<TelegramStatus> {
    for (const id of [...this.owned]) this.agents.get(id)?.abort()
    await this.stop()
    return this.getStatus()
  }

  /** Renderer "Unpair": drop the chat binding and abort owned turns; keep the bot running. */
  async unpair(): Promise<TelegramStatus> {
    for (const id of [...this.owned]) this.agents.get(id)?.abort()
    for (const id of [...this.typing.keys()]) this.stopTyping(id)
    for (const id of [...this.streams.keys()]) this.clearStream(id)
    this.owned.clear()
    clearTelegramBinding()
    this.emitStatus()
    return this.getStatus()
  }

  /* ---------------- status ---------------- */

  /** Build a one-time, high-entropy pairing code the user sends via `/pair`. */
  startPairing(): TelegramPairing {
    const code = randomBytes(6).toString('base64url') // ~8 chars
    const expiresAt = Date.now() + PAIR_TTL_MS
    this.pairing = { code, expiresAt }
    this.emitStatus()
    return { code, expiresAt }
  }

  /** Current renderer-facing status (never carries the token). */
  getStatus(): TelegramStatus {
    const binding = getTelegramBinding()
    const pairing =
      this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined
    return {
      enabled: Boolean(binding?.enabled),
      connected: this.connected,
      botUsername: this.botUsername,
      paired: Boolean(binding?.chatId),
      boundChatLabel: binding?.chatTitle ?? undefined,
      pairing,
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt
    }
  }

  private emitStatus(): void {
    broadcast(IPC.TelegramStatusChanged, this.getStatus())
  }

  /* ---------------- inbound ---------------- */

  private registerHandlers(bot: Bot): void {
    // 'message:text' matches only genuine new text messages — not edited messages,
    // forum-topic service messages, joins, or pins (which have no usable .text).
    bot.on('message:text', (ctx) =>
      this.handleText(ctx).catch((err) => this.logError('handleText', err))
    )
    bot.on('message:photo', (ctx) =>
      this.handlePhoto(ctx).catch((err) => this.logError('handlePhoto', err))
    )
    bot.on('callback_query:data', (ctx) =>
      this.handleCallback(ctx).catch((err) => this.logError('handleCallback', err))
    )
  }

  private onBotError(err: unknown): void {
    // grammy hands the catch-handler a BotError wrapping the underlying error.
    const inner = err instanceof BotError ? err.error : err
    if (inner instanceof GrammyError && inner.error_code === 409) {
      this.connected = false
      this.lastError = 'Connected on another device.'
      this.emitStatus()
    }
    this.logError('bot', err)
  }

  private async handleText(ctx: Context): Promise<void> {
    if (!this.accepting) return
    const msg = ctx.message
    const text = msg?.text
    if (!msg || typeof text !== 'string') return
    // Native Threaded Mode (Bot API 9.3): conversations live in the user's PRIVATE
    // chat with the bot, with each private-chat topic carrying its own
    // message_thread_id. We only ever pair from, and drive from, a private chat —
    // group/supergroup messages (incl. /pair attempts) are ignored outright.
    if (ctx.chat?.type !== 'private') return
    const chatId = String(ctx.chat?.id ?? '')
    const threadKey = msg.message_thread_id ?? 0
    const fromId = ctx.from?.id

    const binding = getTelegramBinding()
    // Unbound: the only thing we honor is an exact `/pair <code>` (fail-safe).
    if (!binding?.chatId) {
      await this.tryPair(ctx, text, chatId, threadKey, fromId)
      return
    }
    // Bound: ignore every chat but the owner.
    if (chatId !== binding.chatId) return

    if (text.startsWith('/')) {
      const handled = await this.handleCommand(text, chatId, threadKey)
      if (handled) return
    }

    // A pending `ask` awaiting a free-text "Other" reply consumes this message.
    if (this.captureQuestionText(chatId, threadKey, text)) return

    await this.submitToSession(chatId, threadKey, text, [])
  }

  /**
   * Handle an inbound photo (with or without a caption): download it as an image
   * attachment and run a turn. Photos never pair, so the chat must already be bound.
   */
  private async handlePhoto(ctx: Context): Promise<void> {
    if (!this.accepting) return
    if (ctx.chat?.type !== 'private') return
    const chatId = String(ctx.chat.id)
    const threadKey = ctx.message?.message_thread_id ?? 0
    const binding = getTelegramBinding()
    if (!binding?.chatId || chatId !== binding.chatId) return
    const attachment = await this.downloadPhoto(ctx)
    if (!attachment) {
      await this.sendPlain(chatId, threadKey, 'Sorry — I couldn’t read that image.')
      return
    }
    await this.submitToSession(chatId, threadKey, ctx.message?.caption ?? '', [attachment])
  }

  /** Download the largest size of an inbound photo as a base64 image attachment. */
  private async downloadPhoto(ctx: Context): Promise<Attachment | undefined> {
    const bot = this.bot
    const photos = ctx.message?.photo
    if (!bot || !this.token || !photos || photos.length === 0) return undefined
    const fileId = photos[photos.length - 1].file_id // sizes ascend; last is largest
    try {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) return undefined
      // The file URL carries the bot token — never log it (logError redacts anyway).
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`)
      if (!res.ok) return undefined
      const data = Buffer.from(await res.arrayBuffer()).toString('base64')
      return { type: 'image', data, mimeType: 'image/jpeg' } // Telegram photos are JPEG
    } catch (err) {
      this.logError('downloadPhoto', err)
      return undefined
    }
  }

  /**
   * Shared inbound → turn path: config-ready guard, session resolution, and a
   * DETACHED (non-blocking) turn. Not awaited on purpose — grammy's long-poll
   * processes updates sequentially, so awaiting a turn that pauses for a Telegram
   * approval/`ask` would block the poll loop and deadlock (the tap's callback_query
   * can't be fetched). Detaching keeps the loop free to deliver those callbacks.
   */
  private async submitToSession(
    chatId: string,
    threadKey: number,
    text: string,
    attachments: Attachment[]
  ): Promise<void> {
    // Never construct/run an AgentService before sign-in + config delivery.
    if (!this.server.getConfig()?.llm.main) {
      await this.sendPlain(chatId, threadKey, 'Flairy isn’t ready yet — sign in on the desktop app and try again.')
      return
    }
    this.lastInboundAt = Date.now()
    this.emitStatus()
    const sessionId = this.resolveSession(chatId, threadKey)
    if (!sessionId) {
      await this.sendPlain(chatId, threadKey, 'Sorry — something went wrong starting that chat.')
      return
    }
    const origin: TurnOrigin = { kind: 'telegram', chatId, threadKey }
    this.startTyping(sessionId, chatId, threadKey)
    void this.agents
      .getOrCreate(sessionId, origin)
      .submit(text, attachments, origin)
      .catch((err) => {
        this.stopTyping(sessionId)
        this.clearStream(sessionId)
        this.logError('submit', err)
        void this.sendPlain(chatId, threadKey, 'Sorry — something went wrong handling that.')
      })
  }

  /**
   * Map (chatId, threadKey) → a persistent Flairy session, creating one (pinned to
   * the Telegram workspace cwd) on first contact. Self-heals an orphaned mapping
   * whose session row was deleted: it recreates the session and rebinds the row,
   * avoiding the UNIQUE(chat_id, thread_key) block.
   */
  private resolveSession(chatId: string, threadKey: number): string | undefined {
    try {
      const existing = getTelegramThread(chatId, threadKey)
      if (existing) {
        if (getSession(existing.sessionId)) {
          this.owned.add(existing.sessionId)
          return existing.sessionId
        }
        // Orphaned mapping → recreate + rebind.
        deleteTelegramThread(existing.sessionId)
        this.owned.delete(existing.sessionId)
        const healed = createSession({ cwd: this.workspaceDir() })
        createTelegramThread({
          sessionId: healed.id,
          chatId,
          threadKey,
          title: existing.title ?? undefined
        })
        this.owned.add(healed.id)
        broadcast(IPC.SessionsChanged)
        return healed.id
      }
      const meta = createSession({ cwd: this.workspaceDir() })
      createTelegramThread({ sessionId: meta.id, chatId, threadKey })
      this.owned.add(meta.id)
      broadcast(IPC.SessionsChanged)
      return meta.id
    } catch (err) {
      this.logError('resolveSession', err)
      return undefined
    }
  }

  private async handleCommand(text: string, chatId: string, threadKey: number): Promise<boolean> {
    const word = text.split(/\s+/)[0].replace(/@.*$/, '')
    switch (word) {
      case '/pair':
        await this.sendPlain(chatId, threadKey, 'This chat is already paired with Flairy.')
        return true
      case '/status': {
        const s = this.getStatus()
        await this.sendPlain(
          chatId,
          threadKey,
          `Connected: ${s.connected ? 'yes' : 'no'}\nPaired: ${s.paired ? 'yes' : 'no'}${s.botUsername ? `\nBot: @${s.botUsername}` : ''}`
        )
        return true
      }
      case '/new': {
        const existing = getTelegramThread(chatId, threadKey)
        if (existing) {
          // Fully dispose the old session's runtime (not just abort): agents.delete
          // tears down the AgentService and clears its telegram_threads mapping;
          // the dispose -> rejectInteractions fan-out also drops it from the
          // owned-Set and stops its typing keepalive. The old session row + history
          // are kept; the topic just re-maps to the fresh session below.
          this.agents.delete(existing.sessionId)
        }
        const meta = createSession({ cwd: this.workspaceDir() })
        createTelegramThread({ sessionId: meta.id, chatId, threadKey })
        this.owned.add(meta.id)
        broadcast(IPC.SessionsChanged)
        await this.sendPlain(chatId, threadKey, 'Started a fresh conversation in this topic.')
        return true
      }
      case '/delete': {
        // Telegram gives bots no topic-deleted event, so /delete is the way to
        // delete from Telegram: remove the session everywhere (mirrors the desktop
        // SessionDelete handler) AND delete this topic (agents.delete(…, true)).
        const existing = getTelegramThread(chatId, threadKey)
        if (!existing) {
          await this.sendPlain(chatId, threadKey, 'Nothing to delete here.')
          return true
        }
        const sessionId = existing.sessionId
        this.agents.delete(sessionId, true)
        this.agents.rejectInteractions(sessionId)
        this.server.sendSessionDelete({ sessionId })
        deleteSession(sessionId)
        broadcast(IPC.SessionsChanged)
        return true
      }
      case '/cancel': {
        const existing = getTelegramThread(chatId, threadKey)
        if (existing) {
          this.agents.get(existing.sessionId)?.abort()
          this.stopTyping(existing.sessionId)
          this.clearStream(existing.sessionId)
        }
        await this.sendPlain(chatId, threadKey, 'Cancelled.')
        return true
      }
      default:
        return false
    }
  }

  /* ---------------- pairing ---------------- */

  private async tryPair(
    ctx: Context,
    text: string,
    chatId: string,
    threadKey: number,
    fromId: number | undefined
  ): Promise<void> {
    const match = text.match(/^\/pair(?:@\w+)?\s+(\S+)$/)
    if (!match || fromId === undefined) return // ignore everything else while unbound

    const now = Date.now()
    this.prunePairAttempts(now)
    const attempt = this.pairAttempts.get(fromId) ?? { count: 0, lockedUntil: 0, last: now }
    attempt.last = now

    // No oracle (L1): on lockout, an expired code, or a wrong code, stay SILENT —
    // never confirm whether the bot is pairable, whether a guess was close, or
    // that a sender is rate-limited. Only a correct code gets a reply.
    if (attempt.lockedUntil > now) {
      this.pairAttempts.set(fromId, attempt)
      return
    }

    const active = this.pairing && this.pairing.expiresAt > now ? this.pairing : undefined
    if (!active || match[1] !== active.code) {
      attempt.count += 1
      if (attempt.count >= PAIR_MAX_ATTEMPTS) {
        attempt.lockedUntil = now + PAIR_LOCKOUT_MS
        attempt.count = 0
      }
      this.pairAttempts.set(fromId, attempt)
      return
    }

    // Success: bind this chat + the pairing sender as the sole owner, consume the
    // code, and clear all attempt counters (pairing is over).
    this.pairing = undefined
    this.pairAttempts.clear()
    const title = this.chatLabel(ctx)
    setTelegramBinding({ chatId, title, userId: String(fromId), enabled: true })
    this.emitStatus()
    await this.sendPlain(chatId, threadKey, 'Paired! This chat now controls Flairy. Send a message to begin.')
  }

  /** Drop stale pairing-attempt records so the map can't grow unbounded. */
  private prunePairAttempts(now: number): void {
    for (const [id, a] of this.pairAttempts) {
      if (now - a.last > PAIR_LOCKOUT_MS) this.pairAttempts.delete(id)
    }
  }

  private chatLabel(ctx: Context): string {
    const chat = ctx.chat
    if (!chat) return 'Telegram chat'
    if (chat.type === 'private') return 'Direct chat'
    return chat.title ?? 'Telegram group'
  }

  /* ---------------- outbound ---------------- */

  /**
   * Bus subscriber for telegram-origin turns on our owned sessions. Live-streams
   * the assistant's answer into Telegram's native draft (sendMessageDraft, Bot API
   * 9.3) as it generates, then PERSISTS each completed assistant message as a real
   * message (deliver()) — the draft is ephemeral and is replaced by that real send.
   *
   * Delivery is keyed on `message_end(role=assistant)`, NOT `agent_end`: every
   * assistant message (including intermediate tool-round narration) is sent exactly
   * once, so the Telegram transcript mirrors getLiveMessages() with no lost or
   * duplicated messages. agent_end / error only tear the stream down.
   */
  private onAgentEvent(env: AgentEventInternalEnvelope): void {
    if (env.origin.kind !== 'telegram') return
    if (!this.owned.has(env.sessionId)) return
    const { chatId, threadKey } = env.origin
    const ev = env.event
    switch (ev.type) {
      case 'agent_start':
        // Turn started: show Telegram's native "Thinking…" placeholder (an empty
        // draft) until the first token streams in.
        this.beginStream(env.sessionId, chatId, threadKey)
        break
      case 'message_update':
        if (ev.delta) this.streamDelta(env.sessionId, ev.messageId, ev.delta)
        break
      case 'message_end':
        // Persist each completed assistant message as a real (HTML, 4096-split)
        // send; tool-only assistant messages carry no text and are skipped.
        if (ev.role === 'assistant')
          this.finishStreamedMessage(env.sessionId, chatId, threadKey, ev.text)
        break
      case 'agent_end':
        this.clearStream(env.sessionId)
        this.stopTyping(env.sessionId)
        break
      case 'error':
        this.clearStream(env.sessionId)
        this.stopTyping(env.sessionId)
        void this.sendPlain(chatId, threadKey, 'Sorry — something went wrong with that turn.')
        break
    }
  }

  /* ---------------- live draft streaming (Bot API 9.3) ---------------- */

  /** A monotonic, non-zero draft id. Telegram animates updates that reuse an id. */
  private nextDraftId(): number {
    this.draftSeq = (this.draftSeq % 2_000_000_000) + 1
    return this.draftSeq
  }

  /**
   * Open a fresh stream for a turn: allocate a draft id and push an empty draft so
   * Telegram shows its native "Thinking…" placeholder before the first token. The
   * first assistant message of the turn reuses this draft id (animating the
   * placeholder into the streamed text); later messages get their own id.
   */
  private beginStream(sessionId: string, chatId: string, threadKey: number): void {
    if (!this.bot) return
    this.clearStream(sessionId)
    const state: StreamState = {
      chatId,
      threadKey,
      draftId: this.nextDraftId(),
      draftUnclaimed: true,
      messageId: undefined,
      text: '',
      pushed: undefined,
      lastPushAt: 0,
      backoffUntil: 0,
      paused: false,
      flushTimer: undefined
    }
    this.streams.set(sessionId, state)
    void this.flushDraft(state)
  }

  /** Append a streamed text delta and (throttled) push it to the live draft. */
  private streamDelta(sessionId: string, messageId: string, delta: string): void {
    const state = this.streams.get(sessionId)
    if (!state) return
    if (state.messageId === undefined) {
      // First delta of a new assistant message. Reuse the turn's initial draft for
      // the first message (animating the "Thinking…" placeholder); allocate a fresh
      // draft id for any subsequent message so each lands as its own animated bubble.
      if (!state.draftUnclaimed) {
        state.draftId = this.nextDraftId()
        state.pushed = undefined
      }
      state.draftUnclaimed = false
      state.messageId = messageId
      state.text = ''
    } else if (state.messageId !== messageId) {
      // Defensive: a new message id arrived without a finishing message_end.
      state.draftId = this.nextDraftId()
      state.pushed = undefined
      state.messageId = messageId
      state.text = ''
    }
    state.text += delta
    this.streamPush(state)
  }

  /**
   * Finalize the assistant message that just completed: cancel its pending draft
   * push and send the COMPLETE text as a real message (the draft was only a
   * preview). Reset so the next assistant message in the turn opens a new draft.
   */
  private finishStreamedMessage(
    sessionId: string,
    chatId: string,
    threadKey: number,
    text: string
  ): void {
    const state = this.streams.get(sessionId)
    if (state?.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }
    if (text.trim()) void this.deliver(chatId, threadKey, text)
    if (state) {
      state.messageId = undefined
      state.text = ''
      state.pushed = undefined
    }
  }

  /** Throttle draft pushes to near-realtime: immediate if quiet, else coalesced. */
  private streamPush(state: StreamState): void {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }
    if (state.paused) return
    const now = Date.now()
    const wait = Math.max(STREAM_THROTTLE_MS - (now - state.lastPushAt), state.backoffUntil - now)
    if (wait <= 0) {
      void this.flushDraft(state)
    } else {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined
        void this.flushDraft(state)
      }, wait)
    }
  }

  /**
   * Push the current accumulated text to the draft (clamped to the 4096-char tail).
   * Best-effort: a 429 backs off and skips intermediate pushes (the final real
   * sendMessage in deliver() is what must land); other errors are swallowed.
   */
  private async flushDraft(state: StreamState): Promise<void> {
    const bot = this.bot
    if (!bot || state.paused) return
    const now = Date.now()
    if (now < state.backoffUntil) return
    const text =
      state.text.length > DRAFT_MAX_CHARS
        ? state.text.slice(state.text.length - DRAFT_MAX_CHARS)
        : state.text
    if (text === state.pushed) return
    state.lastPushAt = now
    state.pushed = text
    try {
      // Rich draft (Bot API 10.1): stream the partial Markdown so Telegram renders
      // it richly and animates same-id updates. Partial/unclosed Markdown is
      // tolerated (drafts are built for streaming); any error stays best-effort.
      await bot.api.sendRichMessageDraft(
        Number(state.chatId),
        state.draftId,
        { markdown: text },
        state.threadKey !== 0 ? { message_thread_id: state.threadKey } : {}
      )
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const retryAfter = err.parameters?.retry_after ?? 1
        state.backoffUntil = Date.now() + (retryAfter + 1) * 1000
        return
      }
      // Drafts are best-effort; don't surface (errors may carry token-bearing URLs).
    }
  }

  /** Pause draft pushes (while blocked on an approval); text keeps accumulating. */
  private pauseStream(sessionId: string): void {
    const state = this.streams.get(sessionId)
    if (!state) return
    state.paused = true
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }
  }

  /** Resume draft pushes after an approval resolves and flush the latest text. */
  private resumeStream(sessionId: string): void {
    const state = this.streams.get(sessionId)
    if (!state) return
    state.paused = false
    this.streamPush(state)
  }

  /** Drop a session's stream state and cancel any pending draft push. */
  private clearStream(sessionId: string): void {
    const state = this.streams.get(sessionId)
    if (state?.flushTimer) clearTimeout(state.flushTimer)
    this.streams.delete(sessionId)
  }

  /** Deliver markdown as Telegram HTML, falling back to plain text on a parse error. */
  private async deliver(chatId: string, threadKey: number, markdown: string): Promise<void> {
    // Prefer a native rich message (Bot API 10.1): Telegram parses the FULL
    // Markdown itself — code blocks with language, tables, lists, headings,
    // quotes — far richer than the flat MarkdownV2/HTML subset, and with no
    // 4096-char escaping pitfalls. Fall back to the HTML/plain chunked path if
    // the rich send fails (e.g. length limits or an older client).
    const bot = this.bot
    if (bot) {
      try {
        await bot.api.sendRichMessage(
          Number(chatId),
          { markdown },
          threadKey !== 0 ? { message_thread_id: threadKey } : {}
        )
        return
      } catch (err) {
        this.logError('sendRichMessage', err)
      }
    }
    let html: string | null
    try {
      html = toTelegramHtml(markdown)
    } catch {
      html = null
    }
    if (html !== null) {
      const ok = await this.sendChunks(chatId, threadKey, splitForTelegram(html), true)
      if (ok) return
    }
    await this.sendChunks(chatId, threadKey, splitForTelegram(markdown), false)
  }

  private async sendPlain(chatId: string, threadKey: number, text: string): Promise<void> {
    await this.sendChunks(chatId, threadKey, splitForTelegram(text), false)
  }

  /**
   * Send the FULL, verbatim approval detail (tool + pinned cwd + complete args) as
   * one or more <pre> messages — never truncated. splitForTelegram re-opens the
   * <pre> fence across 4096-char chunks so a long shell command stays readable and
   * valid HTML; on any HTML parse error we resend the same content as plain text.
   */
  private async sendApprovalDetail(
    chatId: string,
    threadKey: number,
    toolName: string,
    cwd: string,
    argsText: string
  ): Promise<void> {
    const detail = `Tool: ${toolName}\nWorking dir: ${cwd}\n\n${argsText}`
    const html = `<pre>${escapeHtml(detail)}</pre>`
    const ok = await this.sendChunks(chatId, threadKey, splitForTelegram(html), true)
    if (!ok) await this.sendChunks(chatId, threadKey, splitForTelegram(detail), false)
  }

  private async sendChunks(
    chatId: string,
    threadKey: number,
    chunks: string[],
    html: boolean
  ): Promise<boolean> {
    for (const chunk of chunks) {
      const ok = await this.sendChunk(chatId, threadKey, chunk, html, 0)
      if (!ok) return false
    }
    return true
  }

  private async sendChunk(
    chatId: string,
    threadKey: number,
    text: string,
    html: boolean,
    attempt: number
  ): Promise<boolean> {
    const bot = this.bot
    if (!bot) return false
    try {
      await bot.api.sendMessage(Number(chatId), text, {
        ...(threadKey !== 0 ? { message_thread_id: threadKey } : {}),
        ...(html ? { parse_mode: 'HTML' as const } : {})
      })
      return true
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429 && attempt < 3) {
        const retryAfter = err.parameters?.retry_after ?? 1
        await delay((retryAfter + 1) * 1000)
        return this.sendChunk(chatId, threadKey, text, html, attempt + 1)
      }
      // HTML rejected (e.g. unbalanced entities) → let the caller retry as plain.
      if (html) return false
      this.logError('sendMessage', err)
      return false
    }
  }

  private async sendKeyboard(
    chatId: string,
    threadKey: number,
    html: string,
    plain: string,
    kb: InlineKeyboard
  ): Promise<number | undefined> {
    const bot = this.bot
    if (!bot) return undefined
    const base = threadKey !== 0 ? { message_thread_id: threadKey } : {}
    try {
      const m = await bot.api.sendMessage(Number(chatId), html, {
        ...base,
        parse_mode: 'HTML',
        reply_markup: kb
      })
      return m.message_id
    } catch (err) {
      this.logError('sendKeyboard(html)', err)
      try {
        const m = await bot.api.sendMessage(Number(chatId), plain, { ...base, reply_markup: kb })
        return m.message_id
      } catch (err2) {
        this.logError('sendKeyboard(plain)', err2)
        return undefined
      }
    }
  }

  /* ---------------- typing keepalive ---------------- */

  private startTyping(sessionId: string, chatId: string, threadKey: number): void {
    this.stopTyping(sessionId)
    void this.sendTyping(chatId, threadKey)
    const timer = setInterval(() => {
      const h = this.typing.get(sessionId)
      if (!h || h.paused) return
      void this.sendTyping(h.chatId, h.threadKey)
    }, TYPING_INTERVAL_MS)
    this.typing.set(sessionId, { timer, chatId, threadKey, paused: false })
  }

  private pauseTyping(sessionId: string): void {
    const h = this.typing.get(sessionId)
    if (h) h.paused = true
  }

  private resumeTyping(sessionId: string): void {
    const h = this.typing.get(sessionId)
    if (h) {
      h.paused = false
      void this.sendTyping(h.chatId, h.threadKey)
    }
  }

  private stopTyping(sessionId: string): void {
    const h = this.typing.get(sessionId)
    if (h) {
      clearInterval(h.timer)
      this.typing.delete(sessionId)
    }
  }

  private async sendTyping(chatId: string, threadKey: number): Promise<void> {
    const bot = this.bot
    if (!bot) return
    try {
      await bot.api.sendChatAction(
        Number(chatId),
        'typing',
        threadKey !== 0 ? { message_thread_id: threadKey } : {}
      )
    } catch {
      // Typing is best-effort; swallow (errors may carry URLs we won't log).
    }
  }

  /* ---------------- InteractionChannel: approvals ---------------- */

  async requestApproval(req: {
    sessionId: string
    origin: TurnOrigin
    toolName: string
    args: unknown
    cwd: string
  }): Promise<ApprovalDecision> {
    if (req.origin.kind !== 'telegram') return DENIED
    const bot = this.bot
    if (!bot) return DENIED
    const { chatId, threadKey } = req.origin

    const nonce = randomBytes(8).toString('hex')
    const argsText = this.prettyArgs(req.args)
    const argsHash = createHash('sha256').update(argsText).digest('hex')
    const argsPreview = this.redactPreview(argsText)

    this.pauseTyping(req.sessionId)
    // Pause live draft streaming while the turn is blocked on this approval — don't
    // animate a draft while we're waiting on a tap.
    this.pauseStream(req.sessionId)

    // MED-3: the remote approver MUST see the COMPLETE, untruncated command before
    // the buttons. Send the full args verbatim (HTML-escaped, wrapped in <pre>,
    // split safely at 4096 with the code fence reopened across chunks) as one or
    // more messages FIRST, then post the keyboard card referencing the same nonce.
    await this.sendApprovalDetail(chatId, threadKey, req.toolName, req.cwd, argsText)

    const kb = new InlineKeyboard()
      .text('Deny', `d|${nonce}`)
      .text('Allow once', `o|${nonce}`)
      .row()
      .text('Allow for this chat-session', `s|${nonce}`)
    const messageId = await this.sendKeyboard(
      chatId,
      threadKey,
      `⚠️ <b>Approve this action?</b>\n` +
        `Tool: <code>${escapeHtml(req.toolName)}</code>\n` +
        `Working dir: <code>${escapeHtml(req.cwd)}</code>`,
      `Approve this action?\nTool: ${req.toolName}\nWorking dir: ${req.cwd}`,
      kb
    )
    if (messageId === undefined) {
      this.resumeTyping(req.sessionId)
      this.resumeStream(req.sessionId)
      return DENIED
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.approvalsPending.set(nonce, {
        sessionId: req.sessionId,
        chatId,
        threadKey,
        toolName: req.toolName,
        argsHash,
        argsPreview,
        resolve
      })
    })
    this.resumeTyping(req.sessionId)
    this.resumeStream(req.sessionId)
    return decision
  }

  private async handleApprovalCallback(ctx: Context, code: string, nonce: string): Promise<void> {
    const entry = this.approvalsPending.get(nonce)
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'This request has expired.' })
      return
    }
    if (!this.isAuthorizedCallback(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed.' })
      return
    }
    this.approvalsPending.delete(nonce)
    const decision: ApprovalDecision =
      code === 's'
        ? { approved: true, scope: 'session' }
        : code === 'o'
          ? { approved: true, scope: 'once' }
          : DENIED
    const label = code === 's' ? 'allow_session' : code === 'o' ? 'allow_once' : 'deny'
    await ctx.answerCallbackQuery({ text: decision.approved ? 'Allowed' : 'Denied' })
    try {
      appendTelegramAudit({
        sessionId: entry.sessionId,
        chatId: entry.chatId,
        threadKey: entry.threadKey,
        toolName: entry.toolName,
        argsHash: entry.argsHash,
        argsPreview: entry.argsPreview,
        decision: label
      })
    } catch (err) {
      this.logError('audit', err)
    }
    try {
      await ctx.editMessageReplyMarkup()
    } catch {
      // Best-effort: stripping the keyboard after a decision is non-critical.
    }
    entry.resolve(decision)
  }

  /* ---------------- InteractionChannel: ask ---------------- */

  async askQuestion(req: {
    sessionId: string
    origin: TurnOrigin
    questions: AskQuestion[]
  }): Promise<QuestionAnswer[] | null> {
    if (req.origin.kind !== 'telegram') return null
    if (!this.bot || req.questions.length === 0) return null
    const { chatId, threadKey } = req.origin
    // Replace any stale flow for this session.
    this.dropQuestionFlow(req.sessionId)

    const flow: QuestionFlow = {
      flowId: randomBytes(6).toString('hex'),
      sessionId: req.sessionId,
      chatId,
      threadKey,
      questions: req.questions,
      index: 0,
      answers: [],
      selected: new Set(),
      awaitingText: false,
      resolve: () => {}
    }
    return new Promise<QuestionAnswer[] | null>((resolve) => {
      flow.resolve = resolve
      this.questionFlows.set(flow.sessionId, flow)
      this.questionFlowsById.set(flow.flowId, flow)
      void this.sendQuestion(flow)
    })
  }

  private async sendQuestion(flow: QuestionFlow): Promise<void> {
    const q = flow.questions[flow.index]
    flow.selected = new Set()
    flow.awaitingText = false
    const header = q.header ? `<b>${escapeHtml(q.header)}</b>\n` : ''
    const body = `${header}${escapeHtml(q.question)}`
    flow.messageId = await this.sendKeyboard(
      flow.chatId,
      flow.threadKey,
      body,
      `${q.header ? q.header + '\n' : ''}${q.question}`,
      this.buildQuestionKeyboard(flow)
    )
    if (flow.messageId === undefined) {
      // Couldn't render the question → settle as cancelled rather than hang.
      this.dropQuestionFlow(flow.sessionId)
      flow.resolve(null)
    }
  }

  private buildQuestionKeyboard(flow: QuestionFlow): InlineKeyboard {
    const q = flow.questions[flow.index]
    const kb = new InlineKeyboard()
    q.options.forEach((opt, i) => {
      const mark = flow.selected.has(opt.label) ? '✅ ' : ''
      kb.text(`${mark}${opt.label}`, `q|${flow.flowId}|o|${i}`).row()
    })
    if (q.multiSelect) kb.text('✅ Done', `q|${flow.flowId}|d|0`).row()
    kb.text('✏️ Other (reply with text)', `q|${flow.flowId}|x|0`)
    return kb
  }

  private async handleQuestionCallback(ctx: Context, data: string): Promise<void> {
    const [, flowId, kind, idxStr] = data.split('|')
    const flow = this.questionFlowsById.get(flowId)
    if (!flow) {
      await ctx.answerCallbackQuery({ text: 'This question has expired.' })
      return
    }
    if (!this.isAuthorizedCallback(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not allowed.' })
      return
    }
    const q = flow.questions[flow.index]
    const idx = Number(idxStr)

    if (kind === 'o') {
      const label = q.options[idx]?.label
      if (label === undefined) {
        await ctx.answerCallbackQuery()
        return
      }
      if (q.multiSelect) {
        if (flow.selected.has(label)) flow.selected.delete(label)
        else flow.selected.add(label)
        await ctx.answerCallbackQuery()
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: this.buildQuestionKeyboard(flow) })
        } catch {
          // ignore — the toggle state is still tracked server-side.
        }
      } else {
        flow.selected = new Set([label])
        await ctx.answerCallbackQuery({ text: 'Selected' })
        this.commitQuestion(flow, undefined)
        await this.advanceQuestion(flow)
      }
      return
    }
    if (kind === 'd') {
      await ctx.answerCallbackQuery()
      this.commitQuestion(flow, undefined)
      await this.advanceQuestion(flow)
      return
    }
    if (kind === 'x') {
      flow.awaitingText = true
      await ctx.answerCallbackQuery({ text: 'Reply with your answer.' })
      await this.sendPlain(flow.chatId, flow.threadKey, 'Type your answer as a normal message.')
      return
    }
    await ctx.answerCallbackQuery()
  }

  /** Capture a free-text reply for a question awaiting "Other". Returns true if consumed. */
  private captureQuestionText(chatId: string, threadKey: number, text: string): boolean {
    for (const flow of this.questionFlows.values()) {
      if (flow.chatId === chatId && flow.threadKey === threadKey && flow.awaitingText) {
        flow.awaitingText = false
        this.commitQuestion(flow, text)
        void this.advanceQuestion(flow)
        return true
      }
    }
    return false
  }

  private commitQuestion(flow: QuestionFlow, custom: string | undefined): void {
    const q = flow.questions[flow.index]
    flow.answers.push({
      id: q.id,
      selected: [...flow.selected],
      ...(custom ? { custom } : {})
    })
  }

  private async advanceQuestion(flow: QuestionFlow): Promise<void> {
    flow.index += 1
    if (flow.index >= flow.questions.length) {
      this.dropQuestionFlow(flow.sessionId)
      flow.resolve(flow.answers)
      return
    }
    await this.sendQuestion(flow)
  }

  private dropQuestionFlow(sessionId: string): void {
    const flow = this.questionFlows.get(sessionId)
    if (!flow) return
    this.questionFlows.delete(sessionId)
    this.questionFlowsById.delete(flow.flowId)
  }

  /* ---------------- InteractionChannel: rejectSession ---------------- */

  /** Settle this channel's pending approval/question for a session (default-deny). */
  /**
   * The session's auto-generated title changed → rename the matching Telegram
   * topic (Bot API 9.3 editForumTopic works in private chats). Best-effort: the
   * General/default thread (threadKey 0) can't be renamed this way, and the bot
   * may lack rights on a user-created topic — either just no-ops, and the session
   * title itself is unaffected.
   */
  onTitleChanged(sessionId: string, title: string): void {
    if (!this.owned.has(sessionId)) return
    const bot = this.bot
    if (!bot || !title.trim()) return
    const thread = getTelegramThreadBySession(sessionId)
    if (!thread || thread.threadKey === 0 || thread.title === title) return
    void bot.api
      .editForumTopic(Number(thread.chatId), thread.threadKey, { name: title })
      .then(() => updateTelegramThreadTitle(sessionId, title))
      .catch((err) => this.logError('editForumTopic', err))
  }

  /**
   * The session was deleted in Flairy → delete the mapped Telegram topic too.
   * Best-effort: the General/default thread (threadKey 0) can't be deleted this way,
   * and the bot may lack rights on a user-created topic — either just no-ops.
   */
  onSessionDeleted(sessionId: string): void {
    const bot = this.bot
    const thread = getTelegramThreadBySession(sessionId)
    this.owned.delete(sessionId)
    if (!bot || !thread || thread.threadKey === 0) return
    void bot.api
      .deleteForumTopic(Number(thread.chatId), thread.threadKey)
      .catch((err) => this.logError('deleteForumTopic', err))
  }

  rejectSession(sessionId: string): void {
    for (const [nonce, entry] of this.approvalsPending) {
      if (entry.sessionId !== sessionId) continue
      this.approvalsPending.delete(nonce)
      entry.resolve(DENIED)
    }
    const flow = this.questionFlows.get(sessionId)
    if (flow) {
      this.dropQuestionFlow(sessionId)
      flow.resolve(null)
    }
    this.stopTyping(sessionId)
    this.clearStream(sessionId)
    this.owned.delete(sessionId)
  }

  /* ---------------- callbacks dispatch ---------------- */

  private async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data
    if (!data) return
    if (data.startsWith('q|')) {
      await this.handleQuestionCallback(ctx, data)
      return
    }
    const [code, nonce] = data.split('|')
    if (!nonce) {
      await ctx.answerCallbackQuery()
      return
    }
    await this.handleApprovalCallback(ctx, code, nonce)
  }

  /* ---------------- helpers ---------------- */

  /**
   * Whether an inline-keyboard tap is allowed to act: it must come from the bound
   * chat AND (when a pairing user was recorded, L3) from the exact user who
   * completed pairing — so a different member of the bound group can't approve a
   * tool. Legacy bindings with no recorded user id fall back to the chat check.
   */
  private isAuthorizedCallback(ctx: Context): boolean {
    const binding = getTelegramBinding()
    const callbackChatId = ctx.callbackQuery?.message?.chat.id
    const fromId = ctx.callbackQuery?.from?.id
    if (callbackChatId === undefined || String(callbackChatId) !== (binding?.chatId ?? null)) {
      return false
    }
    if (binding?.userId && String(fromId) !== binding.userId) {
      return false
    }
    return true
  }

  private workspaceDir(): string {
    if (!this.workspace) {
      const dir = join(app.getPath('userData'), 'telegram-workspace')
      mkdirSync(dir, { recursive: true })
      this.workspace = dir
    }
    return this.workspace
  }

  private prettyArgs(args: unknown): string {
    try {
      return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
    } catch {
      return String(args)
    }
  }

  /** A redacted, truncated args snippet for the (unencrypted) audit table. */
  private redactPreview(argsText: string): string {
    const clipped =
      argsText.length > ARGS_PREVIEW_LIMIT ? `${argsText.slice(0, ARGS_PREVIEW_LIMIT)}…` : argsText
    return this.maskTokens(clipped)
  }

  private maskTokens(input: string): string {
    let out = input
    // The bot token itself, first and verbatim.
    if (this.token) out = out.split(this.token).join('***')
    // Telegram bot-API token shape (bot<id>:<secret>) and the bare <id>:<secret>.
    out = out.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot***')
    out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '***')
    // Common secret shapes that can ride in tool args (L2 broadened redaction):
    //   - vendor-prefixed keys (sk-…, ghp_…, xoxb-…, AKIA…)
    //   - JWTs (eyJ….….…)
    //   - key/value secrets (password=…, "token": "…", Authorization: Bearer …)
    //   - long opaque hex / base64url blobs
    out = out.replace(/\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9]{12,}/gi, '***')
    out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/gi, '***')
    out = out.replace(/\bAKIA[0-9A-Z]{12,}\b/g, '***')
    out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***')
    out = out.replace(
      /("?(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|auth|bearer|credential)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
      '$1***'
    )
    out = out.replace(/\b[A-Fa-f0-9]{40,}\b/g, '***')
    out = out.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '***')
    return out
  }

  private redact(input: unknown): string {
    const raw =
      input instanceof Error
        ? (input.stack ?? input.message)
        : typeof input === 'string'
          ? input
          : this.prettyArgs(input)
    return this.maskTokens(raw)
  }

  private logError(context: string, err: unknown): void {
    console.error(`[telegram] ${context}: ${this.redact(err)}`)
  }
}
