import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Memory, MemoryType } from '@flairy/shared'

/** Memory categories the model may tag a remembered statement with. */
const MEMORY_TYPES: MemoryType[] = ['preference', 'fact', 'profile']

/**
 * remember — let the agent durably record a fact or preference about the user
 * that should persist across conversations (and across the user's devices).
 *
 * Written entries are injected into the system prompt on later sessions, so the
 * assistant "remembers" the user without them re-explaining. Persisting +
 * syncing happens in the `persist` callback supplied by AgentService (local
 * SQLite write + server mirror + UI refresh). This tool is exempt from the
 * approval gate in agent-service.ts: it only writes to the user's own memory
 * store and touches no files or commands, so it's inherently safe.
 *
 * Intentionally write-only and append-style for the MVP: the model can't read
 * back or delete memories (the user manages those in Settings). The description
 * steers it toward durable, generally-useful facts and away from one-off task
 * detail noise.
 */
export function createMemoryTool(
  sessionId: string,
  persist: (memory: Memory) => void
): AgentTool<any> {
  return {
    name: 'remember',
    label: 'remember',
    description:
      'Save a fact or preference about the user that should be remembered in future conversations. ' +
      'Use this proactively when you learn something durable and reusable — how they like answers ' +
      '(tone, length, language), stable facts about them or their work, or recurring preferences. ' +
      'Do NOT record one-off task details, secrets/passwords, or things that are only relevant right now. ' +
      'Keep each memory a single short, self-contained statement. Avoid duplicating something you already remember.',
    parameters: Type.Object({
      text: Type.String({
        description:
          'The single fact or preference to remember, as a short self-contained statement (e.g. "Prefers concise, bulleted answers").'
      }),
      type: Type.Optional(
        Type.Union(
          MEMORY_TYPES.map((t) => Type.Literal(t)),
          {
            description:
              "Category: 'preference' (how they like things done), 'fact' (a stable fact about them/their work), or 'profile' (identity/role). Defaults to 'fact'."
          }
        )
      )
    }),
    executionMode: 'sequential',
    execute: async (_id, { text, type }: any) => {
      const statement = typeof text === 'string' ? text.trim() : ''
      if (!statement) {
        throw new Error('remember requires a non-empty "text" statement')
      }
      const kind: MemoryType = MEMORY_TYPES.includes(type) ? type : 'fact'
      const now = Date.now()
      const memory: Memory = {
        id: randomUUID(),
        type: kind,
        text: statement,
        source: sessionId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      }
      persist(memory)
      return {
        content: [{ type: 'text', text: `Got it — I'll remember that: "${statement}"` }],
        details: { memory }
      }
    }
  }
}
