import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { dispatchTask } from '../../acp/dispatch'
import { listEnabledBackends } from '../../acp/backends'
import { resolveRepoFromCwd } from '../../github/repo'

/**
 * dispatch_task — hand a GitHub issue to an external coding agent (over ACP) in
 * an isolated git worktree. Fire-and-forget: returns as soon as the run is
 * recorded; progress streams to the Runs panel and the outcome comes back into
 * this session as a "[worker report]" message (PR link on success). Gated by
 * the approval flow like every other mutating tool.
 */
export function createDispatchTaskTool(sessionId: string, cwd: string): AgentTool<any> {
  return {
    name: 'dispatch_task',
    label: 'Dispatch task',
    description:
      'Delegate a GitHub issue of this workspace\'s repository to a coding agent. The agent implements the issue in an isolated branch; when it finishes, Flairy pushes the branch, opens a pull request, and posts a "[worker report]" message back into this conversation. When coordinating a project that has GitHub issues, implementation goes through this tool — do NOT implement issues yourself with write/edit/bash, even small ones: self-implemented changes skip the pull-request review flow the user depends on. Returns immediately — do NOT wait or poll; continue with other work (you may dispatch several issues in parallel) or end your turn.',
    parameters: Type.Object({
      issueNumber: Type.Number({ description: 'The GitHub issue number to implement' }),
      backend: Type.Optional(
        Type.String({
          description: 'Coding agent to use (default: the first available backend)'
        })
      )
    }),
    executionMode: 'sequential',
    execute: async (_id, { issueNumber, backend }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      // Fail fast (before recording anything) when the workspace has no repo.
      await resolveRepoFromCwd(cwd)
      const run = dispatchTask({ sessionId, cwd, issueNumber, backendId: backend })
      const backends = listEnabledBackends()
      const label = backends.find((b) => b.id === run.backend)?.label ?? run.backend
      return {
        content: [
          {
            type: 'text',
            text:
              `Dispatched issue #${issueNumber} to ${label} (run ${run.id}). ` +
              'A [worker report] message will arrive in this conversation when it finishes.'
          }
        ],
        details: { runId: run.id }
      }
    }
  }
}
