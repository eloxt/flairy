import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AskQuestion } from '@shared/ipc'
import type { InteractionChannel } from '../interaction'
import type { TurnOrigin } from '../turn-origin'

/**
 * ask — let the model pause and ask the end-user one or more multiple-choice
 * questions. Each question is single- or multi-select and always allows a
 * free-text "other" answer. The call BLOCKS until the user submits (or the
 * session is aborted/deleted), then the picks are returned as the tool result.
 *
 * Mirrors the approval gate's request/await round-trip, but routed through the
 * interaction channel that owns the running turn's origin. `getRoute` is read at
 * CALL time (not captured at build time) so the question reaches the front-end
 * that authored the turn — the desktop window or the originating Telegram chat.
 * This tool is exempt from the approval gate in agent-service.ts (asking the user
 * is inherently safe).
 */
export function createAskTool(
  sessionId: string,
  getRoute: () => { origin: TurnOrigin; channel: InteractionChannel }
): AgentTool<any> {
  return {
    name: 'ask',
    label: 'ask',
    description:
      'Ask the user one or more multiple-choice questions and wait for their answer. ' +
      'Use this only for genuine decisions where you need the user to choose a direction — ' +
      'not for things you can figure out yourself. Each question shows the options you provide; ' +
      'the user may also type their own answer instead of picking one. This blocks until the ' +
      'user responds, then returns what they chose.',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: 'The question to ask the user, in plain language.' }),
          header: Type.Optional(
            Type.String({ description: 'A short label/category for the question (optional).' })
          ),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: 'The option text shown to the user.' }),
              description: Type.Optional(
                Type.String({ description: 'A short clarification shown under the option (optional).' })
              )
            }),
            { description: 'The choices to offer.' }
          ),
          multiSelect: Type.Optional(
            Type.Boolean({ description: 'Set true to let the user pick more than one option.' })
          )
        }),
        { description: 'One or more questions to ask the user.' }
      )
    }),
    executionMode: 'sequential',
    execute: async (_id, { questions: qs }: any, signal) => {
      const rawQuestions = (qs ?? []) as AskQuestion[]
      if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        throw new Error('ask requires at least one question')
      }

      const withIds: AskQuestion[] = rawQuestions.map((q, i) => {
        if (!q.question || typeof q.question !== 'string') {
          throw new Error(`Question ${i + 1} is missing its "question" text`)
        }
        if (!Array.isArray(q.options) || q.options.length === 0) {
          throw new Error(`Question "${q.question}" must have at least one option`)
        }
        for (const opt of q.options) {
          if (!opt || typeof opt.label !== 'string' || !opt.label) {
            throw new Error(`Question "${q.question}" has an option without a label`)
          }
        }
        return {
          id: randomUUID(),
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiSelect: q.multiSelect
        }
      })

      const { origin, channel } = getRoute()
      const answers = await channel.askQuestion({
        sessionId,
        origin,
        questions: withIds
      })

      if (signal?.aborted || answers === null) {
        throw new Error('User cancelled the question')
      }

      // Map each answer back to its question so the model can read the picks from
      // `content` (not just `details`). Selected labels and any custom text are
      // both surfaced; they are independent answers.
      const byId = new Map(answers.map((a) => [a.id, a]))
      const lines = withIds.map((q) => {
        const a = byId.get(q.id)
        const parts: string[] = []
        if (a?.selected.length) parts.push(a.selected.join(', '))
        if (a?.custom) parts.push(`(other: ${a.custom})`)
        const answerText = parts.length ? parts.join(' ') : '(no answer)'
        return `Q: ${q.question}\nA: ${answerText}`
      })

      return {
        content: [{ type: 'text', text: lines.join('\n\n') }],
        details: { answers }
      }
    }
  }
}
