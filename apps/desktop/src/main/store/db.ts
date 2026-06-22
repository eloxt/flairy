import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionRemotePayload } from '@flairy/shared'
import type { SessionMeta, CreateSessionArgs } from '@shared/ipc'
import { t } from '../locale'

/**
 * SQLite persistence for sessions and their message history.
 * pi-agent-core keeps messages in memory (agent.state.messages); we snapshot
 * them here so sessions survive restarts and can be rehydrated.
 */
let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'flairy.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      cwd       TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      sessionId TEXT PRIMARY KEY,
      json      TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    -- Last server-pushed ConfigSnapshot, kept so the client stays usable when the
    -- server is unreachable. Single row (id = 0). The blob is the snapshot JSON
    -- ENCRYPTED via safeStorage (it carries the LLM credential) — never plaintext.
    CREATE TABLE IF NOT EXISTS config_cache (
      id        INTEGER PRIMARY KEY CHECK (id = 0),
      blob      BLOB NOT NULL,
      version   INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    -- Recently-used working directories for the composer's directory menu.
    -- Local-only (like sessions.cwd); newest RECENT_DIR_LIMIT are kept.
    CREATE TABLE IF NOT EXISTS recent_directories (
      path       TEXT PRIMARY KEY,
      lastUsedAt INTEGER NOT NULL
    );
    -- Local key/value settings (e.g. the chosen UI language). Local-only.
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  // Skills are no longer cached in SQLite — they're materialized straight to
  // userData/skills with an on-disk manifest. Drop the legacy table if present.
  db.exec('DROP TABLE IF EXISTS skill_cache;')

  // One-time seed: on first upgrade the recents table is empty, so backfill from
  // directories the user deliberately picked for existing sessions. Skip '~'
  // (sessions created without a pick) and the home dir (remote-synced sessions) —
  // neither was a deliberate choice.
  const seeded = db.prepare('SELECT 1 FROM recent_directories LIMIT 1').get()
  if (!seeded) {
    db.prepare(
      `INSERT OR IGNORE INTO recent_directories (path, lastUsedAt)
       SELECT cwd, updatedAt FROM sessions WHERE cwd NOT IN ('~', ?)`
    ).run(app.getPath('home'))
    pruneRecentDirectories()
  }
}

/** Persist the encrypted config snapshot blob (singleton row). */
export function saveConfigBlob(blob: Buffer, version: number): void {
  db.prepare(
    `INSERT INTO config_cache (id, blob, version, updatedAt) VALUES (0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       blob = excluded.blob, version = excluded.version, updatedAt = excluded.updatedAt`
  ).run(blob, version, Date.now())
}

/** Read the encrypted config snapshot blob, or undefined if nothing is cached. */
export function loadConfigBlob(): Buffer | undefined {
  const row = db.prepare('SELECT blob FROM config_cache WHERE id = 0').get() as
    | { blob: Buffer }
    | undefined
  return row?.blob
}

/** Drop the cached config snapshot (e.g. on sign-out). */
export function clearConfigBlob(): void {
  db.prepare('DELETE FROM config_cache WHERE id = 0').run()
}

/** Read a local setting value, or undefined if the key was never set. */
export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

/** Insert or update a local setting value. */
export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

export function createSession({ title, cwd }: CreateSessionArgs): SessionMeta {
  const now = Date.now()
  const meta: SessionMeta = {
    id: randomUUID(),
    title: title ?? t('defaultSessionTitle'),
    cwd,
    createdAt: now,
    updatedAt: now
  }
  db.prepare(
    'INSERT INTO sessions (id, title, cwd, createdAt, updatedAt) VALUES (@id, @title, @cwd, @createdAt, @updatedAt)'
  ).run(meta)
  return meta
}

export function listSessions(): SessionMeta[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updatedAt DESC').all() as SessionMeta[]
}

export function getSession(id: string): SessionMeta | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionMeta | undefined
}

/**
 * Update a session's working directory. Intentionally does NOT touch
 * `updatedAt`: the session list is ordered by `updatedAt DESC`, and a pure cwd
 * change shouldn't reorder the sidebar.
 */
export function updateSessionCwd(id: string, cwd: string): SessionMeta | undefined {
  db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(cwd, id)
  return getSession(id)
}

/** How many recent directories the composer menu keeps. */
const RECENT_DIR_LIMIT = 10

/** Strip trailing slashes so `/foo` and `/foo/` dedupe to one recents entry. */
function normalizeDir(path: string): string {
  return path.replace(/\/+$/, '') || path
}

/** Delete all but the newest RECENT_DIR_LIMIT recent directories. */
function pruneRecentDirectories(): void {
  db.prepare(
    `DELETE FROM recent_directories WHERE path NOT IN (
       SELECT path FROM recent_directories ORDER BY lastUsedAt DESC LIMIT ?
     )`
  ).run(RECENT_DIR_LIMIT)
}

/** Record a directory as used now (insert or bump), then prune to the newest N. */
export function addRecentDirectory(path: string): void {
  const p = normalizeDir(path)
  db.prepare(
    `INSERT INTO recent_directories (path, lastUsedAt) VALUES (?, ?)
     ON CONFLICT(path) DO UPDATE SET lastUsedAt = excluded.lastUsedAt`
  ).run(p, Date.now())
  pruneRecentDirectories()
}

/** Previously-used working directories, newest first (max RECENT_DIR_LIMIT). */
export function listRecentDirectories(): string[] {
  return (
    db.prepare('SELECT path FROM recent_directories ORDER BY lastUsedAt DESC').all() as {
      path: string
    }[]
  ).map((r) => r.path)
}

/**
 * Set a session's title (used by automatic title generation). Like
 * {@link updateSessionCwd}, it intentionally does NOT touch `updatedAt` so a
 * title change doesn't reorder the sidebar.
 */
export function updateSessionTitle(id: string, title: string): SessionMeta | undefined {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  return getSession(id)
}

/**
 * Delete a session and its messages locally. Atomic (both tables in one
 * transaction) so a session row never outlives its messages or vice versa.
 * There's no FK/cascade between the tables, so we delete both explicitly; order
 * is irrelevant for integrity — only atomicity matters. Returns whether a
 * session row was actually removed (false for an already-gone id → idempotent).
 */
export function deleteSession(id: string): boolean {
  // Build the transaction at call time: `db` is only assigned in initDb(), so a
  // module-eval `db.transaction(...)` would touch an undefined binding.
  return db.transaction((sid: string): boolean => {
    db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sid)
    const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    return res.changes > 0
  })(id)
}

/**
 * Wipe all locally-cached sessions and their messages (sign-out). The server is
 * the source of truth for history, so a relogin repopulates via session:pull;
 * clearing here prevents one user's sessions from leaking to the next account
 * signed in on the same machine. Atomic so a session row never outlives its
 * messages. Local-only concepts (recents, config cache) are cleared elsewhere.
 */
export function clearAllSessions(): void {
  db.transaction(() => {
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM sessions').run()
  })()
}

export function loadMessages(sessionId: string): unknown[] {
  const row = db.prepare('SELECT json FROM messages WHERE sessionId = ?').get(sessionId) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as unknown[]) : []
}

export async function saveMessages(sessionId: string, messages: unknown[]): Promise<void> {
  const now = Date.now()
  db.prepare(
    `INSERT INTO messages (sessionId, json, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
  ).run(sessionId, JSON.stringify(messages), now)
  db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId)
}

/**
 * Apply a session pushed from another device. Upserts the session row (cwd is a
 * local-only concept the server doesn't carry, so we keep any existing value and
 * fall back to the home dir for brand-new sessions) and replaces its messages
 * with the rehydrated pi payloads (SyncMessage.raw).
 */
export function upsertRemoteSession(payload: SessionRemotePayload): void {
  const { session, messages } = payload
  const existing = getSession(session.id)
  const cwd = existing?.cwd ?? app.getPath('home')

  db.prepare(
    `INSERT INTO sessions (id, title, cwd, createdAt, updatedAt)
     VALUES (@id, @title, @cwd, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updatedAt = excluded.updatedAt`
  ).run({
    id: session.id,
    title: session.title,
    cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  })

  const raw = messages.map((m) => m.raw)
  db.prepare(
    `INSERT INTO messages (sessionId, json, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
  ).run(session.id, JSON.stringify(raw), session.updatedAt)
}
