import { safeStorage, app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthUser, SetSecretArgs } from '@shared/ipc'

/**
 * API keys are encrypted with the OS keychain via Electron safeStorage and
 * persisted as ciphertext on disk. Plaintext keys never leave the main process
 * and are never sent over IPC to the renderer.
 */
type Provider = SetSecretArgs['provider']

const filePath = (): string => join(app.getPath('userData'), 'secrets.bin')

function loadAll(): Record<string, string> {
  const p = filePath()
  if (!existsSync(p)) return {}
  try {
    const raw = readFileSync(p)
    const json = safeStorage.decryptString(raw)
    return JSON.parse(json) as Record<string, string>
  } catch {
    return {}
  }
}

function saveAll(secrets: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable; refusing to store API key in plaintext')
  }
  const enc = safeStorage.encryptString(JSON.stringify(secrets))
  writeFileSync(filePath(), enc)
}

export function setSecret({ provider, apiKey }: SetSecretArgs): void {
  const all = loadAll()
  all[provider] = apiKey
  saveAll(all)
}

export function getSecret(provider: Provider): string | undefined {
  return loadAll()[provider]
}

export function hasSecret(provider: Provider): boolean {
  return Boolean(loadAll()[provider])
}

/**
 * The server-issued JWT is stored alongside the provider keys, under a reserved
 * key that can never collide with a Provider value. Encrypted at rest the same
 * way; the renderer only ever learns whether a token exists, never its value.
 */
const AUTH_TOKEN_KEY = '__auth_token__'
/** The signed-in user's public profile, persisted so the gate can restore it on launch. */
const AUTH_USER_KEY = '__auth_user__'

export function setAuthToken(token: string): void {
  const all = loadAll()
  all[AUTH_TOKEN_KEY] = token
  saveAll(all)
}

export function getAuthToken(): string | undefined {
  return loadAll()[AUTH_TOKEN_KEY]
}

export function hasAuthToken(): boolean {
  return Boolean(loadAll()[AUTH_TOKEN_KEY])
}

export function setAuthUser(user: AuthUser): void {
  const all = loadAll()
  all[AUTH_USER_KEY] = JSON.stringify(user)
  saveAll(all)
}

export function getAuthUser(): AuthUser | undefined {
  const raw = loadAll()[AUTH_USER_KEY]
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    return undefined
  }
}

/** Wipe token + user profile on sign-out. */
export function clearAuth(): void {
  const all = loadAll()
  delete all[AUTH_TOKEN_KEY]
  delete all[AUTH_USER_KEY]
  saveAll(all)
}
