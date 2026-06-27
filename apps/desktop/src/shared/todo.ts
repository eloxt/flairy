/**
 * Contract for the built-in `todo_write` tool, shared between the main process
 * (which the agent calls to record a plan) and the renderer (which renders the
 * checklist inline + in the right-side Plan tab).
 *
 * Like `web_search`, the tool returns a SINGLE JSON object as its text content:
 * the model reads it back as its current plan, and the renderer parses the same
 * text into {@link TodoItem}s. It rides in the tool result's text (not `details`,
 * which pi drops before the renderer and never persists), so a reopened or
 * device-synced session can rebuild the plan from message history alone — no new
 * DB table or socket event needed.
 */

/** Lifecycle of one task in the agent's plan. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** One task in the plan, as both the tool serializes and the renderer consumes. */
export interface TodoItem {
  /** Imperative description of the task (e.g. "Add the login form"). */
  content: string
  status: TodoStatus
  /** Optional present-tense label shown while in progress (e.g. "Adding the login form"). */
  activeForm?: string
}

/** Marker on the JSON payload, used to recognize our tool's output cheaply. */
const MARKER = 'flairy_todo'

/** Serialize a plan into the JSON text the tool returns. */
export function encodeTodos(todos: TodoItem[]): string {
  return JSON.stringify({ type: MARKER, todos })
}

/**
 * Parse a tool-result text into {@link TodoItem}s, or null if it isn't our
 * todo JSON. Identified by the `type` marker — robust to the tool's name and
 * never throws. A cheap substring guard avoids JSON.parse on the (often large)
 * output of unrelated tools.
 */
export function parseTodos(text: string | undefined): TodoItem[] | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes(MARKER)) return null
  try {
    const obj = JSON.parse(trimmed) as { type?: string; todos?: unknown }
    if (obj.type !== MARKER || !Array.isArray(obj.todos)) return null
    return obj.todos
      .filter((t): t is TodoItem => !!t && typeof (t as TodoItem).content === 'string')
      .map((t) => ({
        content: t.content,
        status: isStatus(t.status) ? t.status : 'pending',
        ...(typeof t.activeForm === 'string' && t.activeForm.trim()
          ? { activeForm: t.activeForm }
          : {})
      }))
  } catch {
    return null
  }
}

function isStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

/**
 * A clean, human-readable rendering of the plan for the collapsed tool row and
 * the model-facing fallback (so the raw JSON is never shown to the user).
 */
export function formatTodosForDisplay(todos: TodoItem[]): string {
  const mark: Record<TodoStatus, string> = {
    completed: '[x]',
    in_progress: '[~]',
    pending: '[ ]'
  }
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join('\n')
}
