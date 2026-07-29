import { readdirSync } from 'node:fs'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { getOctokit } from './client'
import { currentBranch, git, isGitRepo } from './git'
import { resolveRepoFromCwd } from './repo'

/**
 * GitHub tools for orchestrating a project from a session workspace. Stateless:
 * every call derives owner/repo from the cwd's `origin` remote (see ./repo).
 *
 * Deliberately split by risk class rather than one mega-tool: the approval gate
 * and its "Allow for this session" grants are keyed by tool NAME, so a grant
 * for reading issues must not also cover creating repositories or pushing.
 * `github_read` is the only one safe for READ_ONLY_TOOLS.
 */

/** Slim mappers — keep tool output compact instead of dumping raw API payloads. */
function slimIssue(i: any): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    labels: (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
    assignees: (i.assignees ?? []).map((a: any) => a.login),
    milestone: i.milestone?.title,
    url: i.html_url,
    body: i.body ?? undefined
  }
}

function slimPr(p: any): Record<string, unknown> {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft,
    head: p.head?.ref,
    base: p.base?.ref,
    mergeable: p.mergeable ?? undefined,
    merged: p.merged ?? undefined,
    url: p.html_url,
    body: p.body ?? undefined
  }
}

function ok(text: string, details: Record<string, unknown> = {}): {
  content: { type: 'text'; text: string }[]
  details: Record<string, unknown>
} {
  return { content: [{ type: 'text', text }], details }
}

const json = (v: unknown): string => JSON.stringify(v, null, 1)

export function createGithubReadTool(cwd: string): AgentTool<any> {
  return {
    name: 'github_read',
    label: 'GitHub read',
    description:
      "Read from the workspace's GitHub repository (derived from the git 'origin' remote). Actions: 'repo' (repository info), 'issues' (list issues), 'issue' (one issue + comments, requires number), 'prs' (list pull requests), 'pr' (one PR + reviews, requires number).",
    parameters: Type.Object({
      action: Type.String({ description: "One of: 'repo' | 'issues' | 'issue' | 'prs' | 'pr'" }),
      number: Type.Optional(Type.Number({ description: 'Issue/PR number (for issue/pr actions)' })),
      state: Type.Optional(
        Type.String({ description: "Filter for list actions: 'open' (default) | 'closed' | 'all'" })
      ),
      limit: Type.Optional(Type.Number({ description: 'Max results for list actions (default 30)' }))
    }),
    executionMode: 'parallel',
    execute: async (_id, { action, number, state, limit }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      const { owner, repo } = await resolveRepoFromCwd(cwd)
      const gh = getOctokit()
      const listState = (state as 'open' | 'closed' | 'all') || 'open'
      const perPage = Math.min(limit ?? 30, 100)

      switch (action) {
        case 'repo': {
          const { data } = await gh.rest.repos.get({ owner, repo })
          return ok(
            json({
              fullName: data.full_name,
              private: data.private,
              defaultBranch: data.default_branch,
              description: data.description,
              openIssues: data.open_issues_count,
              url: data.html_url
            })
          )
        }
        case 'issues': {
          const { data } = await gh.rest.issues.listForRepo({
            owner,
            repo,
            state: listState,
            per_page: perPage
          })
          // The issues API includes PRs; keep this action issues-only.
          const issues = data.filter((i) => !i.pull_request).map(slimIssue)
          return ok(issues.length ? json(issues) : '(no issues)')
        }
        case 'issue': {
          if (!number) throw new Error("action 'issue' requires `number`")
          const { data } = await gh.rest.issues.get({ owner, repo, issue_number: number })
          const { data: comments } = await gh.rest.issues.listComments({
            owner,
            repo,
            issue_number: number,
            per_page: perPage
          })
          return ok(
            json({
              ...slimIssue(data),
              comments: comments.map((c) => ({ author: c.user?.login, body: c.body }))
            })
          )
        }
        case 'prs': {
          const { data } = await gh.rest.pulls.list({
            owner,
            repo,
            state: listState === 'all' ? 'all' : listState,
            per_page: perPage
          })
          return ok(data.length ? json(data.map(slimPr)) : '(no pull requests)')
        }
        case 'pr': {
          if (!number) throw new Error("action 'pr' requires `number`")
          const { data } = await gh.rest.pulls.get({ owner, repo, pull_number: number })
          const { data: reviews } = await gh.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: number,
            per_page: perPage
          })
          return ok(
            json({
              ...slimPr(data),
              reviews: reviews.map((r) => ({ author: r.user?.login, state: r.state, body: r.body }))
            })
          )
        }
        default:
          throw new Error(`Unknown action '${action}'. Use repo | issues | issue | prs | pr.`)
      }
    }
  }
}

export function createGithubCreateRepoTool(cwd: string): AgentTool<any> {
  return {
    name: 'github_create_repo',
    label: 'GitHub create repo',
    description:
      "Create a GitHub repository under the connected account (auto-initialized with an initial commit on the default branch) and clone it into this workspace. After this, the repository is immediately ready for dispatch_task — no local commit or push needed first.",
    parameters: Type.Object({
      name: Type.String({ description: 'Repository name (e.g. my-app)' }),
      description: Type.Optional(Type.String({ description: 'Repository description' })),
      private: Type.Optional(Type.Boolean({ description: 'Create as private (default true)' }))
    }),
    executionMode: 'sequential',
    execute: async (_id, { name, description, private: isPrivate }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      // Refuse to silently re-point a workspace that already tracks a repo.
      if (await isGitRepo(cwd)) {
        const existing = await git(['remote', 'get-url', 'origin'], { cwd }).catch(() => null)
        if (existing) {
          throw new Error(
            `This workspace already has an 'origin' remote (${existing}). Refusing to overwrite it.`
          )
        }
      }
      const gh = getOctokit()
      // auto_init matters: dispatch_task worktrees branch off origin/<default>,
      // which only exists once the repo has an initial commit. With it, the
      // repo is dispatch-ready the moment this tool returns.
      const { data } = await gh.rest.repos.createForAuthenticatedUser({
        name,
        description,
        private: isPrivate ?? true,
        auto_init: true
      })
      const empty = readdirSync(cwd).filter((f) => f !== '.DS_Store').length === 0
      if (empty) {
        // GitHub creates the auto-init commit asynchronously; retry once.
        try {
          await git(['clone', data.clone_url, '.'], { cwd, authed: true, timeoutMs: 300_000 })
        } catch {
          await new Promise((r) => setTimeout(r, 2_000))
          await git(['clone', data.clone_url, '.'], { cwd, authed: true, timeoutMs: 300_000 })
        }
        return ok(
          `Created ${data.full_name} (${data.private ? 'private' : 'public'}) and cloned it into the workspace. Ready for dispatch_task.\n${data.html_url}`,
          { url: data.html_url }
        )
      }
      // Non-empty workspace: wire it up without clobbering existing files and
      // let the caller reconcile (fetch already ran, so origin/<default> exists).
      await git(['init', '-b', data.default_branch], { cwd })
      await git(['remote', 'add', 'origin', data.clone_url], { cwd })
      await git(['fetch', 'origin'], { cwd, authed: true, timeoutMs: 300_000 })
      return ok(
        `Created ${data.full_name} (${data.private ? 'private' : 'public'}) and set it as 'origin'. The workspace already contained files, so it was NOT cloned over — the remote's initial commit is at origin/${data.default_branch}; reconcile before dispatching.\n${data.html_url}`,
        { url: data.html_url }
      )
    }
  }
}

export function createGithubPushTool(cwd: string): AgentTool<any> {
  return {
    name: 'github_push',
    label: 'GitHub push',
    description:
      "Push a branch of the workspace repository to GitHub (sets upstream on first push). Commit your changes first (git via bash). Defaults to the current branch.",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({ description: 'Branch to push (default: current branch)' }))
    }),
    executionMode: 'sequential',
    execute: async (_id, { branch }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      await resolveRepoFromCwd(cwd) // validates repo + origin before touching the network
      const ref = branch || (await currentBranch(cwd))
      if (ref === 'HEAD') throw new Error('Detached HEAD: check out a branch before pushing.')
      const out = await git(['push', '-u', 'origin', ref], { cwd, authed: true, timeoutMs: 300_000 })
      return ok(`Pushed ${ref} to origin.${out ? `\n${out}` : ''}`)
    }
  }
}

export function createGithubIssueWriteTool(cwd: string): AgentTool<any> {
  return {
    name: 'github_issue_write',
    label: 'GitHub issue write',
    description:
      "Create or modify issues in the workspace's GitHub repository. Actions: 'create' (requires title; body/labels/milestone optional), 'update' (requires number; any of title/body/state/labels/milestone), 'comment' (requires number + body). `milestone` is a title — it is created on the repo if it doesn't exist yet.",
    parameters: Type.Object({
      action: Type.String({ description: "One of: 'create' | 'update' | 'comment'" }),
      number: Type.Optional(Type.Number({ description: 'Issue number (update/comment)' })),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String({ description: 'Issue body / comment text (markdown)' })),
      labels: Type.Optional(Type.Array(Type.String(), { description: 'Label names' })),
      milestone: Type.Optional(
        Type.String({ description: 'Milestone TITLE (create/update); created if missing' })
      ),
      state: Type.Optional(Type.String({ description: "For update: 'open' | 'closed'" }))
    }),
    executionMode: 'sequential',
    execute: async (_id, { action, number, title, body, labels, milestone, state }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      const { owner, repo } = await resolveRepoFromCwd(cwd)
      const gh = getOctokit()
      // The REST API wants a milestone NUMBER; the model speaks in titles.
      // Resolve (or create) lazily so iteration planning is one tool call.
      const resolveMilestone = async (t: string): Promise<number> => {
        const { data: all } = await gh.rest.issues.listMilestones({
          owner,
          repo,
          state: 'all',
          per_page: 100
        })
        const found = all.find((m) => m.title === t)
        if (found) return found.number
        const { data: created } = await gh.rest.issues.createMilestone({ owner, repo, title: t })
        return created.number
      }
      switch (action) {
        case 'create': {
          if (!title) throw new Error("action 'create' requires `title`")
          const { data } = await gh.rest.issues.create({
            owner,
            repo,
            title,
            body,
            labels,
            milestone: milestone ? await resolveMilestone(milestone) : undefined
          })
          return ok(`Created issue #${data.number}: ${data.title}\n${data.html_url}`, {
            number: data.number
          })
        }
        case 'update': {
          if (!number) throw new Error("action 'update' requires `number`")
          const { data } = await gh.rest.issues.update({
            owner,
            repo,
            issue_number: number,
            title,
            body,
            labels,
            milestone: milestone ? await resolveMilestone(milestone) : undefined,
            state: state as 'open' | 'closed' | undefined
          })
          return ok(`Updated issue #${data.number} (${data.state}).\n${data.html_url}`)
        }
        case 'comment': {
          if (!number || !body) throw new Error("action 'comment' requires `number` and `body`")
          const { data } = await gh.rest.issues.createComment({
            owner,
            repo,
            issue_number: number,
            body
          })
          return ok(`Commented on #${number}.\n${data.html_url}`)
        }
        default:
          throw new Error(`Unknown action '${action}'. Use create | update | comment.`)
      }
    }
  }
}

export function createGithubPrWriteTool(cwd: string): AgentTool<any> {
  return {
    name: 'github_pr_write',
    label: 'GitHub PR write',
    description:
      "Open or comment on pull requests in the workspace's GitHub repository. Actions: 'create' (requires title + head branch; base defaults to the repo default branch), 'comment' (requires number + body).",
    parameters: Type.Object({
      action: Type.String({ description: "One of: 'create' | 'comment'" }),
      number: Type.Optional(Type.Number({ description: 'PR number (comment)' })),
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String({ description: 'PR body / comment text (markdown)' })),
      head: Type.Optional(Type.String({ description: 'Source branch (default: current branch)' })),
      base: Type.Optional(Type.String({ description: 'Target branch (default: repo default branch)' })),
      draft: Type.Optional(Type.Boolean({ description: 'Open as draft (default false)' }))
    }),
    executionMode: 'sequential',
    execute: async (_id, { action, number, title, body, head, base, draft }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      const { owner, repo } = await resolveRepoFromCwd(cwd)
      const gh = getOctokit()
      switch (action) {
        case 'create': {
          if (!title) throw new Error("action 'create' requires `title`")
          const headRef = head || (await currentBranch(cwd))
          let baseRef = base
          if (!baseRef) {
            const { data } = await gh.rest.repos.get({ owner, repo })
            baseRef = data.default_branch
          }
          const { data } = await gh.rest.pulls.create({
            owner,
            repo,
            title,
            body,
            head: headRef,
            base: baseRef,
            draft: draft ?? false
          })
          return ok(`Opened PR #${data.number}: ${data.title} (${headRef} → ${baseRef})\n${data.html_url}`, {
            number: data.number,
            url: data.html_url
          })
        }
        case 'comment': {
          if (!number || !body) throw new Error("action 'comment' requires `number` and `body`")
          const { data } = await gh.rest.issues.createComment({
            owner,
            repo,
            issue_number: number,
            body
          })
          return ok(`Commented on PR #${number}.\n${data.html_url}`)
        }
        default:
          throw new Error(`Unknown action '${action}'. Use create | comment.`)
      }
    }
  }
}

/** The full GitHub toolset for a project session workspace. */
export function createGithubTools(cwd: string): AgentTool<any>[] {
  return [
    createGithubReadTool(cwd),
    createGithubCreateRepoTool(cwd),
    createGithubPushTool(cwd),
    createGithubIssueWriteTool(cwd),
    createGithubPrWriteTool(cwd)
  ]
}
