import { create } from 'zustand'
import type {
  AgentEventEnvelope,
  ApprovalRequestPayload,
  ApprovalScope,
  Attachment,
  PermissionMode,
  QuestionAnswer,
  QuestionRequestPayload,
  SessionMeta
} from '@shared/ipc'
import { toolArgSummary, toolDisplayKey } from '@/lib/tool-display'
import i18n from '@/i18n'

/** A rendered chat message in the UI (distinct from pi's internal messages). */
export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  /**
   * For `assistant` messages: the model's reasoning ("thinking") for this turn,
   * accumulated from `thinking_delta` events (live) or the persisted `thinking`
   * content parts (replay). Shown in a collapsible block above the answer; kept
   * separate from `text` so reasoning never folds into the answer body.
   */
  thinking?: string
  toolName?: string
  isError?: boolean
  streaming?: boolean
  /**
   * Whether a tool call is still executing. Drives the pulsing status dot —
   * kept separate from `text` so the indicator survives translation (the text
   * is a localized placeholder that would otherwise have to be string-matched).
   */
  running?: boolean
  /**
   * For `tool` messages: the call's most telling argument (file path, search
   * pattern, command…) shown after the label in the expanded row. Derived by
   * `toolArgSummary` from the same args on both the live stream and replay.
   */
  toolArg?: string
  /**
   * For `tool` messages: the id of the assistant turn that issued this call.
   * Tool calls in the same turn (a parallel batch) share it, so the UI folds
   * them into one group. Derived identically by the live stream (from the
   * turn's `message_start`) and by replay (from the owning pi assistant
   * message's id), keeping a watched session and its reload in sync.
   */
  batchId?: string
  /**
   * Index of the persisted pi message this bubble came from (in the session's
   * messages[] array). All sub-bubbles of one assistant turn share it. Used by
   * full-text search to jump to the matching turn — persisted pi messages carry
   * no stable id, so the array position is the locator.
   */
  sourceIndex?: number
}

interface ChatState {
  sessionId: string | null
  sessions: SessionMeta[]
  messages: UiMessage[]
  running: boolean
  /** Pending approval requests, oldest first; the dialog shows the head. */
  approvalQueue: ApprovalRequestPayload[]
  /** Pending `ask` questions for the open session, oldest first; each renders a card. */
  questionQueue: QuestionRequestPayload[]
  /** Tool-approval posture for the open session (in-memory, resets to 'ask'). */
  permissionMode: PermissionMode
  /**
   * Working directory chosen on the home screen before a session exists. Applied
   * to the session that's lazily created on the first message, then cleared.
   */
  pendingCwd: string | null
  /** Previously-used working directories, newest first; fills the directory menu. */
  recentDirs: string[]
  /**
   * A message index (in the open session's messages[]) that `MessageList` should
   * scroll to once, set when jumping from a search hit; null otherwise. The list
   * consumes it via `clearPendingScroll` after scrolling.
   */
  pendingScrollIndex: number | null

  init: () => () => void
  loadSessions: () => Promise<SessionMeta[]>
  /**
   * Open a session. Pass `msgIndex` (a search hit's target) to queue a scroll to
   * that message turn; omit it for a plain open, which clears any stale target.
   */
  openSession: (meta: SessionMeta, msgIndex?: number) => Promise<void>
  /** Clear the queued scroll target (called by MessageList after scrolling). */
  clearPendingScroll: () => void
  /**
   * Return to the home screen. By default the working directory in effect
   * (`selectCwd`) carries over so the next chat opens where this one left off;
   * pass an explicit `cwd` to start elsewhere, or `null` to reset to home.
   */
  newChat: (cwd?: string | null) => Promise<void>
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  abort: () => void
  respondApproval: (approvalId: string, approved: boolean, scope?: ApprovalScope) => void
  /** Submit the user's answers for an `ask` question and drop it from the queue. */
  respondQuestion: (questionId: string, answers: QuestionAnswer[]) => void
  setPermissionMode: (mode: PermissionMode) => void
  setWorkingDirectory: () => Promise<void>
  loadRecentDirs: () => Promise<void>
  chooseWorkingDirectory: (path: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
}

/**
 * The working directory in effect right now: an open session's persisted cwd,
 * otherwise the pending pick that the next session will inherit. Single source
 * for "where are we?" — used as a `useChat` selector and to seed `newChat`.
 */
export const selectCwd = (s: ChatState): string | null =>
  s.sessionId ? (s.sessions.find((m) => m.id === s.sessionId)?.cwd ?? s.pendingCwd) : s.pendingCwd

export const useChat = create<ChatState>((set, get) => ({
  sessionId: null,
  sessions: [],
  messages: [],
  running: false,
  approvalQueue: [],
  questionQueue: [],
  permissionMode: 'ask',
  pendingCwd: null,
  pendingScrollIndex: null,
  recentDirs: [],

  /** Subscribe to the main-process event stream. Call once on mount. */
  init: () => {
    const offEvent = window.api.onAgentEvent((env) => applyEvent(set, get, env))
    const offApproval = window.api.onApprovalRequest((req) => {
      if (req.sessionId === get().sessionId)
        set((s) => ({ approvalQueue: [...s.approvalQueue, req] }))
    })
    const offQuestion = window.api.onQuestionRequest((req) => {
      if (req.sessionId === get().sessionId)
        set((s) => ({ questionQueue: [...s.questionQueue, req] }))
    })
    // Live-update the sidebar when a session title changes (auto-generated
    // locally or synced from another device).
    const offTitle = window.api.onSessionTitleUpdated(({ sessionId, title }) => {
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x))
      }))
    })
    // The session list changed wholesale (sessions pulled from the server on
    // login/reconnect). Reload the sidebar; if nothing is open yet, surface the
    // newest pulled session so a relogin lands straight on the user's history.
    const offSessions = window.api.onSessionsChanged(() => {
      void (async () => {
        const hadSession = !!get().sessionId
        const sessions = await get().loadSessions()
        console.log('[sync] SessionsChanged → reloaded', sessions.length, 'session(s)')
        const current = get().sessionId
        if (current && !sessions.some((x) => x.id === current)) {
          // The open session was deleted elsewhere — drop back to the home
          // screen rather than render a now-orphaned conversation.
          set({ sessionId: null, messages: [], running: false })
        } else if (!hadSession && sessions[0]) {
          // Fresh pull with nothing open (e.g. relogin) — surface newest history.
          await get().openSession(sessions[0])
        }
      })()
    })
    return () => {
      offEvent()
      offApproval()
      offQuestion()
      offTitle()
      offSessions()
    }
  },

  /** Fetch the session list from the main process (newest first). */
  loadSessions: async () => {
    const sessions = await window.api.listSessions()
    set({ sessions })
    return sessions
  },

  openSession: async (meta, msgIndex) => {
    liveBatchId = null
    const { messages } = await window.api.loadSession(meta.id)
    // Permission mode is per-session and in-memory; a freshly opened session
    // starts at 'ask' (mirrors the main-process AgentService default). Set the
    // scroll target only for a search jump (msgIndex >= 0); a plain open clears
    // any stale target so it can't fire on an unrelated session.
    set({
      sessionId: meta.id,
      messages: hydrateMessages(messages),
      running: false,
      permissionMode: 'ask',
      pendingCwd: null,
      pendingScrollIndex: typeof msgIndex === 'number' && msgIndex >= 0 ? msgIndex : null
    })
  },

  clearPendingScroll: () => set({ pendingScrollIndex: null }),

  /**
   * Return to the home screen (no active session, empty thread). We deliberately
   * do NOT create a session here — that happens lazily on the first `send`, so
   * clicking "New chat" repeatedly never litters the history with empty chats.
   */
  newChat: async (cwd) => {
    liveBatchId = null
    set((s) => ({
      sessionId: null,
      messages: [],
      running: false,
      permissionMode: 'ask',
      // Inherit the directory in effect by default; an explicit arg overrides.
      pendingCwd: cwd === undefined ? selectCwd(s) : cwd
    }))
  },

  send: async (text, attachments) => {
    if (!text.trim() && !attachments?.length) return
    // Lazily create the session on the first message. From the home screen there
    // is no sessionId yet; spin one up and switch to it before sending.
    let sessionId = get().sessionId
    if (!sessionId) {
      const meta = await window.api.createSession({ cwd: get().pendingCwd ?? '~' })
      set((s) => ({ sessions: [meta, ...s.sessions], sessionId: meta.id, pendingCwd: null }))
      sessionId = meta.id
      // The new AgentService defaults to 'ask'; carry over a mode the user
      // picked on the home screen before the session existed.
      const mode = get().permissionMode
      if (mode !== 'ask') window.api.setPermissionMode({ sessionId, mode })
    }
    // For an attachments-only send, show a lightweight indicator so the
    // optimistic user bubble (which renders only `text`) isn't blank.
    const bubbleText =
      text.trim() ||
      (attachments?.length ? i18n.t('chat.imageCount', { count: attachments.length }) : '')
    set((s) => ({
      running: true,
      messages: [...s.messages, { id: crypto.randomUUID(), role: 'user', text: bubbleText }]
    }))
    try {
      await window.api.prompt({ sessionId, text, attachments })
    } catch (err) {
      set((s) => ({
        running: false,
        messages: [
          ...s.messages,
          {
            id: crypto.randomUUID(),
            role: 'tool',
            text: err instanceof Error ? err.message : String(err),
            isError: true
          }
        ]
      }))
    }
  },

  abort: () => {
    const sessionId = get().sessionId
    if (sessionId) window.api.abort({ sessionId })
    set({ running: false })
  },

  respondApproval: (approvalId, approved, scope = 'once') => {
    const req = get().approvalQueue.find((r) => r.approvalId === approvalId)
    if (!req) return
    window.api.respondApproval({ approvalId, approved, scope })
    set((s) => ({ approvalQueue: s.approvalQueue.filter((r) => r.approvalId !== approvalId) }))
  },

  respondQuestion: (questionId, answers) => {
    const req = get().questionQueue.find((r) => r.questionId === questionId)
    if (!req) return
    window.api.respondQuestion({ questionId, answers })
    set((s) => ({ questionQueue: s.questionQueue.filter((r) => r.questionId !== questionId) }))
  },

  setPermissionMode: (mode) => {
    // Always track the choice locally. On the home screen there's no session
    // yet, so we just remember it; `send` applies it to the session that gets
    // lazily created on the first message.
    const sessionId = get().sessionId
    if (sessionId) window.api.setPermissionMode({ sessionId, mode })
    set({ permissionMode: mode })
  },

  setWorkingDirectory: async () => {
    const sessionId = get().sessionId
    // No session yet (home screen): pick a directory and stash it for the
    // session that gets lazily created on the first message.
    if (!sessionId) {
      const dir = await window.api.pickDirectory()
      if (!dir) return // user cancelled
      set({ pendingCwd: dir })
      await get().loadRecentDirs() // main recorded the pick
      return
    }
    const updated = await window.api.setWorkingDirectory({ sessionId })
    if (!updated) return // user cancelled
    set((s) => ({ sessions: s.sessions.map((m) => (m.id === updated.id ? updated : m)) }))
    await get().loadRecentDirs() // main recorded the pick
  },

  loadRecentDirs: async () => {
    const dirs = await window.api.listRecentDirectories()
    set({ recentDirs: dirs })
  },

  // Pick an already-known directory from the recents menu (no native dialog).
  chooseWorkingDirectory: async (path) => {
    const sessionId = get().sessionId
    const updated = await window.api.chooseDirectory({ sessionId, path })
    if (sessionId && updated) {
      set((s) => ({ sessions: s.sessions.map((m) => (m.id === updated.id ? updated : m)) }))
    } else if (!sessionId) {
      set({ pendingCwd: path })
    }
    await get().loadRecentDirs()
  },

  renameSession: async (sessionId, title) => {
    const trimmed = title.trim()
    if (!trimmed) return
    await window.api.renameSession({ sessionId, title: trimmed })
    // Optimistic; the main-process SessionTitleUpdated broadcast sets the same
    // value idempotently, so no flicker.
    set((s) => ({
      sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, title: trimmed } : m))
    }))
  },

  deleteSession: async (sessionId) => {
    await window.api.deleteSession({ sessionId })
    set((s) => {
      const current = s.sessionId === sessionId
      return {
        sessions: s.sessions.filter((m) => m.id !== sessionId),
        // Deleting the open session drops us back to the home screen.
        sessionId: current ? null : s.sessionId,
        messages: current ? [] : s.messages,
        running: current ? false : s.running
      }
    })
  }
}))

/**
 * The id of the assistant turn currently streaming. Set from each turn's
 * `message_start` (and defensively from `message_end`), then stamped onto the
 * tool calls that turn issues so a parallel batch shares one `batchId`. The loop
 * is sequential per turn, so a single tracked id is unambiguous. Reset on
 * session open / new chat so it never bleeds across sessions.
 */
let liveBatchId: string | null = null

/** Fold a streamed agent event into UI message state. */
function applyEvent(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
  env: AgentEventEnvelope
): void {
  if (env.sessionId !== get().sessionId) return
  const e = env.event

  switch (e.type) {
    case 'agent_start':
      set(() => ({ running: true }))
      break
    case 'message_start':
      // New turn → new batch for the tool calls it's about to issue.
      liveBatchId = e.messageId || crypto.randomUUID()
      break
    case 'message_update': {
      // text deltas carry the visible body, thinking deltas the reasoning stream;
      // both belong to the same streaming assistant bubble. A toolcall delta has
      // neither and must not spawn a blank bubble.
      const td = e.thinkingDelta ?? ''
      if (!e.delta && !td) break
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          const updated = {
            ...last,
            text: e.delta ? last.text + e.delta : last.text,
            thinking: td ? (last.thinking ?? '') + td : last.thinking
          }
          return { messages: [...s.messages.slice(0, -1), updated] }
        }
        return {
          messages: [
            ...s.messages,
            {
              id: e.messageId || crypto.randomUUID(),
              role: 'assistant',
              text: e.delta ?? '',
              thinking: td || undefined,
              streaming: true
            }
          ]
        }
      })
      break
    }
    case 'message_end':
      // pi emits message_end for the user prompt too; only assistant turns echo.
      if (e.role !== 'assistant') {
        set((s) => ({
          messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        }))
        break
      }
      // Defensive: ensure the batch id is set even if message_start was missed.
      if (e.messageId) liveBatchId = e.messageId
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        // Finalize the streamed bubble with the authoritative full text +
        // reasoning (deltas win; fall back to the end payload if they were empty).
        if (last?.role === 'assistant' && last.streaming) {
          const finalized = {
            ...last,
            text: e.text || last.text,
            thinking: last.thinking || e.thinking || undefined,
            streaming: false
          }
          return { messages: [...s.messages.slice(0, -1), finalized] }
        }
        // …or build it now if deltas never produced a visible bubble
        // (non-streaming response, empty/garbled deltas).
        if (e.text || e.thinking) {
          return {
            messages: [
              ...s.messages,
              {
                id: e.messageId || crypto.randomUUID(),
                role: 'assistant',
                text: e.text ?? '',
                thinking: e.thinking || undefined
              }
            ]
          }
        }
        return { messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) }
      })
      break
    case 'tool_execution_start':
      set((s) => ({
        messages: [
          ...s.messages,
          {
            id: e.toolCallId,
            role: 'tool',
            toolName: e.name,
            text: i18n.t('chat.toolRunning', { tool: i18n.t(toolDisplayKey(e.name)) }),
            running: true,
            toolArg: toolArgSummary(e.name, e.args),
            batchId: liveBatchId ?? e.toolCallId
          }
        ]
      }))
      break
    case 'tool_execution_end':
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === e.toolCallId
            ? { ...m, text: summarizeResult(e.result), isError: e.isError, running: false }
            : m
        )
      }))
      break
    case 'agent_end':
      set(() => ({ running: false }))
      break
    case 'error':
      set((s) => ({
        running: false,
        messages: [
          ...s.messages,
          { id: crypto.randomUUID(), role: 'tool', text: e.message, isError: true }
        ]
      }))
      break
  }
}

function summarizeResult(result: unknown): string {
  const r = result as { content?: { text?: string }[] } | undefined
  return r?.content?.map((c) => c.text ?? '').join('\n') ?? i18n.t('chat.toolDone')
}

/**
 * Rebuild the UI message list from persisted pi-agent-core messages when a
 * session is (re)opened. Mirrors what the live event stream (`applyEvent`)
 * renders, so a reopened session looks identical to one watched in real time:
 *   - user / assistant text -> a single bubble
 *   - each assistant toolCall -> a tool bubble keyed by the call id…
 *   - …whose text is filled in by the matching toolResult message
 *   - a turn's `thinking` parts -> attached to its first assistant bubble (or a
 *     standalone reasoning-only bubble for a tools-only turn), mirroring how the
 *     live stream stamps reasoning onto the streaming bubble.
 */
function hydrateMessages(raw: unknown[]): UiMessage[] {
  const out: UiMessage[] = []
  const toolBubbles = new Map<string, UiMessage>()

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const m = item as {
      id?: string
      role?: string
      content?: unknown
      toolCallId?: string
      toolName?: string
      isError?: boolean
    }
    switch (m.role) {
      case 'user': {
        const text = partsToText(m.content)
        if (text) out.push({ id: m.id ?? crypto.randomUUID(), role: 'user', text, sourceIndex: i })
        break
      }
      case 'assistant': {
        // Walk the content parts in order, mirroring the live stream's bubble
        // rule (applyEvent): consecutive text accumulates into one bubble, and a
        // tool call breaks it — so text that sits *between* two tool calls keeps
        // them in separate render groups. Front-loading all text then all tools
        // would regroup the tools and make a replayed session look different
        // from the one watched live.
        // The message id is the batch id every tool call in this turn shares —
        // the same value the live stream stamps from this turn's message_start —
        // so a parallel batch folds into one group identically on replay.
        const parts = Array.isArray(m.content) ? m.content : []
        const batchId = m.id ?? crypto.randomUUID()
        // The whole turn's reasoning, attached to the first assistant bubble below.
        const turnThinking = parts
          .filter((p) => isPart(p, 'thinking'))
          .map((p) => String((p as { thinking?: unknown }).thinking ?? ''))
          .join('')
        const hasText = parts.some(
          (p) => isPart(p, 'text') && String((p as { text?: unknown }).text ?? '').trim()
        )
        // Tools-only (or empty) turn with reasoning: emit a standalone reasoning
        // bubble before the tool calls, matching the live thinking-only bubble.
        if (turnThinking && !hasText) {
          out.push({ id: batchId, role: 'assistant', text: '', thinking: turnThinking, sourceIndex: i })
        }
        let buf = ''
        let textIdx = 0
        const flushText = (): void => {
          if (!buf) return
          const id = textIdx === 0 ? batchId : `${batchId}-t${textIdx}`
          out.push({
            id,
            role: 'assistant',
            text: buf,
            // Reasoning rides on the first text bubble of the turn.
            thinking: textIdx === 0 ? turnThinking || undefined : undefined,
            sourceIndex: i
          })
          textIdx++
          buf = ''
        }
        for (const p of parts) {
          if (isPart(p, 'text')) {
            buf += String((p as { text?: unknown }).text ?? '')
          } else if (isPart(p, 'toolCall')) {
            flushText()
            const call = p as { id: string; name: string; arguments?: unknown }
            const bubble: UiMessage = {
              id: call.id,
              role: 'tool',
              toolName: call.name,
              text: '',
              toolArg: toolArgSummary(call.name, call.arguments),
              batchId
            }
            toolBubbles.set(call.id, bubble)
            out.push(bubble)
          }
        }
        flushText()
        break
      }
      case 'toolResult': {
        const text = partsToText(m.content) || i18n.t('chat.toolDone')
        const existing = m.toolCallId ? toolBubbles.get(m.toolCallId) : undefined
        if (existing) {
          existing.text = text
          // Carry the persisted error flag so a failed call stays red on replay,
          // mirroring the live stream's tool_execution_end (isError: e.isError).
          existing.isError = Boolean(m.isError)
        }
        // An orphan result (no matching call) stands alone in its own batch.
        else
          out.push({
            id: m.toolCallId ?? crypto.randomUUID(),
            role: 'tool',
            toolName: m.toolName,
            text,
            isError: Boolean(m.isError),
            batchId: m.toolCallId ?? crypto.randomUUID()
          })
        break
      }
    }
  }

  // A tool call still mid-flight when the session was last persisted has no
  // result message; show the same placeholder the live stream uses.
  for (const b of toolBubbles.values()) {
    if (!b.text) {
      b.text = i18n.t('chat.toolRunning', { tool: i18n.t(toolDisplayKey(b.toolName)) })
      b.running = true
    }
  }
  return out
}

/** Flatten pi message content (string or part array) into plain text. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (isPart(p, 'text') ? String((p as { text?: unknown }).text ?? '') : ''))
    .join('')
}

function isPart(p: unknown, type: string): boolean {
  return Boolean(p && typeof p === 'object' && (p as { type?: string }).type === type)
}
