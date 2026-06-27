import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { encodeTodos, type TodoItem, type TodoStatus } from '@shared/todo'

/** Statuses the model may assign, in lifecycle order. */
const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']

/**
 * todo_write — let the agent lay out and track a structured plan for a complex,
 * multi-step task. The model rewrites the WHOLE list each call (replace, not
 * append); the renderer turns the latest call into an inline checklist + a Plan
 * tab in the right sidebar, so the user can watch progress.
 *
 * State-free on the main side: the plan lives entirely in the returned JSON
 * sentinel (see `@shared/todo`), which rides in the tool result's text. That
 * makes it persist to SQLite and sync across devices for free (the server stores
 * the message opaquely) — no new table or socket event. Exempt from the approval
 * gate in agent-service.ts: it only records a plan and touches no files/commands.
 */
export function createTodoTool(): AgentTool<any> {
  return {
    name: 'todo_write',
    label: 'todo_write',
    description:
      'Create and manage a structured task list for the current work, so the user can see your plan and progress. ' +
      'Call it at the START of a non-trivial, multi-step task to lay out the steps, then call it AGAIN to update statuses as you go. ' +
      'Always pass the COMPLETE list every time — it REPLACES the previous list, it does not append. ' +
      'Each item has `content` (a short imperative step, e.g. "Add the login form") and `status` ("pending", "in_progress", or "completed"). ' +
      'Keep EXACTLY ONE item "in_progress" at a time, and flip an item to "completed" the moment it is done — before starting the next. ' +
      'Skip this tool for trivial single-step requests, greetings, or pure questions; only use it when planning genuinely helps.',
    parameters: Type.Object(
      {
        todos: Type.Array(
          Type.Object({
            content: Type.String({
              minLength: 1,
              description: 'A short imperative description of the task (e.g. "Add the login form").'
            }),
            status: Type.Union(
              STATUSES.map((s) => Type.Literal(s)),
              { description: 'Task state: "pending", "in_progress", or "completed". Exactly one item should be "in_progress".' }
            ),
            activeForm: Type.Optional(
              Type.String({
                description: 'Optional present-tense label shown while this task is in progress (e.g. "Adding the login form").'
              })
            )
          }),
          { description: 'The full, ordered task list. Pass every task every time — this replaces the previous list.' }
        )
      },
      { additionalProperties: false }
    ),
    executionMode: 'sequential',
    execute: async (_id, { todos }: any) => {
      const list: TodoItem[] = (Array.isArray(todos) ? todos : [])
        .map((t: any) => {
          const content = typeof t?.content === 'string' ? t.content.trim() : ''
          const status: TodoStatus = STATUSES.includes(t?.status) ? t.status : 'pending'
          const activeForm = typeof t?.activeForm === 'string' ? t.activeForm.trim() : ''
          return { content, status, ...(activeForm ? { activeForm } : {}) }
        })
        .filter((t: TodoItem) => t.content)
      if (list.length === 0) {
        throw new Error('todo_write requires a non-empty "todos" array of tasks.')
      }
      // The sentinel JSON is the ONLY content — the renderer parses the same text
      // (must start with "{"), and it's what survives persistence + device sync.
      return {
        content: [{ type: 'text', text: encodeTodos(list) }],
        details: { count: list.length }
      }
    }
  }
}
