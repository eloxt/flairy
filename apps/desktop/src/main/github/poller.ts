import { IPC, type WorkerRun } from '@shared/ipc'
import type { AgentManager } from '../agent/agent-manager'
import { getSession, listPrOpenedWorkerRuns, updateWorkerRun } from '../store/db'
import { broadcast } from '../windows'
import { hasGithubToken } from '../store/secrets'
import { getOctokit } from './client'
import { resolveRepoFromCwd } from './repo'

/**
 * GitHub event source for orchestrated projects. The desktop can't receive
 * webhooks, so while any run is sitting in `pr_opened` we poll its PR and
 * inject state changes into the originating session as "[github event]"
 * messages — the same injection path worker reports use, which is what lets
 * the orchestrator react (kick off the next issue, fix CI, close the loop)
 * without the user relaying GitHub state by hand.
 *
 * Watched transitions:
 * - PR merged  → run status 'merged' + event
 * - PR closed without merge → event (run left as-is; rare, user-driven)
 * - CI checks for the PR head settle (success/failure) or flip → event
 *
 * Poll cadence is slow (90s) and the timer only does work while there are
 * runs to watch; with none, each tick is a single cheap SQLite query.
 */

const POLL_INTERVAL_MS = 90_000

interface CiState {
  /** Last conclusion we reported: 'success' | 'failure' | undefined (pending). */
  reported?: 'success' | 'failure'
}

export class GithubPoller {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  /** Per-run CI dedup (in-memory: a restart just re-baselines silently). */
  private readonly ci = new Map<string, CiState>()

  constructor(private readonly agents: AgentManager) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    if (this.polling) return // a slow GitHub round mustn't stack ticks
    this.polling = true
    try {
      const watched = listPrOpenedWorkerRuns()
      if (watched.length === 0 || !hasGithubToken()) return
      for (const run of watched) {
        try {
          await this.checkRun(run)
        } catch {
          // Network/API hiccup on one PR must not stop the others; retried
          // naturally on the next tick.
        }
      }
    } finally {
      this.polling = false
    }
  }

  private async checkRun(run: WorkerRun): Promise<void> {
    if (!run.prNumber) return
    const cwd = getSession(run.sessionId)?.cwd
    if (!cwd) return
    const { owner, repo } = await resolveRepoFromCwd(cwd)
    const gh = getOctokit()
    const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: run.prNumber })

    if (pr.merged) {
      const updated = updateWorkerRun(run.id, { status: 'merged', endedAt: Date.now() })
      if (updated) broadcast(IPC.WorkerRunChanged, updated)
      this.ci.delete(run.id)
      this.inject(
        run.sessionId,
        `[github event] PR #${run.prNumber} was merged (${pr.html_url}).` +
          (run.issueNumber ? ` Issue #${run.issueNumber} should now be closed.` : '')
      )
      return
    }
    if (pr.state === 'closed') {
      // Closed without merging — surface it once and stop watching via status.
      const updated = updateWorkerRun(run.id, { status: 'cancelled', endedAt: Date.now() })
      if (updated) broadcast(IPC.WorkerRunChanged, updated)
      this.ci.delete(run.id)
      this.inject(
        run.sessionId,
        `[github event] PR #${run.prNumber} was closed WITHOUT merging (${pr.html_url}). Ask the user how to proceed if unclear.`
      )
      return
    }

    // CI: aggregate the check runs on the PR head. Only speak when all checks
    // have settled, and only when the aggregate flips or first settles.
    const { data: checks } = await gh.rest.checks.listForRef({
      owner,
      repo,
      ref: pr.head.sha,
      per_page: 50
    })
    if (checks.total_count === 0) return // no CI configured on this repo
    const runs = checks.check_runs
    if (runs.some((c) => c.status !== 'completed')) return // still running
    const failed = runs.filter(
      (c) => c.conclusion && !['success', 'neutral', 'skipped'].includes(c.conclusion)
    )
    const aggregate: 'success' | 'failure' = failed.length ? 'failure' : 'success'
    const state = this.ci.get(run.id) ?? {}
    if (state.reported === aggregate) return
    state.reported = aggregate
    this.ci.set(run.id, state)
    this.inject(
      run.sessionId,
      aggregate === 'success'
        ? `[github event] CI is green on PR #${run.prNumber} (${pr.html_url}) — ready for review/merge.`
        : `[github event] CI FAILED on PR #${run.prNumber} (${pr.html_url}): ${failed
            .map((c) => `${c.name} (${c.conclusion})`)
            .join(', ')}. Diagnose and re-dispatch a fix.`
    )
  }

  private inject(sessionId: string, text: string): void {
    try {
      void this.agents.getOrCreate(sessionId).submit(text)
    } catch {
      // Session gone — nothing to notify.
    }
  }
}
