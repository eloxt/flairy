import { safeStorage, app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthUser, SetSecretArgs } from '@shared/ipc'
import { profileDir } from './profile'

/**
 * Secrets are encrypted with the OS keychain via Electron safeStorage and
 * persisted as ciphertext on disk. Plaintext values never leave the main
 * process and are never sent over IPC to the renderer.
 *
 * Two stores:
 * - DEVICE (`userData/secrets.bin`): only the auth token + signed-in user —
 *   the identity must be readable before a profile can be chosen at startup.
 * - PROFILE (`<profileDir>/secrets.bin`): everything else (provider API keys,
 *   Telegram bot token, GitHub token) — per-account, so switching accounts
 *   can never reuse another account's integrations.
 */
type Provider = SetSecretArgs['provider']

const deviceFile = (): string => join(app.getPath('userData'), 'secrets.bin')
const profileFile = (): string => join(profileDir(), 'secrets.bin')

function loadAll(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path)
    const json = safeStorage.decryptString(raw)
    return JSON.parse(json) as Record<string, string>
  } catch {
    return {}
  }
}

function saveAll(path: string, secrets: Record<string, string>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption unavailable; refusing to store secrets in plaintext')
  }
  const enc = safeStorage.encryptString(JSON.stringify(secrets))
  writeFileSync(path, enc)
}

export function setSecret({ provider, apiKey }: SetSecretArgs): void {
  const all = loadAll(profileFile())
  all[provider] = apiKey
  saveAll(profileFile(), all)
}

export function getSecret(provider: Provider): string | undefined {
  return loadAll(profileFile())[provider]
}

export function hasSecret(provider: Provider): boolean {
  return Boolean(loadAll(profileFile())[provider])
}

/**
 * The server-issued JWT + user profile live in the DEVICE store under reserved
 * keys that can never collide with a Provider value. The renderer only ever
 * learns whether a token exists, never its value.
 */
const AUTH_TOKEN_KEY = '__auth_token__'
/** The signed-in user's public profile, persisted so the gate can restore it on launch. */
const AUTH_USER_KEY = '__auth_user__'

export function setAuthToken(token: string): void {
  const all = loadAll(deviceFile())
  all[AUTH_TOKEN_KEY] = token
  saveAll(deviceFile(), all)
}

export function getAuthToken(): string | undefined {
  return loadAll(deviceFile())[AUTH_TOKEN_KEY]
}

export function hasAuthToken(): boolean {
  return Boolean(loadAll(deviceFile())[AUTH_TOKEN_KEY])
}

export function setAuthUser(user: AuthUser): void {
  const all = loadAll(deviceFile())
  all[AUTH_USER_KEY] = JSON.stringify(user)
  saveAll(deviceFile(), all)
}

export function getAuthUser(): AuthUser | undefined {
  const raw = loadAll(deviceFile())[AUTH_USER_KEY]
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    return undefined
  }
}

/** Wipe token + user profile on sign-out. Profile-scoped secrets stay put. */
export function clearAuth(): void {
  const all = loadAll(deviceFile())
  delete all[AUTH_TOKEN_KEY]
  delete all[AUTH_USER_KEY]
  saveAll(deviceFile(), all)
}

/**
 * One-time upgrade: integration secrets used to share the device file with the
 * auth token. Move every non-auth key into the active profile's store (without
 * overwriting values the profile already has). Runs after initProfile().
 */
export function migrateDeviceSecretsToProfile(): void {
  const device = loadAll(deviceFile())
  const toMove = Object.keys(device).filter((k) => k !== AUTH_TOKEN_KEY && k !== AUTH_USER_KEY)
  if (toMove.length === 0) return
  try {
    const profile = loadAll(profileFile())
    for (const key of toMove) {
      if (!(key in profile)) profile[key] = device[key]
      delete device[key]
    }
    saveAll(profileFile(), profile)
    saveAll(deviceFile(), device)
  } catch (err) {
    console.error('[secrets] device→profile migration failed:', err)
  }
}

/**
 * The Telegram bot token, per profile. MAIN-ONLY: the renderer never learns the
 * token value (only a boolean).
 */
const TELEGRAM_TOKEN_KEY = '__telegram_token__'

/**
 * The GitHub OAuth access token (Device Flow), per profile. MAIN-ONLY: the
 * renderer only ever learns whether a token exists (and the account login),
 * never the token itself.
 */
const GITHUB_TOKEN_KEY = '__github_token__'

export function setGithubToken(token: string): void {
  const all = loadAll(profileFile())
  all[GITHUB_TOKEN_KEY] = token
  saveAll(profileFile(), all)
}

export function getGithubToken(): string | null {
  return loadAll(profileFile())[GITHUB_TOKEN_KEY] ?? null
}

export function hasGithubToken(): boolean {
  return Boolean(loadAll(profileFile())[GITHUB_TOKEN_KEY])
}

export function clearGithubToken(): void {
  const all = loadAll(profileFile())
  delete all[GITHUB_TOKEN_KEY]
  saveAll(profileFile(), all)
}

export function setTelegramToken(token: string): void {
  const all = loadAll(profileFile())
  all[TELEGRAM_TOKEN_KEY] = token
  saveAll(profileFile(), all)
}

export function getTelegramToken(): string | null {
  return loadAll(profileFile())[TELEGRAM_TOKEN_KEY] ?? null
}

export function hasTelegramToken(): boolean {
  return Boolean(loadAll(profileFile())[TELEGRAM_TOKEN_KEY])
}

export function clearTelegramToken(): void {
  const all = loadAll(profileFile())
  delete all[TELEGRAM_TOKEN_KEY]
  saveAll(profileFile(), all)
}
