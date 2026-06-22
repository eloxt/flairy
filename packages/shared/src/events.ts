/**
 * socket.io event contract. Event names are constants — never hardcode strings.
 * The typed event maps below plug into socket.io's generics on both ends:
 *   client: io<ServerToClientEvents, ClientToServerEvents>(url)
 *   server (socketioxide): emits/handlers must match these payloads.
 */

import type { ConfigSnapshot, ConfigUpdate } from './config.js'
import type { Session, SessionWithMessages, SyncMessage } from './session.js'

export const SocketEvent = {
  ConfigSnapshot: 'config:snapshot',
  ConfigUpdated: 'config:updated',
  SessionUpsert: 'session:upsert',
  SessionPatch: 'session:patch',
  SessionPull: 'session:pull',
  SessionRemote: 'session:remote'
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

/** Client → server: pull sessions changed since a watermark (all if omitted). */
export interface SessionPullPayload {
  since?: number
}

/** Server → client: another device changed a session. */
export type SessionRemotePayload = SessionWithMessages

/* ---------- typed socket.io maps ---------- */

export interface ServerToClientEvents {
  'config:snapshot': (payload: ConfigSnapshot) => void
  'config:updated': (payload: ConfigUpdate) => void
  'session:remote': (payload: SessionRemotePayload) => void
}

export interface ClientToServerEvents {
  'session:upsert': (payload: SessionUpsertPayload, ack?: (ok: boolean) => void) => void
  'session:patch': (payload: SessionPatchPayload, ack?: (ok: boolean) => void) => void
  'session:pull': (
    payload: SessionPullPayload,
    ack?: (sessions: SessionWithMessages[]) => void
  ) => void
}
