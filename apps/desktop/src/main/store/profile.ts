import { app } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Per-account storage profiles.
 *
 * Everything user-scoped — the SQLite db, image store, materialized skills,
 * worker transcripts, and integration secrets — lives under
 * `userData/profiles/<userId>/` (or `profiles/local` while signed out / in
 * detached local mode). The profile is resolved ONCE at process start from the
 * persisted login state; an auth change (login, logout, account switch)
 * relaunches the app instead of hot-swapping storage, so one account's state
 * can never bleed into another's within a process. Signing out keeps the
 * profile directory intact — the next sign-in to the same account reopens it.
 *
 * Device-scoped storage is deliberately tiny: only the auth token + user
 * profile in `userData/secrets.bin`, because the signed-in identity must be
 * readable before any profile can be chosen.
 */

let dir: string | null = null

/**
 * Resolve (and create) the active profile directory. Must run before initDb()
 * or anything else that touches profile storage. `userId` is the signed-in
 * server user id, or null when signed out.
 */
export function initProfile(userId: string | null): string {
  const name = userId ? userId.replace(/[^A-Za-z0-9._-]/g, '_') : 'local'
  dir = join(app.getPath('userData'), 'profiles', name)
  mkdirSync(dir, { recursive: true })
  migrateLegacyStore(dir)
  return dir
}

/** The active profile directory. Throws if initProfile() hasn't run yet. */
export function profileDir(): string {
  if (!dir) throw new Error('profileDir() called before initProfile()')
  return dir
}

/**
 * One-time upgrade: earlier versions kept everything at the top of userData.
 * Move those files into the profile active at first launch after the upgrade
 * (the signed-in account's, else `local`). Guarded on the profile not having a
 * db yet, so it can never clobber an existing profile.
 */
function migrateLegacyStore(profile: string): void {
  const root = app.getPath('userData')
  const legacyDb = join(root, 'flairy.db')
  if (!existsSync(legacyDb) || existsSync(join(profile, 'flairy.db'))) return
  const entries = [
    'flairy.db',
    'flairy.db-wal',
    'flairy.db-shm',
    'images',
    'skills',
    'worker-transcripts'
  ]
  for (const name of entries) {
    const from = join(root, name)
    if (!existsSync(from)) continue
    try {
      renameSync(from, join(profile, name))
    } catch (err) {
      console.error(`[profile] failed to migrate ${name} into profile:`, err)
    }
  }
}
