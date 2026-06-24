/**
 * socket.io event contract. Event names are constants — never hardcode strings.
 * The typed event maps below plug into socket.io's generics on both ends:
 *   client: io<ServerToClientEvents, ClientToServerEvents>(url)
 *   server (socketioxide): emits/handlers must match these payloads.
 */

import type { ConfigSnapshot, ConfigUpdate } from './config.js'
import type { Session, SessionWithMessages, SyncMessage } from './session.js'
import type { Memory } from './memory.js'

export const SocketEvent = {
  ConfigSnapshot: 'config:snapshot',
  ConfigUpdated: 'config:updated',
  SessionUpsert: 'session:upsert',
  SessionPatch: 'session:patch',
  SessionDelete: 'session:delete',
  SessionPull: 'session:pull',
  SessionRemote: 'session:remote',
  SessionRemoteDelete: 'session:remote-delete',
  // Long-term memory sync (user-scoped). Mirrors the session sync pattern: the
  // client upserts memories it writes, pulls the full set on (re)connect, and
  // receives `memory:remote` when another device changes them.
  MemoryUpsert: 'memory:upsert',
  MemoryPull: 'memory:pull',
  MemoryRemote: 'memory:remote'
} as const

export type SocketEventName = (typeof SocketEvent)[keyof typeof SocketEvent]

/* ---------- payloads ---------- */

/** Client → server: persist/replace a full session. */
export interface SessionUpsertPayload {
  session: Session
  messages: SyncMessage[]
}

/** Client → server: append messages to an existing session mid-conversation. */
export interface SessionPatchPayload {
  sessionId: string
  appendMessages: SyncMessage[]
  updatedAt: number
  /**
   * When set, also update the session title (used by client-side automatic
   * title generation). Omitted leaves the stored title unchanged. The client
   * only sends this after the session has been upserted, so the row exists.
   */
  title?: string
}

/** Client → server: delete a session (and its messages) everywhere. */
export interface SessionDeletePayload {
  sessionId: string
}

/** Client → server: pull sessions changed since a watermark (all if omitted). */
export interface SessionPullPayload {
  since?: number
}

/** Server → client: another device changed a session. */
export type SessionRemotePayload = SessionWithMessages

/** Server → client: another device deleted a session. */
export interface SessionRemoteDeletePayload {
  sessionId: string
}

/* ---------- memory payloads ---------- */

/**
 * Client → server: persist/replace a batch of memories (keyed by id). Carries
 * soft-deleted entries too (deletedAt set) so a delete propagates like any edit.
 */
export interface MemoryUpsertPayload {
  memories: Memory[]
}

/**
 * Client → server: pull memories changed since a watermark (all if omitted).
 * The reply includes soft-deleted entries so deletions reach a fresh device.
 */
export interface MemoryPullPayload {
  since?: number
}

/** Server → client: memories changed on the user's other devices. */
export interface MemoryRemotePayload {
  memories: Memory[]
}

/* ---------- typed socket.io maps ---------- */

export interface ServerToClientEvents {
  'config:snapshot': (payload: ConfigSnapshot) => void
  'config:updated': (payload: ConfigUpdate) => void
  'session:remote': (payload: SessionRemotePayload) => void
  'session:remote-delete': (payload: SessionRemoteDeletePayload) => void
  'memory:remote': (payload: MemoryRemotePayload) => void
}

export interface ClientToServerEvents {
  'session:upsert': (payload: SessionUpsertPayload, ack?: (ok: boolean) => void) => void
  'session:patch': (payload: SessionPatchPayload, ack?: (ok: boolean) => void) => void
  'session:delete': (payload: SessionDeletePayload, ack?: (ok: boolean) => void) => void
  'session:pull': (
    payload: SessionPullPayload,
    ack?: (sessions: SessionWithMessages[]) => void
  ) => void
  'memory:upsert': (payload: MemoryUpsertPayload, ack?: (ok: boolean) => void) => void
  'memory:pull': (payload: MemoryPullPayload, ack?: (memories: Memory[]) => void) => void
}
