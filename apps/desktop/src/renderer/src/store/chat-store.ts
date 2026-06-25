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
   * For a `user` bubble submitted WHILE a turn was already running: the text was
   * routed to pi as a steering message, which only injects at the next turn
   * boundary. Marks the optimistic bubble as pending until then (cleared on the
   * next `message_start` for the session), so it doesn't look already-delivered.
   */
  queued?: boolean
  /**
   * For a `user` bubble: images the user attached, shown as thumbnails. Populated
   * optimistically on send and rebuilt from the persisted image content parts on
   * replay. Raw base64 (no data: prefix), same shape the viewer window consumes.
   */
  images?: { data: string; mimeType: string }[]
  /**
   * For a `user` bubble with images sent to a model that can't read them: pi
   * dropped the pictures before the request. Set at send time (live only — not
   * rebuilt on replay, since the model may differ later) to flag in the transcript
   * that the image was never seen.
   */
  imagesIgnored?: boolean
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

/**
 * The complete live state of ONE session, kept independently of which session is
 * in the foreground. Every session the user has opened (or started) this app-run
 * has a runtime in `runtimes`; the agent's stream is folded into the matching
 * runtime regardless of what's on screen, so a background session keeps building
 * its thread and switching back shows the true live state (not a stale DB read).
 */
export interface SessionRuntime {
  messages: UiMessage[]
  running: boolean
  /**
   * The assistant turn currently streaming in THIS session, used to stamp a
   * shared `batchId` onto the turn's tool calls. Per-session (not a module
   * global) so two concurrently-running sessions never cross-stamp batches.
   */
  liveBatchId: string | null
  approvalQueue: ApprovalRequestPayload[]
  questionQueue: QuestionRequestPayload[]
  /**
   * True once seeded from the main process (live in-memory or persisted). Guards
   * `openSession` from re-reading the DB over an already-live runtime, which is
   * exactly what used to clobber an in-flight stream on switch-back.
   */
  hydrated: boolean
}

/** A blank runtime for a brand-new session (or the home screen before send). */
function emptyRuntime(): SessionRuntime {
  return {
    messages: [],
    running: false,
    liveBatchId: null,
    approvalQueue: [],
    questionQueue: [],
    hydrated: true
  }
}

interface ChatState {
  sessionId: string | null
  sessions: SessionMeta[]
  /**
   * Per-session live state, keyed by sessionId. Source of truth for messages /
   * running / queues; the top-level `messages`/`running`/`approvalQueue`/
   * `questionQueue`/`permissionMode` fields below are a denormalized MIRROR of the
   * foreground session's runtime, kept so components read them without selecting
   * through the map.
   */
  runtimes: Record<string, SessionRuntime>
  /**
   * Ids of sessions with a turn currently running. Updated only when a session's
   * running flag flips (not on every token), so the sidebar's running indicators
   * don't re-render on each streamed delta.
   */
  runningSessions: string[]
  messages: UiMessage[]
  running: boolean
  /** Pending approval requests, oldest first; the dialog shows the head. */
  approvalQueue: ApprovalRequestPayload[]
  /** Pending `ask` questions for the open session, oldest first; each renders a card. */
  questionQueue: QuestionRequestPayload[]
  /** Global tool-approval posture; applies to every session (resets to 'ask' on restart). */
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
  send: (
    text: string,
    attachments?: Attachment[],
    opts?: { imagesIgnored?: boolean }
  ) => Promise<void>
  abort: () => void
  respondApproval: (approvalId: string, approved: boolean, scope?: ApprovalScope) => void
  /** Submit the user's answers for an `ask` question and drop it from the queue. */
  respondQuestion: (questionId: string, answers: QuestionAnswer[]) => void
  setPermissionMode: (mode: PermissionMode) => void
  setWorkingDirectory: () => Promise<void>
  loadRecentDirs: () => Promise<void>
  chooseWorkingDirectory: (path: string) => Promise<void>
  removeRecentDir: (path: string) => Promise<void>
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
  runtimes: {},
  runningSessions: [],
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
    // Route prompts to the OWNING session's runtime, not just the foreground one
    // — a background session that hits the approval gate must still collect its
    // prompt (else its turn hangs forever). The card renders when that session is
    // in front (the foreground mirror); switching to it surfaces the prompt.
    const offApproval = window.api.onApprovalRequest((req) => {
      updateRuntime(set, get, req.sessionId, (rt) => ({
        ...rt,
        approvalQueue: [...rt.approvalQueue, req]
      }))
    })
    const offQuestion = window.api.onQuestionRequest((req) => {
      updateRuntime(set, get, req.sessionId, (rt) => ({
        ...rt,
        questionQueue: [...rt.questionQueue, req]
      }))
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
          // screen rather than render a now-orphaned conversation, and discard
          // its runtime.
          set((s) => {
            const { [current]: _gone, ...runtimes } = s.runtimes
            return {
              sessionId: null,
              runtimes,
              runningSessions: s.runningSessions.filter((id) => id !== current),
              ...mirror(null)
            }
          })
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
    const scrollIndex = typeof msgIndex === 'number' && msgIndex >= 0 ? msgIndex : null
    // Already live in this renderer (foreground earlier, or running in the
    // background): just bring it to front from its runtime — DON'T reload, that
    // would overwrite an in-flight stream with a stale persisted snapshot.
    const existing = get().runtimes[meta.id]
    if (existing?.hydrated) {
      set({ sessionId: meta.id, pendingCwd: null, pendingScrollIndex: scrollIndex, ...mirror(existing) })
      return
    }
    // Cold open: seed from the main process's LIVE state (in-memory messages +
    // running flag for a session running in the background; persisted snapshot
    // otherwise). Permission mode is per-session in-memory, defaulting to 'ask'.
    const { messages, running } = await window.api.loadSessionLive(meta.id)
    const rt: SessionRuntime = {
      ...emptyRuntime(),
      messages: hydrateMessages(messages),
      running
    }
    set((s) => ({
      sessionId: meta.id,
      runtimes: { ...s.runtimes, [meta.id]: rt },
      runningSessions: running
        ? [...s.runningSessions.filter((id) => id !== meta.id), meta.id]
        : s.runningSessions.filter((id) => id !== meta.id),
      pendingCwd: null,
      pendingScrollIndex: scrollIndex,
      ...mirror(rt)
    }))
  },

  clearPendingScroll: () => set({ pendingScrollIndex: null }),

  /**
   * Return to the home screen (no active session, empty thread). We deliberately
   * do NOT create a session here — that happens lazily on the first `send`, so
   * clicking "New chat" repeatedly never litters the history with empty chats.
   */
  newChat: async (cwd) => {
    set((s) => ({
      sessionId: null,
      // Clear the foreground mirror to the home/empty state; background runtimes
      // stay intact so any running session keeps streaming into its own runtime.
      ...mirror(null),
      pendingScrollIndex: null,
      // Inherit the directory in effect by default; an explicit arg overrides.
      pendingCwd: cwd === undefined ? selectCwd(s) : cwd
    }))
  },

  send: async (text, attachments, opts) => {
    if (!text.trim() && !attachments?.length) return
    // Lazily create the session on the first message. From the home screen there
    // is no sessionId yet; spin one up (with a runtime, so events have somewhere
    // to land) and switch to it before sending.
    let sessionId = get().sessionId
    if (!sessionId) {
      const meta = await window.api.createSession({ cwd: get().pendingCwd ?? '~' })
      // The approval posture is global (main applies it to every new service), so
      // there's nothing session-specific to carry over here.
      sessionId = meta.id
      const rt = emptyRuntime()
      set((s) => ({
        sessions: [meta, ...s.sessions],
        sessionId: meta.id,
        runtimes: { ...s.runtimes, [meta.id]: rt },
        pendingCwd: null,
        ...mirror(rt)
      }))
    }
    // The bubble shows the typed text (may be empty) plus image thumbnails; an
    // image-only send renders just the thumbnails, so no placeholder text is needed.
    const images = attachments?.map((a) => ({ data: a.data, mimeType: a.mimeType }))
    // Captured at send time: the active model couldn't read images, so pi will
    // drop these before the request. Stamped on the bubble so the transcript shows
    // the picture was never seen — the composer's pre-send banner is gone by now.
    const imagesIgnored = Boolean(opts?.imagesIgnored && images?.length)
    // Running already? Then main routes this submit to pi as a steering message;
    // mark the optimistic bubble "queued" until pi injects it at the next turn
    // boundary (cleared on the next message_start for this session).
    const wasRunning = get().runtimes[sessionId]?.running ?? false
    updateRuntime(set, get, sessionId, (rt) => ({
      ...rt,
      running: true,
      messages: [
        ...rt.messages,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: text.trim(),
          images: images?.length ? images : undefined,
          imagesIgnored: imagesIgnored || undefined,
          queued: wasRunning || undefined
        }
      ]
    }))
    try {
      await window.api.prompt({ sessionId, text, attachments })
    } catch (err) {
      updateRuntime(set, get, sessionId, (rt) => ({
        ...rt,
        running: false,
        messages: [
          ...rt.messages,
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
    if (!sessionId) return
    window.api.abort({ sessionId })
    // Main settles any open approval/question for the aborted session; clear the
    // foreground session's queues + running flag to match.
    updateRuntime(set, get, sessionId, (rt) => ({
      ...rt,
      running: false,
      approvalQueue: [],
      questionQueue: []
    }))
  },

  respondApproval: (approvalId, approved, scope = 'once') => {
    // The approval may belong to a background session; find its owning runtime so
    // dropping it stays correct regardless of which session is in front.
    const owner = ownerOf(get().runtimes, (rt) =>
      rt.approvalQueue.some((r) => r.approvalId === approvalId)
    )
    if (!owner) return
    window.api.respondApproval({ approvalId, approved, scope })
    updateRuntime(set, get, owner, (rt) => ({
      ...rt,
      approvalQueue: rt.approvalQueue.filter((r) => r.approvalId !== approvalId)
    }))
  },

  respondQuestion: (questionId, answers) => {
    const owner = ownerOf(get().runtimes, (rt) =>
      rt.questionQueue.some((r) => r.questionId === questionId)
    )
    if (!owner) return
    window.api.respondQuestion({ questionId, answers })
    updateRuntime(set, get, owner, (rt) => ({
      ...rt,
      questionQueue: rt.questionQueue.filter((r) => r.questionId !== questionId)
    }))
  },

  setPermissionMode: (mode) => {
    // Global posture: update local state and tell main, which applies it to every
    // session (live now, and any created later). No sessionId needed.
    set({ permissionMode: mode })
    void window.api.setPermissionMode(mode)
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
  // Apply the cwd optimistically and SYNCHRONOUSLY (before any await) so the
  // store update batches into the same commit as the menu's close — exactly how
  // the synchronous permission menu behaves. Letting the IPC round-trip land the
  // update instead would re-render mid close-animation and flash the menu.
  chooseWorkingDirectory: async (path) => {
    const sessionId = get().sessionId
    if (sessionId) {
      set((s) => ({
        sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, cwd: path } : m)),
      }))
    } else {
      set({ pendingCwd: path })
    }
    // Persist + rebind the agent in the background. The returned meta carries the
    // canonical (normalized) cwd; reconciling it is a visual no-op since we
    // already show this path, so it can't reintroduce the flash.
    const updated = await window.api.chooseDirectory({ sessionId, path })
    if (sessionId && updated) {
      set((s) => ({ sessions: s.sessions.map((m) => (m.id === updated.id ? updated : m)) }))
    }
  },

  // Forget a recent directory (composer menu right-click). Local convenience
  // list only — doesn't touch the current session's cwd. Use main's returned
  // list as the source of truth instead of filtering optimistically.
  removeRecentDir: async (path) => {
    const dirs = await window.api.removeRecentDirectory(path)
    set({ recentDirs: dirs })
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
      const { [sessionId]: _gone, ...runtimes } = s.runtimes
      return {
        sessions: s.sessions.filter((m) => m.id !== sessionId),
        runtimes,
        runningSessions: s.runningSessions.filter((id) => id !== sessionId),
        // Deleting the open session drops us back to the home screen.
        sessionId: current ? null : s.sessionId,
        ...(current ? mirror(null) : {})
      }
    })
  }
}))

/**
 * Mirror a runtime onto the top-level convenience fields (what components read).
 * `null` yields the empty home-screen state. Keeping the foreground runtime
 * denormalized here means components don't have to select through `runtimes`.
 */
function mirror(rt: SessionRuntime | null): {
  messages: UiMessage[]
  running: boolean
  approvalQueue: ApprovalRequestPayload[]
  questionQueue: QuestionRequestPayload[]
} {
  return {
    messages: rt?.messages ?? [],
    running: rt?.running ?? false,
    approvalQueue: rt?.approvalQueue ?? [],
    questionQueue: rt?.questionQueue ?? []
  }
}

/** The id of the first runtime matching `pred`, or undefined. */
function ownerOf(
  runtimes: Record<string, SessionRuntime>,
  pred: (rt: SessionRuntime) => boolean
): string | undefined {
  for (const [id, rt] of Object.entries(runtimes)) if (pred(rt)) return id
  return undefined
}

/**
 * Apply `fn` to one session's runtime and write it back. Recomputes `runningSessions`
 * only when that session's running flag flips, and — when the session is in the
 * foreground — refreshes the top-level mirror so the on-screen view updates. A
 * no-op if the session has no runtime (e.g. an event for a session not open here).
 */
function updateRuntime(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
  sessionId: string,
  fn: (rt: SessionRuntime) => SessionRuntime
): void {
  const cur = get().runtimes[sessionId]
  if (!cur) return
  const next = fn(cur)
  set((s) => {
    const runningChanged = cur.running !== next.running
    const runningSessions = runningChanged
      ? next.running
        ? [...s.runningSessions.filter((id) => id !== sessionId), sessionId]
        : s.runningSessions.filter((id) => id !== sessionId)
      : s.runningSessions
    return {
      runtimes: { ...s.runtimes, [sessionId]: next },
      runningSessions,
      ...(s.sessionId === sessionId ? mirror(next) : {})
    }
  })
}

/**
 * Fold a streamed agent event into the OWNING session's runtime — regardless of
 * whether that session is in the foreground. This is what lets a background
 * session keep building its thread; `updateRuntime` refreshes the on-screen
 * mirror only when the event's session is the one in front. A no-op for a session
 * with no runtime here (it was never opened/started in this renderer).
 *
 * The streaming-batch id lives on the runtime (`rt.liveBatchId`), so two sessions
 * running at once never cross-stamp each other's tool batches.
 */
function applyEvent(
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  get: () => ChatState,
  env: AgentEventEnvelope
): void {
  const e = env.event
  const sessionId = env.sessionId

  switch (e.type) {
    case 'agent_start':
      updateRuntime(set, get, sessionId, (rt) => ({ ...rt, running: true }))
      break
    case 'message_start':
      // New turn → new batch for the tool calls it's about to issue. Also clear
      // any "queued" flags: reaching a turn boundary means a steered message is
      // now actually injected, so its optimistic bubble shouldn't read as pending.
      updateRuntime(set, get, sessionId, (rt) => ({
        ...rt,
        liveBatchId: e.messageId || crypto.randomUUID(),
        messages: rt.messages.some((m) => m.queued)
          ? rt.messages.map((m) => (m.queued ? { ...m, queued: undefined } : m))
          : rt.messages
      }))
      break
    case 'message_update': {
      // text deltas carry the visible body, thinking deltas the reasoning stream;
      // both belong to the same streaming assistant bubble. A toolcall delta has
      // neither and must not spawn a blank bubble.
      const td = e.thinkingDelta ?? ''
      if (!e.delta && !td) break
      updateRuntime(set, get, sessionId, (rt) => {
        const last = rt.messages[rt.messages.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          const updated = {
            ...last,
            text: e.delta ? last.text + e.delta : last.text,
            thinking: td ? (last.thinking ?? '') + td : last.thinking
          }
          return { ...rt, messages: [...rt.messages.slice(0, -1), updated] }
        }
        return {
          ...rt,
          messages: [
            ...rt.messages,
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
        updateRuntime(set, get, sessionId, (rt) => ({
          ...rt,
          messages: rt.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        }))
        break
      }
      updateRuntime(set, get, sessionId, (rt) => {
        // Defensive: ensure the batch id is set even if message_start was missed.
        const liveBatchId = e.messageId || rt.liveBatchId
        const last = rt.messages[rt.messages.length - 1]
        // Finalize the streamed bubble with the authoritative full text +
        // reasoning (deltas win; fall back to the end payload if they were empty).
        if (last?.role === 'assistant' && last.streaming) {
          const finalized = {
            ...last,
            text: e.text || last.text,
            thinking: last.thinking || e.thinking || undefined,
            streaming: false
          }
          return { ...rt, liveBatchId, messages: [...rt.messages.slice(0, -1), finalized] }
        }
        // …or build it now if deltas never produced a visible bubble
        // (non-streaming response, empty/garbled deltas).
        if (e.text || e.thinking) {
          return {
            ...rt,
            liveBatchId,
            messages: [
              ...rt.messages,
              {
                id: e.messageId || crypto.randomUUID(),
                role: 'assistant',
                text: e.text ?? '',
                thinking: e.thinking || undefined
              }
            ]
          }
        }
        return {
          ...rt,
          liveBatchId,
          messages: rt.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        }
      })
      break
    case 'tool_execution_start':
      updateRuntime(set, get, sessionId, (rt) => ({
        ...rt,
        messages: [
          ...rt.messages,
          {
            id: e.toolCallId,
            role: 'tool',
            toolName: e.name,
            text: i18n.t('chat.toolRunning', { tool: i18n.t(toolDisplayKey(e.name)) }),
            running: true,
            toolArg: toolArgSummary(e.name, e.args),
            batchId: rt.liveBatchId ?? e.toolCallId
          }
        ]
      }))
      break
    case 'tool_execution_end':
      updateRuntime(set, get, sessionId, (rt) => ({
        ...rt,
        messages: rt.messages.map((m) =>
          m.id === e.toolCallId
            ? { ...m, text: summarizeResult(e.result), isError: e.isError, running: false }
            : m
        )
      }))
      break
    case 'agent_end':
      updateRuntime(set, get, sessionId, (rt) => ({ ...rt, running: false }))
      break
    case 'error':
      updateRuntime(set, get, sessionId, (rt) => ({
        ...rt,
        running: false,
        messages: [
          ...rt.messages,
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
        const images = partsToImages(m.content)
        if (text || images.length)
          out.push({
            id: m.id ?? crypto.randomUUID(),
            role: 'user',
            text,
            images: images.length ? images : undefined,
            sourceIndex: i
          })
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

/** Pull image content parts out of a pi message into the bubble's image shape. */
function partsToImages(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((p) => isPart(p, 'image'))
    .map((p) => {
      const img = p as { data?: unknown; mimeType?: unknown }
      return { data: String(img.data ?? ''), mimeType: String(img.mimeType ?? 'image/png') }
    })
    .filter((img) => img.data)
}

function isPart(p: unknown, type: string): boolean {
  return Boolean(p && typeof p === 'object' && (p as { type?: string }).type === type)
}
