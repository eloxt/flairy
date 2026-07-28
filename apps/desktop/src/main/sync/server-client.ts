import { io, type Socket } from 'socket.io-client'
import {
  SocketEvent,
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
  type SkillSummary,
  type SocketAuth
} from '@flairy/shared'
import { getAuthToken } from '../store/secrets'
import { saveCachedConfig, loadCachedConfig, clearCachedConfig } from '../store/config-cache'
import {
  getConfigModePref,
  getPreferredMainModelPref,
  setConfigModePref,
  setPreferredMainModelPref
} from '../store/db'
import { loadLocalConfig, clearLocalConfig, type LocalConfigBundle } from '../store/local-config'
import { materializeSkills, materializeLocalSkills } from '../agent/skill-materializer'
import type { ConfigMode, SocketConnectionStatus } from '@shared/ipc'

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
   * Config source. In `local` mode the socket stays closed and getConfig()
   * returns the user-authored `localConfig` instead of the server snapshot.
   */
  private configMode: ConfigMode = 'server'
  /** User-authored local config (detached mode); its skills are summaries. */
  private localConfig: ConfigSnapshot | null = null
  /** Full local skills, materialized to disk when local mode is active. */
  private localSkills: SkillConfig[] = []
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
      this.materialize(payload.skills)
    })

    socket.on(SocketEvent.ConfigUpdated, (payload: ConfigUpdate) => {
      this.config = mergeConfig(this.config, payload)
      if (this.config) {
        saveCachedConfig(this.config)
        this.emitConfig()
        this.materialize(this.config.skills)
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
   * Forget the current config entirely (sign-out): drop the in-memory snapshot
   * and the encrypted on-disk cache so no stale config survives the next launch.
   * Also drops any local config and resets to server mode — a signed-out machine
   * keeps no secrets. Kept separate from disconnect(), which fires on reconnect.
   */
  clearConfig(): void {
    this.config = null
    clearCachedConfig()
    this.localConfig = null
    this.localSkills = []
    clearLocalConfig()
    this.configMode = 'server'
    setConfigModePref('server')
    // A model pick must not leak to the next signed-in account.
    this.preferredMainModelId = null
    setPreferredMainModelPref(null)
  }

  /**
   * The config consumers should read, honoring the active mode, with the
   * user's own main-model pick applied when it matches a delivered candidate.
   * A dangling pick (model deleted / no longer selectable / local mode, which
   * carries no candidates) silently falls back to the admin-assigned main.
   */
  private effectiveConfig(): ConfigSnapshot | null {
    const base = this.configMode === 'local' ? this.localConfig : this.config
    if (!base || !this.preferredMainModelId) return base
    const match = base.modelOptions?.find((o) => o.model.id === this.preferredMainModelId)
    return match ? { ...base, llm: { ...base.llm, main: match } } : base
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
      void materializeLocalSkills(this.localSkills).catch((err) =>
        console.error('[server-client] local skill materialization failed:', err)
      )
    } else {
      this.emitConfig()
      const token = this.token ?? getAuthToken()
      if (token) this.connect(token)
    }
  }

  /**
   * Replace the user-authored local config and, if local mode is active, apply
   * it live (re-emit + re-materialize skills). Called after the user saves edits
   * in Advanced settings. The bundle is persisted by the caller.
   */
  updateLocalConfig(bundle: LocalConfigBundle): void {
    this.localConfig = bundle.config
    this.localSkills = bundle.skills
    if (this.configMode === 'local') {
      this.emitConfig()
      void materializeLocalSkills(this.localSkills).catch((err) =>
        console.error('[server-client] local skill materialization failed:', err)
      )
    }
  }

  /**
   * If launched in local mode, apply the saved local config once at startup
   * (emit + materialize). Server mode is driven by the socket instead. Call after
   * listeners are wired but before/instead of the server auto-connect.
   */
  activateLocalMode(): void {
    if (this.configMode !== 'local') return
    this.emitConfig()
    void materializeLocalSkills(this.localSkills).catch((err) =>
      console.error('[server-client] local skill materialization failed:', err)
    )
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

  /** Mirror a memory upsert/tombstone batch to the server. No-op if offline. */
  sendMemoryUpsert(payload: MemoryUpsertPayload): void {
    this.socket?.emit(SocketEvent.MemoryUpsert, payload)
  }

  /** Push a full session (create/replace) to the server. No-op if offline. */
  sendSessionUpsert(payload: SessionUpsertPayload): void {
    this.socket?.emit(SocketEvent.SessionUpsert, payload)
  }

  /** Append messages to an existing server-side session. No-op if offline. */
  sendSessionPatch(payload: SessionPatchPayload): void {
    this.socket?.emit(SocketEvent.SessionPatch, payload)
  }

  /** Delete a session server-side (and on the user's other devices). No-op if offline. */
  sendSessionDelete(payload: SessionDeletePayload): void {
    this.socket?.emit(SocketEvent.SessionDelete, payload)
  }

  private emitConfig(): void {
    const cfg = this.effectiveConfig()
    if (!cfg) return
    for (const cb of this.configListeners) cb(cfg)
  }

  private setSocketStatus(status: SocketConnectionStatus): void {
    if (this.socketStatus === status) return
    this.socketStatus = status
    for (const cb of this.socketStatusListeners) cb(status)
  }

  /**
   * Materialize the pushed skill summaries to disk. Fire-and-forget: the agent
   * reads materialized bodies straight from the on-disk SKILL.md files, so we
   * don't block the socket handler. Uses the socket's JWT, falling back to the
   * stored token.
   */
  private materialize(skills: SkillSummary[]): void {
    const token = this.token ?? getAuthToken()
    void materializeSkills(skills, token, SERVER_URL).catch((err) => {
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
