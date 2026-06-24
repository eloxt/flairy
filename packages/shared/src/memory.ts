/**
 * Long-term agent memory contract for multi-device sync.
 *
 * Memory is user-scoped (global to the account, not per-session): facts and
 * preferences the assistant learns about the user, written by the `remember`
 * tool during a conversation and injected into the system prompt on later
 * sessions. Like sessions, it is "local-first + server mirror"; conflicts resolve
 * by newer `updatedAt`.
 *
 * Deletes are SOFT (`deletedAt` set) rather than row-removals so a deletion on
 * one device propagates to others through the same pull/upsert path instead of
 * being resurrected by the next `memory:pull`.
 */

/** Coarse category of a memory, used to group/filter and to shape the prompt block. */
export type MemoryType = 'preference' | 'fact' | 'profile'

export interface Memory {
  id: string
  type: MemoryType
  /** The remembered statement, in plain language (e.g. "Prefers concise answers"). */
  text: string
  /** sessionId this memory was learned in, for traceability. Optional. */
  source?: string
  createdAt: number
  updatedAt: number
  /** Epoch ms when soft-deleted; undefined/null while active. */
  deletedAt?: number | null
}
