import { git, isGitRepo } from './git'

/**
 * The GitHub tools are stateless: the repo they operate on is derived from the
 * session's working directory (its `origin` remote), never persisted anywhere.
 */

export interface RepoRef {
  owner: string
  repo: string
}

const REMOTE_RE = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/

/**
 * Resolve owner/repo from the cwd's `origin` remote. Throws a tool-friendly
 * error when the workspace has no repo or no GitHub remote yet.
 */
export async function resolveRepoFromCwd(cwd: string): Promise<RepoRef> {
  if (!(await isGitRepo(cwd))) {
    throw new Error(
      'This workspace is not a git repository yet. Use github_create_repo to create one, or clone an existing repository here.'
    )
  }
  let url: string
  try {
    url = await git(['remote', 'get-url', 'origin'], { cwd })
  } catch {
    throw new Error(
      "This repository has no 'origin' remote. Use github_create_repo to create a GitHub repository for this workspace."
    )
  }
  const m = REMOTE_RE.exec(url)
  if (!m) {
    throw new Error(`The 'origin' remote (${url}) is not a github.com repository.`)
  }
  return { owner: m[1], repo: m[2] }
}
