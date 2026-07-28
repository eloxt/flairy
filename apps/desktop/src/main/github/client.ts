import { Octokit } from '@octokit/rest'
import { getGithubToken } from '../store/secrets'

/**
 * Lazy Octokit singleton over the stored Device Flow token. Lives entirely in
 * the main process; tools call through here so the token is resolved fresh and
 * never captured in tool closures.
 */

let cached: Octokit | null = null

export function getOctokit(): Octokit {
  const token = getGithubToken()
  if (!token) {
    throw new Error('GitHub is not connected. Ask the user to connect GitHub in Settings first.')
  }
  if (!cached) {
    cached = new Octokit({ auth: token })
  }
  return cached
}

/** Drop the cached client after connect/disconnect so the next call re-auths. */
export function resetOctokit(): void {
  cached = null
}
