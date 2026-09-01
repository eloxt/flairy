/**
 * Session + message contract for multi-device sync.
 *
 * The agent runs on the client; messages are produced locally, mirrored to the
 * server, and pushed to the user's other devices. Sync policy is "local-first +
 * server mirror"; conflicts resolve by newer `updatedAt` (CRDT is a future
 * upgrade).
 */

export type MessageRole = 'user' | 'assistant' | 'toolResult'

/**
 * Unified cross-client chat message — the canonical shape of `SyncMessage.raw`.
 * Single source of truth: `crates/flairy-contract` (Rust); this mirrors it.
 * Every client reads/writes this format on the wire; provider- or
 * kernel-specific message shapes must be converted at the sync boundary.
 */
export type ChatRole = 'user' | 'assistant'

export type ChatBlock =
  | { type: 'text'; text: string }
  /** Inline image (base64 bytes, no data: prefix), e.g. a user attachment. */
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'toolUse'; id: string; name: string; input: unknown }
  | { type: 'toolResult'; toolUseId: string; content: string; isError: boolean }

export interface ChatMessage {
  role: ChatRole
  content: ChatBlock[]
  /** Epoch millis. */
  timestamp: number
}

/**
 * A message as synced over the wire. `text` is a display/search projection;
 * `raw` carries the full unified {@link ChatMessage} so any client can
 * rehydrate the conversation faithfully on another device.
 */
export interface SyncMessage {
  id: string
  role: MessageRole
  text: string
  timestamp: number
  /** Unified {@link ChatMessage} payload (opaque to the server). */
  raw: ChatMessage | unknown
}

export interface Session {
  id: string
  userId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SessionWithMessages {
  session: Session
  messages: SyncMessage[]
}
