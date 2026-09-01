import type {
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  RegisterRequest
} from '@flairy/shared'
import { SERVER_URL } from './sync/server-client'

/**
 * REST login. Exchanges email/password for a JWT + user via the server's
 * `/api/auth/login` endpoint. Runs in the MAIN process; the token is persisted
 * via safeStorage (see store/secrets.ts) and never handed to the renderer.
 */
export async function login(email: string, password: string): Promise<LoginResponse> {
  const body: LoginRequest = { email, password }
  return authPost('/api/auth/login', body, 'Login')
}

/**
 * REST registration. Creates a non-admin account and returns a JWT + user, same
 * shape as login. Main-process only; token handled identically to login.
 */
export async function register(
  email: string,
  password: string,
  displayName: string
): Promise<LoginResponse> {
  const body: RegisterRequest = { email, password, displayName }
  return authPost('/api/auth/register', body, 'Registration')
}

export function refreshSession(refreshToken: string): Promise<LoginResponse> {
  const body: RefreshTokenRequest = { refreshToken }
  return authPost('/api/auth/refresh', body, 'Session refresh', AbortSignal.timeout(10_000))
}

export async function revokeSession(refreshToken: string): Promise<void> {
  const body: RefreshTokenRequest = { refreshToken }
  const res = await fetch(`${SERVER_URL}/api/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000)
  })
  if (!res.ok) throw new AuthHttpError(`Logout failed (${res.status})`, res.status)
}

/** Refresh during the final week so normal use never reaches access-token expiry. */
export function shouldRefreshAuthToken(token: string): boolean {
  const expiresAt = authTokenExpiresAt(token)
  return expiresAt === null || expiresAt <= Date.now() + 7 * 24 * 60 * 60 * 1000
}

export function isAuthTokenExpired(token: string): boolean {
  const expiresAt = authTokenExpiresAt(token)
  return expiresAt === null || expiresAt <= Date.now()
}

function authTokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : null
  } catch {
    return null
  }
}

/** POST a JSON body to an auth endpoint and parse the LoginResponse, or throw a friendly error. */
async function authPost(
  path: string,
  body: unknown,
  label: string,
  signal?: AbortSignal
): Promise<LoginResponse> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })

  if (!res.ok) {
    // Prefer the server's `{ error }` detail (e.g. "your account is awaiting
    // administrator approval") so the renderer can show a clean message rather
    // than a raw JSON blob.
    const detail = await res
      .json()
      .then((d: unknown) =>
        d && typeof d === 'object' && 'error' in d ? String((d as { error: unknown }).error) : ''
      )
      .catch(() => '')
    throw new AuthHttpError(detail || `${label} failed (${res.status})`, res.status)
  }

  return (await res.json()) as LoginResponse
}

export class AuthHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'AuthHttpError'
  }
}
