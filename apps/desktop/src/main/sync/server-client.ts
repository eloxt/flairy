import { io, type Socket } from 'socket.io-client'
import {
  SocketEvent,
  type ActiveLlm,
  type ClientToServerEvents,
  type ConfigSnapshot,
  type ConfigUpdate,
  type Memory,
  type MemoryPullPayload,
  type MemoryRemotePayload,
  type MemoryUpsertPayload,
  type ServerToClientEvents,
  type SessionDeletePayload,
  type SessionPatchPayload,
  type SessionPullPayload,
  type SessionRemoteDeletePayload,
  type SessionRemotePayload,
  type SessionUpsertPayload,
  type SessionWithMessages,
  type SkillConfig,
  type SocketAuth
} from '@flairy/shared'
import { getAuthToken } from '../store/secrets'
import { saveCachedConfig, loadCachedConfig } from '../store/config-cache'
import {
  getConfigModePref,
  getConfigSourcesPref,
  getPreferredMainModelPref,
  setConfigModePref,
  setConfigSourcesPref,
  setPreferredMainModelPref
} from '../store/db'
import { loadLocalConfig, type LocalConfigBundle } from '../store/local-config'
import { materializeSkillSet } from '../agent/skill-materializer'
import type { ConfigMode, ConfigSourceMode, ConfigSources, SocketConnectionStatus } from '@shared/ipc'

/**
 * Where to reach the Flairy server.
 *
 * The default is baked in at build time: `electron-vite dev` (DEV=true) points
 * at localhost, while a packaged production build targets the live server.
 * `FLAIRY_SERVER_URL` still overrides both — useful for staging or pointing a
 * dev build at a remote server.
 */
const DEFAULT_SERVER_URL = import.meta.env.DEV
  ? 'http://localhost:8787'
  : 'https://flairy.eloxt.cn'

export const SERVER_URL = process.env.FLAIRY_SERVER_URL ?? DEFAULT_SERVER_URL

type ConfigListener = (config: ConfigSnapshot) => void
type SessionRemoteListener = (payload: SessionRemotePayload) => void
type SessionRemoteDeleteListener = (payload: SessionRemoteDeletePayload) => void
type SessionsPulledListener = (sessions: SessionWithMessages[]) => void
type MemoryRemoteListener = (memories: Memory[]) => void
type MemoriesPulledListener = (memories: Memory[]) => void
type SocketStatusListener = (status: SocketConnectionStatus) => void

/**
 * Thin wrapper around a typed socket.io connection to the Flairy server.
 *
 * Lives entirely in the MAIN process: it holds the JWT and the server-pushed
 * ConfigSnapshot (which carries the LLM credential) and never exposes either to
 * the renderer. The agent reads the latest config through getConfig()/onConfig().
 *
 * Config sync: the server sends a full `config:snapshot` on connect and
 * incremental `config:updated` deltas afterwards; we merge deltas into the held
 * snapshot so getConfig() always returns the current full config.
 *
 * Offline resilience: the last snapshot is cached (encrypted) in SQLite and
 * loaded on construction, so getConfig() returns the last-known config even
 * before — or without — a server connection.
 */
export class ServerClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null
  private config: ConfigSnapshot | null = null
  private configListeners = new Set<ConfigListener>()
  private sessionRemoteListeners = new Set<SessionRemoteListener>()
  private sessionRemoteDeleteListeners = new Set<SessionRemoteDeleteListener>()
  private sessionsPulledListeners = new Set<SessionsPulledListener>()
  private memoryRemoteListeners = new Set<MemoryRemoteListener>()
  private memoriesPulledListeners = new Set<MemoriesPulledListener>()
  private socketStatusListeners = new Set<SocketStatusListener>()
  private socketStatus: SocketConnectionStatus = 'disconnected'
  /** JWT used for the active socket; reused for REST skill materialization. */
  private token: string | undefined
  /**
   * Offline outbox. socket.io's own sendBuffer would queue EVERY emit made while
   * disconnected — including one full session snapshot per finished turn, which
   * grows without bound during a long outage. Instead we coalesce: only the IDs
   * of dirty sessions (their final snapshot is rebuilt from SQLite on reconnect
   * via `sessionPayloadProvider`), latest-wins title patches and memory upserts,
   * and pending deletes. Flushed on `connect` BEFORE the session/memory pull so
   * the pull returns post-flush state.
   */
  private pendingSessionUpserts = new Set<string>()
  private pendingSessionDeletes = new Set<string>()
  private pendingTitlePatches = new Map<string, SessionPatchPayload>()
  private pendingMemoryUpserts = new Map<string, Memory>()
  /** Rebuilds a dirty session's full upsert payload from SQLite (injected). */
  private sessionPayloadProvider: ((sessionId: string) => SessionUpsertPayload | null) | null =
    null
  /**
   * Config source. In `local` mode (account-less use) the socket stays closed
   * and getConfig() returns the user-authored `localConfig`; in `server` mode
   * each category follows its `sources` choice (server / local / merge).
   */
  private configMode: ConfigMode = 'server'
  /** User-authored local config; its skills are summaries. */
  private localConfig: ConfigSnapshot | null = null
  /** Full local skills, materialized to disk alongside the server-pushed ones. */
  private localSkills: SkillConfig[] = []
  /** Per-category source choice (server / local / merge). */
  private sources: ConfigSources = getConfigSourcesPref()
  /**
   * The user's own main-model pick (a model id from `modelOptions`), per
   * device. Applied over the snapshot in effectiveConfig(); null = admin main.
   */
  private preferredMainModelId: string | null = null

  constructor() {
    // Seed from the encrypted on-disk cache so the client is usable before the
    // server delivers a fresh snapshot (and through a server outage entirely).
    this.config = loadCachedConfig()
    this.configMode = getConfigModePref()
    const local = loadLocalConfig()
    this.localConfig = local?.config ?? null
    this.localSkills = local?.skills ?? []
    this.preferredMainModelId = getPreferredMainModelPref()
  }

  /** Open the socket using a previously obtained JWT. Idempotent-ish: reconnects. */
  connect(token: string): void {
    this.disconnect()
    this.token = token
    this.setSocketStatus('connecting')

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
      auth: { token } satisfies SocketAuth,
      transports: ['websocket'],
      // Reconnect with exponential backoff + jitter. socket.io's Manager computes
      // each delay as reconnectionDelay * 2^attempt, capped at reconnectionDelayMax,
      // then randomized by ±randomizationFactor: ~1s, 2s, 4s, 8s, 16s, 30s (capped).
      // Retry forever (a laptop can be offline for hours) and jitter so reconnecting
      // clients don't stampede the server in lockstep after an outage.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5
    })

    socket.on(SocketEvent.ConfigSnapshot, (payload: ConfigSnapshot) => {
      this.config = payload
      saveCachedConfig(payload)
      this.emitConfig()
      this.materializeEffectiveSkills()
    })

    socket.on(SocketEvent.ConfigUpdated, (payload: ConfigUpdate) => {
      this.config = mergeConfig(this.config, payload)
      if (this.config) {
        saveCachedConfig(this.config)
        this.emitConfig()
        this.materializeEffectiveSkills()
      }
    })

    socket.on(SocketEvent.SessionRemote, (payload: SessionRemotePayload) => {
      for (const cb of this.sessionRemoteListeners) cb(payload)
    })

    socket.on(SocketEvent.SessionRemoteDelete, (payload: SessionRemoteDeletePayload) => {
      for (const cb of this.sessionRemoteDeleteListeners) cb(payload)
    })

    socket.on(SocketEvent.MemoryRemote, (payload: MemoryRemotePayload) => {
      for (const cb of this.memoryRemoteListeners) cb(payload.memories)
    })

    // Pull the user's sessions on every (re)connect — including the first one
    // after sign-in — so a fresh device (or a relogin) gets its history back.
    // socket.io fires `connect` on the initial handshake and on every reconnect.
    socket.on('connect', () => {
      if (this.socket !== socket) return
      console.log('[sync] socket connected; pulling sessions + memories')
      this.setSocketStatus('connected')
      // Push local changes made while offline BEFORE pulling, so the pull
      // returns (and re-persists) the post-flush state instead of clobbering
      // newer local history with the server's stale copy.
      this.flushPending()
      this.pullSessions()
      this.pullMemories()
    })

    socket.on('connect_error', (err) => {
      if (this.socket !== socket) return
      console.error('[sync] socket connect_error:', err.message)
      this.setSocketStatus(socket.active ? 'connecting' : 'disconnected')
    })

    socket.on('disconnect', (reason) => {
      if (this.socket !== socket) return
      console.log('[sync] socket disconnected:', reason)
      this.setSocketStatus(socket.active ? 'connecting' : 'disconnected')
    })

    // Manager-level reconnection events: log each backoff attempt so the retry
    // cadence is observable. (`socket.io` is the shared Manager; these don't fire
    // on the Socket itself.)
    socket.io.on('reconnect_attempt', (attempt) => {
      if (this.socket !== socket) return
      console.log('[sync] reconnect attempt', attempt)
      this.setSocketStatus('connecting')
    })

    this.socket = socket
  }

  /**
   * Ask the server for all of the user's sessions and hand the result to the
   * pulled-session listeners (which persist them locally). No-op if offline.
   * Pulls everything (no `since` watermark) so a relogin with an empty/stale
   * local cache is fully repopulated.
   */
  private pullSessions(): void {
    const payload: SessionPullPayload = {}
    if (!this.socket) {
      console.warn('[sync] pullSessions: no socket')
      return
    }
    this.socket.emit(SocketEvent.SessionPull, payload, (sessions) => {
      console.log('[sync] session:pull ack —', sessions?.length ?? 'no', 'sessions')
      for (const cb of this.sessionsPulledListeners) cb(sessions)
    })
  }

  /**
   * Pull the user's memories on (re)connect so a fresh/stale device gets them
   * back. The reply carries tombstones (soft-deleted entries) too, so deletions
   * made elsewhere land locally. No-op if offline. Pulls everything (no `since`).
   */
  private pullMemories(): void {
    const payload: MemoryPullPayload = {}
    if (!this.socket) return
    this.socket.emit(SocketEvent.MemoryPull, payload, (memories) => {
      console.log('[sync] memory:pull ack —', memories?.length ?? 'no', 'memories')
      for (const cb of this.memoriesPulledListeners) cb(memories)
    })
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.setSocketStatus('disconnected')
  }

  /**
   * The config consumers should read, honoring the active mode, with the
   * user's own main-model pick applied when it matches a delivered candidate.
   * A dangling pick (model deleted / no longer selectable / local mode, which
   * carries no candidates) silently falls back to the admin-assigned main.
   */
  private effectiveConfig(): ConfigSnapshot | null {
    const base = this.configMode === 'local' ? this.localConfig : this.mergedConfig()
    if (!base || !this.preferredMainModelId) return base
    const match = base.modelOptions?.find((o) => o.model.id === this.preferredMainModelId)
    return match ? { ...base, llm: { ...base.llm, main: match } } : base
  }

  /**
   * Server-mode composition: each category follows its source choice —
   * `server` uses the pushed entries alone, `local` the user's entries alone
   * (even when that leaves the category empty), and `merge` combines both with
   * the local entries FIRST, so first-match lookups (prompts by name, services)
   * resolve to the user's entry and a server item colliding with a local one
   * (same id; same trimmed name for prompts; same name for skills) is dropped.
   */
  private mergedConfig(): ConfigSnapshot | null {
    const server = this.config
    const local = this.localConfig
    if (!server && !local) return null
    const s = this.sources
    // The default everything-from-server case stays the fast path.
    if (server && Object.values(s).every((v) => v === 'server')) return server

    const pickList = <T>(
      choice: ConfigSourceMode,
      localList: T[],
      serverList: T[],
      collides: (serverItem: T) => boolean
    ): T[] => {
      if (choice === 'server') return serverList
      if (choice === 'local') return localList
      return [...localList, ...serverList.filter((item) => !collides(item))]
    }

    const pickRole = (role: 'main' | 'tool' | 'visual'): ActiveLlm | null => {
      const localRole = local?.llm[role] ?? null
      const serverRole = server?.llm[role] ?? null
      if (s.llm === 'server') return serverRole
      if (s.llm === 'local') return localRole
      return localRole ?? serverRole
    }

    const promptKey = (name: string): string => name.trim().toLowerCase()
    const localMcpIds = new Set((local?.mcpServers ?? []).map((m) => m.id))
    const localPromptKeys = new Set((local?.systemPrompts ?? []).map((p) => promptKey(p.name)))
    const localServiceIds = new Set((local?.services ?? []).map((svc) => svc.id))
    const localSkillNames = new Set((local?.skills ?? []).map((sk) => sk.name))

    return {
      llm: { main: pickRole('main'), tool: pickRole('tool'), visual: pickRole('visual') },
      // Model candidates for the user picker only exist server-side.
      modelOptions: s.llm === 'local' ? undefined : server?.modelOptions,
      mcpServers: pickList(
        s.mcpServers,
        local?.mcpServers ?? [],
        server?.mcpServers ?? [],
        (m) => localMcpIds.has(m.id)
      ),
      skills: pickList(s.skills, local?.skills ?? [], server?.skills ?? [], (sk) =>
        localSkillNames.has(sk.name)
      ),
      systemPrompts: pickList(
        s.systemPrompts,
        local?.systemPrompts ?? [],
        server?.systemPrompts ?? [],
        (p) => localPromptKeys.has(promptKey(p.name))
      ),
      announcements: server?.announcements ?? [],
      services: pickList(s.services, local?.services ?? [], server?.services ?? [], (svc) =>
        localServiceIds.has(svc.id)
      ),
      version: server?.version ?? local?.version ?? 0
    }
  }

  /** Current per-category source choices. */
  getConfigSources(): ConfigSources {
    return { ...this.sources }
  }

  /**
   * Persist + apply new source choices: re-emits the effective config so every
   * consumer re-applies, and reconciles the on-disk skill set (a skills choice
   * flip adds/removes the server-pushed or local skills).
   */
  setConfigSources(sources: ConfigSources): void {
    if (JSON.stringify(sources) === JSON.stringify(this.sources)) return
    this.sources = { ...sources }
    setConfigSourcesPref(this.sources)
    this.emitConfig()
    this.materializeEffectiveSkills()
  }

  /** The user's main-model pick (a model id), or null when following the admin. */
  getPreferredMainModel(): string | null {
    return this.preferredMainModelId
  }

  /**
   * Set (or clear, with null) the user's main-model pick. Persists per device
   * and re-emits the effective config so every consumer — running agents'
   * model/thinking level, the renderer's ConfigChanged broadcast — re-applies
   * live. Setting a pick while no config exists just persists; it activates
   * with the next snapshot.
   */
  setPreferredMainModel(id: string | null): void {
    const next = id || null
    if (next === this.preferredMainModelId) return
    this.preferredMainModelId = next
    setPreferredMainModelPref(next)
    this.emitConfig()
  }

  /**
   * The latest SERVER-pushed snapshot regardless of mode (real secrets). Used to
   * seed the local-config editor and to resolve masked secrets on save. Distinct
   * from getConfig(), which returns the effective (possibly local) config.
   */
  getServerConfig(): ConfigSnapshot | null {
    return this.config
  }

  /** The JWT for REST calls (socket token, else the stored one). */
  getToken(): string | undefined {
    return this.token ?? getAuthToken()
  }

  /** Latest effective config, or null until one is available for the active mode. */
  getConfig(): ConfigSnapshot | null {
    return this.effectiveConfig()
  }

  /** Subscribe to config changes. Fires immediately if a config already exists. */
  onConfig(cb: ConfigListener): () => void {
    this.configListeners.add(cb)
    const cfg = this.effectiveConfig()
    if (cfg) cb(cfg)
    return () => this.configListeners.delete(cb)
  }

  /** Current config source (server ↔ local). */
  getConfigMode(): ConfigMode {
    return this.configMode
  }

  /**
   * Switch config source. `local` closes the socket (fully offline) and applies
   * the user-authored config; `server` reconnects with the stored token and
   * re-adopts the pushed config. Persists the choice and re-emits so every
   * consumer (agent model/prompt/tools, MCP) re-applies from the new source.
   */
  setConfigMode(mode: ConfigMode): void {
    if (this.configMode === mode) return
    this.configMode = mode
    setConfigModePref(mode)
    if (mode === 'local') {
      this.disconnect()
      this.emitConfig()
      this.materializeEffectiveSkills()
    } else {
      this.emitConfig()
      this.materializeEffectiveSkills()
      const token = this.token ?? getAuthToken()
      if (token) this.connect(token)
    }
  }

  /**
   * Replace the user-authored local config and apply it live (re-emit + skill
   * reconcile) — local entries are part of the effective config in BOTH modes.
   * Called after the user saves edits in the Settings config tabs. The bundle is
   * persisted by the caller.
   */
  updateLocalConfig(bundle: LocalConfigBundle): void {
    this.localConfig = bundle.config
    this.localSkills = bundle.skills
    this.emitConfig()
    this.materializeEffectiveSkills()
  }

  /**
   * If launched in local mode, apply the saved local config once at startup
   * (emit + materialize). Server mode is driven by the socket instead. Call after
   * listeners are wired but before/instead of the server auto-connect.
   */
  activateLocalMode(): void {
    if (this.configMode !== 'local') return
    this.emitConfig()
    this.materializeEffectiveSkills()
  }

  /** Current socket.io connection status for renderer indicators. */
  getSocketStatus(): SocketConnectionStatus {
    return this.socketStatus
  }

  /** Subscribe to socket connection status. Fires immediately with the current state. */
  onSocketStatus(cb: SocketStatusListener): () => void {
    this.socketStatusListeners.add(cb)
    cb(this.socketStatus)
    return () => this.socketStatusListeners.delete(cb)
  }

  /** Subscribe to sessions changed on the user's other devices. */
  onSessionRemote(cb: SessionRemoteListener): () => void {
    this.sessionRemoteListeners.add(cb)
    return () => this.sessionRemoteListeners.delete(cb)
  }

  /** Subscribe to a session deleted on the user's other devices. */
  onSessionRemoteDelete(cb: SessionRemoteDeleteListener): () => void {
    this.sessionRemoteDeleteListeners.add(cb)
    return () => this.sessionRemoteDeleteListeners.delete(cb)
  }

  /** Subscribe to the bulk session list pulled from the server on (re)connect. */
  onSessionsPulled(cb: SessionsPulledListener): () => void {
    this.sessionsPulledListeners.add(cb)
    return () => this.sessionsPulledListeners.delete(cb)
  }

  /** Subscribe to memories changed on the user's other devices. */
  onMemoryRemote(cb: MemoryRemoteListener): () => void {
    this.memoryRemoteListeners.add(cb)
    return () => this.memoryRemoteListeners.delete(cb)
  }

  /** Subscribe to the bulk memory list pulled from the server on (re)connect. */
  onMemoriesPulled(cb: MemoriesPulledListener): () => void {
    this.memoriesPulledListeners.add(cb)
    return () => this.memoriesPulledListeners.delete(cb)
  }

  /** Whether the socket is live right now (emits go straight out). */
  private get online(): boolean {
    return this.socket?.connected ?? false
  }

  /** Inject the SQLite-backed payload builder used to flush dirty sessions. */
  setSessionPayloadProvider(fn: (sessionId: string) => SessionUpsertPayload | null): void {
    this.sessionPayloadProvider = fn
  }

  /**
   * Mirror a memory upsert/tombstone batch to the server. Offline, the batch is
   * folded into the outbox (latest updatedAt wins per id) and sent on reconnect.
   */
  sendMemoryUpsert(payload: MemoryUpsertPayload): void {
    if (this.online) {
      this.socket?.emit(SocketEvent.MemoryUpsert, payload)
      return
    }
    for (const m of payload.memories) {
      const prev = this.pendingMemoryUpserts.get(m.id)
      if (!prev || prev.updatedAt <= m.updatedAt) this.pendingMemoryUpserts.set(m.id, m)
    }
  }

  /**
   * Push a full session (create/replace) to the server. Offline, only the
   * session ID is remembered; its FINAL state is rebuilt from SQLite and sent
   * once on reconnect — one snapshot per dirty session instead of one per turn.
   */
  sendSessionUpsert(payload: SessionUpsertPayload): void {
    if (this.online) {
      this.socket?.emit(SocketEvent.SessionUpsert, payload)
      return
    }
    this.pendingSessionUpserts.add(payload.session.id)
  }

  /**
   * Patch an existing server-side session (title-only updates). Offline, kept
   * latest-wins per session and replayed on reconnect so a rename made offline
   * isn't resurrected to the old title by the reconnect pull.
   */
  sendSessionPatch(payload: SessionPatchPayload): void {
    if (this.online) {
      this.socket?.emit(SocketEvent.SessionPatch, payload)
      return
    }
    this.pendingTitlePatches.set(payload.sessionId, payload)
  }

  /**
   * Delete a session server-side (and on the user's other devices). Offline,
   * queued and replayed on reconnect — otherwise the reconnect pull would
   * resurrect a session deleted while offline.
   */
  sendSessionDelete(payload: SessionDeletePayload): void {
    if (this.online) {
      this.socket?.emit(SocketEvent.SessionDelete, payload)
      return
    }
    this.pendingSessionDeletes.add(payload.sessionId)
    // A deleted session needs no snapshot or title patch anymore.
    this.pendingSessionUpserts.delete(payload.sessionId)
    this.pendingTitlePatches.delete(payload.sessionId)
  }

  /** Replay the offline outbox (deletes → snapshots → patches → memories). */
  private flushPending(): void {
    const socket = this.socket
    if (!socket) return
    for (const sessionId of this.pendingSessionDeletes) {
      socket.emit(SocketEvent.SessionDelete, { sessionId })
    }
    this.pendingSessionDeletes.clear()
    for (const sessionId of this.pendingSessionUpserts) {
      // Rebuild the CURRENT snapshot from SQLite; a session deleted/converted
      // to a project in the meantime resolves to null and is skipped.
      const payload = this.sessionPayloadProvider?.(sessionId)
      if (payload) socket.emit(SocketEvent.SessionUpsert, payload)
    }
    this.pendingSessionUpserts.clear()
    for (const payload of this.pendingTitlePatches.values()) {
      socket.emit(SocketEvent.SessionPatch, payload)
    }
    this.pendingTitlePatches.clear()
    if (this.pendingMemoryUpserts.size > 0) {
      socket.emit(SocketEvent.MemoryUpsert, {
        memories: [...this.pendingMemoryUpserts.values()]
      })
      this.pendingMemoryUpserts.clear()
    }
  }

  /** JSON of the last snapshot handed to listeners, for change detection. */
  private lastEmittedConfigJson: string | null = null

  private emitConfig(): void {
    const cfg = this.effectiveConfig()
    if (!cfg) return
    // Dedupe identical snapshots: every socket (re)connect re-delivers a full
    // config:snapshot, and each emit makes EVERY live AgentService rebuild its
    // model/system prompt/tool set (plus a redacted broadcast to all windows).
    // A flaky network would otherwise redo all of that per reconnect for a
    // byte-identical config.
    const json = JSON.stringify(cfg)
    if (json === this.lastEmittedConfigJson) return
    this.lastEmittedConfigJson = json
    for (const cb of this.configListeners) cb(cfg)
  }

  private setSocketStatus(status: SocketConnectionStatus): void {
    if (this.socketStatus === status) return
    this.socketStatus = status
    for (const cb of this.socketStatusListeners) cb(status)
  }

  /**
   * Reconcile the on-disk skill set with the EFFECTIVE config, honoring the
   * skills source choice: server-pushed summaries unless the choice is `local`,
   * the local full skills unless the choice is `server` (account-less local
   * mode is always local-only). Fire-and-forget: the agent reads materialized
   * bodies straight from the on-disk SKILL.md files, so callers never block on
   * this. Uses the socket's JWT, falling back to the stored token.
   */
  private materializeEffectiveSkills(): void {
    const serverMode = this.configMode === 'server'
    const remote =
      serverMode && this.sources.skills !== 'local' ? (this.config?.skills ?? []) : []
    const local = serverMode && this.sources.skills === 'server' ? [] : this.localSkills
    const token = this.token ?? getAuthToken()
    void materializeSkillSet(remote, local, token, SERVER_URL).catch((err) => {
      console.error('[server-client] skill materialization failed:', err)
    })
  }
}

/** Merge a ConfigUpdate delta onto the held snapshot (omitted fields unchanged). */
function mergeConfig(
  current: ConfigSnapshot | null,
  update: ConfigUpdate
): ConfigSnapshot | null {
  if (!current) {
    // We only have a partial delta and no base snapshot; can't form a full
    // ConfigSnapshot. Wait for the next full snapshot instead.
    return current
  }
  return {
    // `llm` is the full role map and is always sent on an update — adopt it
    // wholesale (each role may be null when unassigned).
    llm: update.llm ?? current.llm,
    modelOptions: update.modelOptions ?? current.modelOptions,
    mcpServers: update.mcpServers ?? current.mcpServers,
    skills: update.skills ?? current.skills,
    systemPrompts: update.systemPrompts ?? current.systemPrompts,
    announcements: update.announcements ?? current.announcements,
    services: update.services ?? current.services,
    version: update.version
  }
}
