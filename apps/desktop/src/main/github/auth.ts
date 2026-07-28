import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device'
import { IPC, type GithubDeviceCode, type GithubStatus } from '@shared/ipc'
import { getSetting, setSetting } from '../store/db'
import {
  clearGithubToken,
  hasGithubToken,
  setGithubToken
} from '../store/secrets'
import { broadcast } from '../windows'
import { getOctokit, resetOctokit } from './client'

/**
 * GitHub Device Flow sign-in. The renderer shows the user code + URL; the
 * @octokit/auth-oauth-device lib polls in the background and we persist the
 * granted token (safeStorage, main-only). Device Flow uses no client secret, so
 * the OAuth App client ID is a plain (public) setting the user pastes once.
 */

const CLIENT_ID_SETTING = 'githubClientId'
const LOGIN_SETTING = 'githubLogin'

/** Scope note: `repo` covers create/push/issues/PRs on public + private repos. */
const SCOPES = ['repo']

let pending: GithubDeviceCode | null = null
let lastError: string | undefined
/** Supersede/cancel marker: a flow only commits its result if still current. */
let generation = 0

export function getGithubClientId(): string | undefined {
  const v = getSetting(CLIENT_ID_SETTING)?.trim()
  return v || undefined
}

export function getGithubStatus(): GithubStatus {
  return {
    connected: hasGithubToken(),
    login: getSetting(LOGIN_SETTING) || undefined,
    clientIdSet: Boolean(getGithubClientId()),
    pending: pending ?? undefined,
    lastError
  }
}

function broadcastStatus(): void {
  broadcast(IPC.GithubStatusChanged, getGithubStatus())
}

export function setGithubClientId(clientId: string): GithubStatus {
  setSetting(CLIENT_ID_SETTING, clientId.trim())
  lastError = undefined
  broadcastStatus()
  return getGithubStatus()
}

/**
 * Start (or restart) a device authorization. Resolves as soon as GitHub issues
 * the user code; the grant itself lands later via the background poll, which
 * stores the token, resolves the account login, and broadcasts the new status.
 */
export async function startGithubAuth(): Promise<GithubDeviceCode> {
  const clientId = getGithubClientId()
  if (!clientId) {
    throw new Error('No GitHub OAuth App client ID configured')
  }
  const gen = ++generation // implicitly abandons any previous pending flow
  lastError = undefined

  return await new Promise<GithubDeviceCode>((resolve, reject) => {
    let issued = false
    const auth = createOAuthDeviceAuth({
      clientType: 'oauth-app',
      clientId,
      scopes: SCOPES,
      onVerification: (v) => {
        if (gen !== generation) return
        pending = {
          userCode: v.user_code,
          verificationUri: v.verification_uri,
          expiresIn: v.expires_in
        }
        issued = true
        broadcastStatus()
        resolve(pending)
      }
    })

    auth({ type: 'oauth' })
      .then(async ({ token }) => {
        if (gen !== generation) return
        pending = null
        setGithubToken(token)
        resetOctokit()
        try {
          const { data } = await getOctokit().rest.users.getAuthenticated()
          setSetting(LOGIN_SETTING, data.login)
        } catch {
          // Token works even if the profile fetch hiccups; login stays blank.
          setSetting(LOGIN_SETTING, '')
        }
        broadcastStatus()
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (gen === generation) {
          pending = null
          lastError = message
          broadcastStatus()
        }
        // Before the code was issued the caller is still awaiting: surface it.
        if (!issued) reject(err instanceof Error ? err : new Error(message))
      })
  })
}

/** Abandon a pending device authorization (the background poll result is dropped). */
export function cancelGithubAuth(): GithubStatus {
  generation++
  pending = null
  lastError = undefined
  broadcastStatus()
  return getGithubStatus()
}

export function disconnectGithub(): GithubStatus {
  generation++
  pending = null
  lastError = undefined
  clearGithubToken()
  setSetting(LOGIN_SETTING, '')
  resetOctokit()
  broadcastStatus()
  return getGithubStatus()
}
