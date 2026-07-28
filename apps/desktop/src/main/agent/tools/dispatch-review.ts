import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { dispatchReview } from '../../acp/dispatch'
import { listEnabledBackends } from '../../acp/backends'
import { resolveRepoFromCwd } from '../../github/repo'

/**
 * dispatch_review — send a pull request to a coding agent for review. The
 * reviewer gets the PR's head branch in an isolated worktree under a read-only
 * policy (it can read and run the tests, not modify), and its findings are
 * posted as a PR comment. Fire-and-forget like dispatch_task; the outcome
 * comes back as a "[worker report]" message.
 */
export function createDispatchReviewTool(sessionId: string, cwd: string): AgentTool<any> {
  return {
    name: 'dispatch_review',
    label: 'Dispatch review',
    description:
      'Have a coding agent review a pull request of this workspace\'s repository. The agent inspects the diff and runs the tests in an isolated read-only checkout; its findings are posted as a comment on the PR and reported back into this conversation as a "[worker report]" message. It never approves or merges — that stays with the user. Returns immediately — do NOT wait or poll. Prefer a different backend than the one that wrote the PR.',
    parameters: Type.Object({
      prNumber: Type.Number({ description: 'The pull request number to review' }),
      backend: Type.Optional(
        Type.String({
          description:
            'Coding agent to use (default: the first enabled backend; ideally not the PR author agent)'
        })
      )
    }),
    executionMode: 'sequential',
    execute: async (_id, { prNumber, backend }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      await resolveRepoFromCwd(cwd)
      const run = dispatchReview({ sessionId, cwd, prNumber, backendId: backend })
      const label = listEnabledBackends().find((b) => b.id === run.backend)?.label ?? run.backend
      return {
        content: [
          {
            type: 'text',
            text:
              `Dispatched review of PR #${prNumber} to ${label} (run ${run.id}). ` +
              'A [worker report] message will arrive when the review is posted.'
          }
        ],
        details: { runId: run.id }
      }
    }
  }
}
