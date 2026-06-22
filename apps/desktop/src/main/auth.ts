import type { LoginRequest, LoginResponse, RegisterRequest } from '@flairy/shared'
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

/** POST a JSON body to an auth endpoint and parse the LoginResponse, or throw a friendly error. */
async function authPost(path: string, body: unknown, label: string): Promise<LoginResponse> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${label} failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }

  return (await res.json()) as LoginResponse
}
