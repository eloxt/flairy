import { create } from 'zustand'
import type {
  AgentEventEnvelope,
  ApprovalRequestPayload,
  ApprovalScope,
  Attachment,
  PermissionMode,
  SessionMeta
} from '@shared/ipc'
import { toolDisplayKey } from '@/lib/tool-display'
import i18n from '@/i18n'

/** A rendered chat message in the UI (distinct from pi's internal messages). */
export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  isError?: boolean
  streaming?: boolean
  /**
   * Whether a tool call is still executing. Drives the pulsing status dot —
   * kept separate from `text` so the indicator survives translation (the text
   * is a localized placeholder that would otherwise have to be string-matched).
   */
  running?: boolean
}

interface ChatState {
  sessionId: string | null
  sessions: SessionMeta[]
  messages: UiMessage[]
  running: boolean
  /** Pending approval requests, oldest first; the dialog shows the head. */
  approvalQueue: ApprovalRequestPayload[]
  /** Tool-approval posture for the open session (in-memory, resets to 'ask'). */
  permissionMode: PermissionMode
  /**
   * Working directory chosen on the home screen before a session exists. Applied
   * to the session that's lazily created on the first message, then cleared.
   */
  pendingCwd: string | null
  /** Previously-used working directories, newest first; fills the directory menu. */
  recentDirs: string[]

  init: () => () => void
  loadSessions: () => Promise<SessionMeta[]>
  openSession: (meta: SessionMeta) => Promise<void>
  newChat: () => Promise<void>
  send: (text: string, attachments?: Attachment[]) => Promise<void>
  abort: () => void
  respondApproval: (approvalId: string, approved: boolean, scope?: ApprovalScope) => void
  setPermissionMode: (mode: PermissionMode) => void
  setWorkingDirectory: () => Promise<void>
  loadRecentDirs: () => Promise<void>
  chooseWorkingDirectory: (path: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
}

export const useChat = create<ChatState>((set, get) => ({
  sessionId: null,
  sessions: [],
  messages: [],
  running: false,
  approvalQueue: [],
  permissionMode: 'ask',
  pendingCwd: null,
  recentDirs: [],

  /** Subscribe to the main-process event stream. Call once on mount. */
  init: () => {
    const offEvent = window.api.onAgentEvent((env) => applyEvent(set, get, env))
    const offApproval = window.api.onApprovalRequest((req) => {
      if (req.sessionId === get().sessionId)
        set((s) => ({ approvalQueue: [...s.approvalQueue, req] }))
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
        const sessions = await get().loadSessions()
        console.log('[sync] SessionsChanged → reloaded', sessions.length, 'session(s)')
        if (!get().sessionId && sessions[0]) await get().openSession(sessions[0])
      })()
    })
    return () => {
      offEvent()
      offApproval()
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

  openSession: async (meta) => {
    const { messages } = await window.api.loadSession(meta.id)
    // Permission mode is per-session and in-memory; a freshly opened session
    // starts at 'ask' (mirrors the main-process AgentService default).
    set({
      sessionId: meta.id,
      messages: hydrateMessages(messages),
      running: false,
      permissionMode: 'ask',
      pendingCwd: null
    })
  },

  /**
   * Return to the home screen (no active session, empty thread). We deliberately
   * do NOT create a session here — that happens lazily on the first `send`, so
   * clicking "New chat" repeatedly never litters the history with empty chats.
   */
  newChat: async () => {
    set({
      sessionId: null,
      messages: [],
      running: false,
      permissionMode: 'ask',
      pendingCwd: null
    })
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
    case 'message_update':
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          const updated = { ...last, text: last.text + e.delta }
          return { messages: [...s.messages.slice(0, -1), updated] }
        }
        return {
          messages: [
            ...s.messages,
            { id: e.messageId || crypto.randomUUID(), role: 'assistant', text: e.delta, streaming: true }
          ]
        }
      })
      break
    case 'message_end':
      // pi emits message_end for the user prompt too; only assistant turns echo.
      if (e.role !== 'assistant') {
        set((s) => ({
          messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        }))
        break
      }
      set((s) => {
        const last = s.messages[s.messages.length - 1]
        // Finalize the streamed bubble with the authoritative full text…
        if (last?.role === 'assistant' && last.streaming) {
          const finalized = { ...last, text: e.text || last.text, streaming: false }
          return { messages: [...s.messages.slice(0, -1), finalized] }
        }
        // …or build it now if deltas never produced a visible bubble
        // (non-streaming response, empty/garbled deltas).
        if (e.text) {
          return {
            messages: [
              ...s.messages,
              { id: e.messageId || crypto.randomUUID(), role: 'assistant', text: e.text }
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
            running: true
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
 * Thinking parts are dropped (they never reach the rendered body live either).
 */
function hydrateMessages(raw: unknown[]): UiMessage[] {
  const out: UiMessage[] = []
  const toolBubbles = new Map<string, UiMessage>()

  for (const item of raw) {
    const m = item as {
      id?: string
      role?: string
      content?: unknown
      toolCallId?: string
      toolName?: string
    }
    switch (m.role) {
      case 'user': {
        const text = partsToText(m.content)
        if (text) out.push({ id: m.id ?? crypto.randomUUID(), role: 'user', text })
        break
      }
      case 'assistant': {
        const parts = Array.isArray(m.content) ? m.content : []
        const text = partsToText(parts)
        if (text) out.push({ id: m.id ?? crypto.randomUUID(), role: 'assistant', text })
        for (const p of parts) {
          if (isPart(p, 'toolCall')) {
            const call = p as { id: string; name: string }
            const bubble: UiMessage = { id: call.id, role: 'tool', toolName: call.name, text: '' }
            toolBubbles.set(call.id, bubble)
            out.push(bubble)
          }
        }
        break
      }
      case 'toolResult': {
        const text = partsToText(m.content) || i18n.t('chat.toolDone')
        const existing = m.toolCallId ? toolBubbles.get(m.toolCallId) : undefined
        if (existing) existing.text = text
        else out.push({ id: m.toolCallId ?? crypto.randomUUID(), role: 'tool', toolName: m.toolName, text })
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
