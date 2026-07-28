import type { SessionUpsertPayload, SyncMessage } from '@flairy/shared'
import { getSession, loadMessages } from '../store/db'
import { rehydrateImages } from '../store/image-store'

/**
 * Builders for the server-sync wire shapes, shared by the live path
 * (AgentService.syncToServer, which syncs the agent's in-memory messages) and
 * the offline-flush path (ServerClient re-building a dirty session's snapshot
 * from SQLite on reconnect). The wire contract is unchanged: `raw` carries full
 * pi messages with inline base64 images, so other devices keep working.
 */

/** Map a pi-agent-core message to the wire SyncMessage shape. */
export function toSyncMessage(raw: unknown): SyncMessage {
  const m = raw as {
    id?: string
    role?: string
    content?: unknown
    timestamp?: number
  }
  return {
    id: m.id ?? crypto.randomUUID(),
    role: normalizeRole(m.role),
    text: projectText(m.content),
    timestamp: m.timestamp ?? Date.now(),
    raw
  }
}

/** Coerce a pi role into the SyncMessage role union (default: assistant). */
function normalizeRole(role: string | undefined): SyncMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') return role
  return 'assistant'
}

/** Flatten pi message content into a plain-text projection for search/display. */
export function projectText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '')
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

/**
 * Build a full session upsert payload from the PERSISTED state (SQLite is
 * current at every sync point — persist() writes before it syncs). Returns null
 * for unknown or project (local-only) sessions. Image refs are rehydrated to
 * inline base64 so other devices receive real bytes.
 */
export function buildSessionUpsertPayload(sessionId: string): SessionUpsertPayload | null {
  const meta = getSession(sessionId)
  if (!meta || meta.kind !== 'chat') return null
  const messages = rehydrateImages(loadMessages(sessionId))
  return {
    session: {
      id: meta.id,
      // userId is filled in server-side from the authenticated token.
      userId: '',
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt
    },
    messages: messages.map(toSyncMessage)
  }
}
