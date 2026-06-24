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
  type SkillSummary,
  type SocketAuth
} from '@flairy/shared'
import { getAuthToken } from '../store/secrets'
import { saveCachedConfig, loadCachedConfig, clearCachedConfig } from '../store/config-cache'
import { materializeSkills } from '../agent/skill-materializer'

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
  /** JWT used for the active socket; reused for REST skill materialization. */
  private token: string | undefined

  constructor() {
    // Seed from the encrypted on-disk cache so the client is usable before the
    // server delivers a fresh snapshot (and through a server outage entirely).
    this.config = loadCachedConfig()
  }

  /** Open the socket using a previously obtained JWT. Idempotent-ish: reconnects. */
  connect(token: string): void {
    this.disconnect()
    this.token = token

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
      console.log('[sync] socket connected; pulling sessions + memories')
      this.pullSessions()
      this.pullMemories()
    })

    socket.on('connect_error', (err) => {
      console.error('[sync] socket connect_error:', err.message)
    })

    socket.on('disconnect', (reason) => {
      console.log('[sync] socket disconnected:', reason)
    })

    // Manager-level reconnection events: log each backoff attempt so the retry
    // cadence is observable. (`socket.io` is the shared Manager; these don't fire
    // on the Socket itself.)
    socket.io.on('reconnect_attempt', (attempt) => {
      console.log('[sync] reconnect attempt', attempt)
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
  }

  /**
   * Forget the current config entirely (sign-out): drop the in-memory snapshot
   * and the encrypted on-disk cache so no stale config survives the next launch.
   * Kept separate from disconnect(), which fires on every reconnect.
   */
  clearConfig(): void {
    this.config = null
    clearCachedConfig()
  }

  /** Latest full config, or null until the server delivers the first snapshot. */
  getConfig(): ConfigSnapshot | null {
    return this.config
  }

  /** Subscribe to config changes. Fires immediately if a snapshot already exists. */
  onConfig(cb: ConfigListener): () => void {
    this.configListeners.add(cb)
    if (this.config) cb(this.config)
    return () => this.configListeners.delete(cb)
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
    if (!this.config) return
    for (const cb of this.configListeners) cb(this.config)
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
    mcpServers: update.mcpServers ?? current.mcpServers,
    skills: update.skills ?? current.skills,
    systemPrompts: update.systemPrompts ?? current.systemPrompts,
    version: update.version
  }
}
