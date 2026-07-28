import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC, type WorkerRun } from '@shared/ipc'
import type { AgentManager } from '../agent/agent-manager'
import { getOctokit } from '../github/client'
import { git } from '../github/git'
import { resolveRepoFromCwd } from '../github/repo'
import {
  getWorkerRun,
  insertWorkerRun,
  listWorkerRuns,
  updateWorkerRun
} from '../store/db'
import { broadcast } from '../windows'
import { getBackend, getBackendConfigValues } from './backends'
import { AcpWorkerManager } from './worker-manager'

/**
 * The dispatch pipeline behind the `dispatch_task` tool: prepare an isolated
 * git worktree for a GitHub issue, hand it to an external coding agent over ACP
 * (see ./worker-manager), then push the branch + open the PR *from Flairy* —
 * the worker only ever commits locally and never holds the GitHub token.
 *
 * Fire-and-forget: the tool returns as soon as the run row exists; completion
 * (or failure) is injected back into the originating session as a
 * "[worker report]" message via AgentManager.submit — the same pattern Telegram
 * uses — which survives idle eviction because getOrCreate re-materializes.
 */

let agents: AgentManager | null = null
export const workers = new AcpWorkerManager()

/** Wire the process singletons (called once from main/index.ts). */
export function initDispatch(agentManager: AgentManager): void {
  agents = agentManager
}

/** Run row + live tail merged, for the Runs panel. */
export function listRunsWithTail(sessionId: string): WorkerRun[] {
  return listWorkerRuns(sessionId).map((run) =>
    workers.isLive(run.id) ? { ...run, tail: workers.tailFor(run.id) } : run
  )
}

export function abortRun(runId: string): void {
  workers.abortRun(runId)
}

function emitRun(run: WorkerRun): void {
  broadcast(IPC.WorkerRunChanged, run)
}

function patchRun(runId: string, patch: Parameters<typeof updateWorkerRun>[1]): WorkerRun | undefined {
  const run = updateWorkerRun(runId, patch)
  if (run) emitRun(workers.isLive(runId) ? { ...run, tail: workers.tailFor(runId) } : run)
  return run
}

export interface DispatchArgs {
  sessionId: string
  /** The project session's workspace (the main clone). */
  cwd: string
  issueNumber: number
  backendId?: string
}

/**
 * Validate cheaply, record the run, and kick off the pipeline in the
 * background. Returns the created run row (status 'preparing').
 */
export function dispatchTask(args: DispatchArgs): WorkerRun {
  if (!agents) throw new Error('Dispatch pipeline not initialized')
  const backend = getBackend(args.backendId)
  const duplicate = listWorkerRuns(args.sessionId).find(
    (r) =>
      r.issueNumber === args.issueNumber &&
      (r.status === 'preparing' || r.status === 'running' || r.status === 'pushing')
  )
  if (duplicate) {
    throw new Error(
      `Issue #${args.issueNumber} already has a run in progress (${duplicate.id}). Abort it or wait for it to finish.`
    )
  }
  const now = Date.now()
  const run: WorkerRun = {
    id: randomUUID(),
    sessionId: args.sessionId,
    issueNumber: args.issueNumber,
    backend: backend.id,
    status: 'preparing',
    createdAt: now,
    updatedAt: now
  }
  insertWorkerRun(run)
  emitRun(run)
  void runPipeline(run.id, args, backend.id).catch((err) => {
    // Belt-and-braces: runPipeline reports its own failures; this catches bugs.
    console.error('[dispatch] pipeline crashed', err)
    finishRun(run.id, args, 'failed', err instanceof Error ? err.message : String(err))
  })
  return run
}

async function runPipeline(runId: string, args: DispatchArgs, backendId: string): Promise<void> {
  const { sessionId, cwd, issueNumber } = args
  const branch = `flairy/issue-${issueNumber}`
  try {
    // 1. Resolve repo + issue + default branch.
    const { owner, repo } = await resolveRepoFromCwd(cwd)
    const gh = getOctokit()
    const [{ data: issue }, { data: repoInfo }] = await Promise.all([
      gh.rest.issues.get({ owner, repo, issue_number: issueNumber }),
      gh.rest.repos.get({ owner, repo })
    ])
    const base = repoInfo.default_branch

    // 2. Fresh worktree on a new branch off origin/<base>.
    await git(['fetch', 'origin'], { cwd, authed: true, timeoutMs: 300_000 })
    const worktreesRoot = join(cwd, '.flairy', 'worktrees')
    mkdirSync(worktreesRoot, { recursive: true })
    const worktreePath = join(worktreesRoot, `issue-${issueNumber}`)
    // Re-dispatch of the same issue: drop any stale worktree/branch first.
    await git(['worktree', 'remove', '--force', worktreePath], { cwd }).catch(() => undefined)
    await git(['branch', '-D', branch], { cwd }).catch(() => undefined)
    await git(['worktree', 'add', worktreePath, '-b', branch, `origin/${base}`], { cwd })

    // 3. The task brief the worker starts from.
    writeFileSync(join(worktreePath, 'TASK.md'), taskBrief(issue, issueNumber, branch))

    patchRun(runId, { status: 'running', branch, worktreePath, startedAt: Date.now() })

    // 4. Run the worker (long). Tail updates stream to the Runs panel, throttled.
    let lastTailEmit = 0
    const result = await workers.startRun({
      runId,
      backend: getBackend(backendId),
      configValues: getBackendConfigValues(backendId),
      cwd: worktreePath,
      prompt:
        'Read TASK.md in the repository root and complete the task it describes. ' +
        'Commit your work locally with clear messages. Do not push, and do not run any remote git operations.',
      onTail: () => {
        const now = Date.now()
        if (now - lastTailEmit < 300) return
        lastTailEmit = now
        const run = getWorkerRun(runId)
        if (run) emitRun({ ...run, tail: workers.tailFor(runId) })
      }
    })

    if (result.outcome === 'cancelled') {
      finishRun(runId, args, 'cancelled', undefined, result.summary || 'Run aborted.')
      return
    }
    if (result.outcome !== 'completed') {
      finishRun(
        runId,
        args,
        result.outcome === 'timeout' ? 'timeout' : 'failed',
        result.error,
        result.summary
      )
      return
    }

    // 5. Verify the worker actually committed something.
    const commits = await git(['log', '--oneline', `origin/${base}..HEAD`], { cwd: worktreePath })
    if (!commits) {
      finishRun(runId, args, 'failed', 'The worker finished without making any commits.', result.summary)
      return
    }

    // 6. Flairy pushes + opens the PR (the worker never touches the remote).
    patchRun(runId, { status: 'pushing' })
    await git(['push', '-u', 'origin', branch], {
      cwd: worktreePath,
      authed: true,
      timeoutMs: 300_000
    })
    const { data: pr } = await gh.rest.pulls.create({
      owner,
      repo,
      title: issue.title,
      head: branch,
      base,
      body: `Fixes #${issueNumber}\n\n---\n\n${truncate(result.summary, 4000)}`
    })
    patchRun(runId, { status: 'pr_opened', prNumber: pr.number, prUrl: pr.html_url, endedAt: Date.now() })

    report(
      sessionId,
      `[worker report] Run for issue #${issueNumber} finished: opened PR #${pr.number} (${pr.html_url}).\n` +
        `Commits:\n${truncate(commits, 1000)}\n\nWorker summary:\n${truncate(result.summary, 2000)}`
    )
  } catch (err) {
    finishRun(runId, args, 'failed', err instanceof Error ? err.message : String(err))
  }
}

function finishRun(
  runId: string,
  args: DispatchArgs,
  status: 'failed' | 'cancelled' | 'timeout',
  error?: string,
  summary?: string
): void {
  const detail = [error, summary].filter(Boolean).join('\n\n')
  patchRun(runId, { status, summary: detail || undefined, endedAt: Date.now() })
  const label =
    status === 'cancelled'
      ? 'was aborted'
      : status === 'timeout'
        ? 'timed out'
        : 'failed'
  report(
    args.sessionId,
    `[worker report] Run for issue #${args.issueNumber} ${label}.` +
      (error ? `\nError: ${truncate(error, 1500)}` : '') +
      (summary ? `\nWorker output (tail):\n${truncate(summary, 1500)}` : '')
  )
}

/** Inject a report into the originating session (steers if a turn is running). */
function report(sessionId: string, text: string): void {
  if (!agents) return
  try {
    void agents.getOrCreate(sessionId).submit(text)
  } catch {
    // Session deleted while the run was in flight — nothing to report into.
  }
}

function taskBrief(
  issue: { title: string; body?: string | null; labels?: unknown[] },
  issueNumber: number,
  branch: string
): string {
  return [
    `# Task: ${issue.title}`,
    '',
    `GitHub issue: #${issueNumber} · branch: \`${branch}\` (already checked out)`,
    '',
    '## Issue',
    '',
    issue.body?.trim() || '(no description)',
    '',
    '## Rules',
    '',
    '- Work only inside this directory (an isolated git worktree).',
    `- Commit locally with clear messages; reference the issue as \`#${issueNumber}\`.`,
    '- Do NOT push, and do NOT run any remote git operations (fetch/pull/push/remote).',
    '- If the repository has a CONTRIBUTING.md or README with conventions, follow them.',
    '- Run the project\'s tests/build if available and make them pass before finishing.',
    '- Do not commit TASK.md.',
    '',
    '## Definition of done',
    '',
    '- The issue\'s requirements are implemented and committed.',
    '- End with a short summary of what you changed and anything left open.'
  ].join('\n')
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
