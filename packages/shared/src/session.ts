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
 * A message as synced over the wire. `text` is a display/search projection;
 * `raw` carries the full pi-agent-core message JSON so the client can rehydrate
 * `agent.state.messages` faithfully on another device.
 */
export interface SyncMessage {
  id: string
  role: MessageRole
  text: string
  timestamp: number
  /** Full-fidelity pi-agent-core message payload (opaque to the server). */
  raw: unknown
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
