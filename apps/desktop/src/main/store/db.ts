import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionRemotePayload } from '@flairy/shared'
import type { SessionMeta, CreateSessionArgs, SearchHit } from '@shared/ipc'
import { t } from '../locale'

/**
 * SQLite persistence for sessions and their message history.
 * pi-agent-core keeps messages in memory (agent.state.messages); we snapshot
 * them here so sessions survive restarts and can be rehydrated.
 */
let db: Database.Database

/**
 * Whether the bundled SQLite supports FTS5 + the trigram tokenizer. Set false if
 * `CREATE VIRTUAL TABLE ... fts5` throws at init, in which case all FTS work is
 * skipped and {@link searchMessages} degrades to a title-only `sessions.title`
 * search so the search page still works (just with fewer hits).
 */
let ftsAvailable = true

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

  // Full-text search index over message content (+ a title row per session). Kept
  // in a separate try/catch: a SQLite build without FTS5/trigram must not crash
  // startup — search just degrades to title-only (see `ftsAvailable`).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        sessionId UNINDEXED,
        msgIndex  UNINDEXED,
        role      UNINDEXED,
        text,
        tokenize = 'trigram'
      );
    `)
  } catch (err) {
    ftsAvailable = false
    console.error('[db] FTS5/trigram unavailable; search degrades to title-only:', err)
  }
  if (ftsAvailable) backfillFtsIfNeeded()
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
  reindexTitle(meta.id, meta.title)
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

/** Forget a recent directory (composer menu right-click → remove). No-op if absent. */
export function removeRecentDirectory(path: string): void {
  db.prepare('DELETE FROM recent_directories WHERE path = ?').run(normalizeDir(path))
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
  reindexTitle(id, title)
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
    if (ftsAvailable) db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(sid)
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
    if (ftsAvailable) db.prepare('DELETE FROM messages_fts').run()
    db.prepare('DELETE FROM sessions').run()
  })()
}

export function loadMessages(sessionId: string): unknown[] {
  const row = db.prepare('SELECT json FROM messages WHERE sessionId = ?').get(sessionId) as
    | { json: string }
    | undefined
  if (!row) return []
  // Guard against a corrupt blob so one bad row can't throw (e.g. during backfill).
  try {
    return JSON.parse(row.json) as unknown[]
  } catch {
    return []
  }
}

export async function saveMessages(sessionId: string, messages: unknown[]): Promise<void> {
  const now = Date.now()
  // Atomic: the message write and the FTS reindex commit together so a crash
  // between them can't drift the index from the source blob. The body is fully
  // synchronous better-sqlite3 work, so wrap the BODY (not this async function —
  // better-sqlite3 rejects a Promise-returning transaction fn).
  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (sessionId, json, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
    ).run(sessionId, JSON.stringify(messages), now)
    db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId)
    reindexMessages(sessionId, messages)
  })()
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
  const raw = messages.map((m) => m.raw)

  // Atomic so the session/messages write and the FTS reindex commit together.
  db.transaction(() => {
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

    db.prepare(
      `INSERT INTO messages (sessionId, json, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
    ).run(session.id, JSON.stringify(raw), session.updatedAt)

    reindexTitle(session.id, session.title)
    reindexMessages(session.id, raw)
  })()
}

/* ---------- Full-text search ---------- */

/** Max search hits returned per query. */
const SEARCH_LIMIT = 50

/** Control-char markers wrapping a matched span in a snippet (see searchMessages). */
const MARK_START = String.fromCharCode(2)
const MARK_END = String.fromCharCode(3)

/** Flatten a persisted pi message's text, mirroring the renderer's partsToText. */
function partsToSearchText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) =>
      p && typeof p === 'object' && (p as { type?: string }).type === 'text'
        ? String((p as { text?: unknown }).text ?? '')
        : ''
    )
    .join('')
}

/**
 * Extract the searchable text of one persisted message, or null if it shouldn't be
 * indexed. Only user/assistant text is indexed — tool calls and tool results are
 * deliberately excluded so search stays clean for non-technical users.
 */
function extractMessageText(message: unknown): { role: 'user' | 'assistant'; text: string } | null {
  const m = message as { role?: string; content?: unknown }
  if (m.role !== 'user' && m.role !== 'assistant') return null
  const text = partsToSearchText(m.content).trim()
  if (!text) return null
  return { role: m.role, text }
}

/** Rewrite a session's message rows in the FTS index (keeps the title row intact). */
function reindexMessages(sessionId: string, messages: unknown[]): void {
  if (!ftsAvailable) return
  db.prepare("DELETE FROM messages_fts WHERE sessionId = ? AND role != 'title'").run(sessionId)
  const ins = db.prepare(
    'INSERT INTO messages_fts (sessionId, msgIndex, role, text) VALUES (?, ?, ?, ?)'
  )
  messages.forEach((msg, i) => {
    const ex = extractMessageText(msg)
    if (ex) ins.run(sessionId, i, ex.role, ex.text)
  })
}

/** Rewrite a session's single title row in the FTS index (msgIndex = -1). */
function reindexTitle(sessionId: string, title: string): void {
  if (!ftsAvailable) return
  db.prepare("DELETE FROM messages_fts WHERE sessionId = ? AND role = 'title'").run(sessionId)
  const t = title.trim()
  if (t) {
    db.prepare(
      "INSERT INTO messages_fts (sessionId, msgIndex, role, text) VALUES (?, -1, 'title', ?)"
    ).run(sessionId, t)
  }
}

/**
 * One-time backfill of the FTS index from existing history. Guarded by a setting
 * flag so it runs once. Each session is wrapped in its own try/catch (NOT one giant
 * transaction) so a single corrupt blob can't abort the whole backfill or block startup.
 */
function backfillFtsIfNeeded(): void {
  if (getSetting('fts_backfilled') === '1') return
  for (const s of listSessions()) {
    try {
      reindexTitle(s.id, s.title)
      reindexMessages(s.id, loadMessages(s.id))
    } catch (err) {
      console.error(`[db] FTS backfill failed for session ${s.id}:`, err)
    }
  }
  setSetting('fts_backfilled', '1')
}

/** Escape LIKE wildcards so a query is matched literally (paired with ESCAPE '\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

/** Quote a query as an FTS5 phrase so operators/special chars are treated literally. */
function ftsPhrase(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"'
}

/** Build a centered snippet with markers for the LIKE (<3 char) fallback path. */
function likeSnippet(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text.slice(0, 120)
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + q.length + 60)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, idx) +
    MARK_START +
    text.slice(idx, idx + q.length) +
    MARK_END +
    text.slice(idx + q.length, end) +
    (end < text.length ? '…' : '')
  )
}

/**
 * Full-text search over message content + session titles. Queries >= 3 chars use the
 * FTS5 trigram index (ranked by bm25, snippet via control-char markers); shorter
 * queries fall back to LIKE on the stored text (correct substring behavior for the
 * common 2-char CJK case). When FTS is unavailable, degrades to a title-only search so
 * the search page still works.
 */
export function searchMessages(query: string, limit = SEARCH_LIMIT): SearchHit[] {
  const q = query.trim()
  if (!q) return []

  if (!ftsAvailable) {
    const rows = db
      .prepare(
        `SELECT id AS sessionId, title AS sessionTitle, updatedAt
         FROM sessions WHERE title LIKE ? ESCAPE '\\' ORDER BY updatedAt DESC LIMIT ?`
      )
      .all(`%${escapeLike(q)}%`, limit) as {
      sessionId: string
      sessionTitle: string
      updatedAt: number
    }[]
    return rows.map((r) => ({
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      msgIndex: -1,
      role: 'title',
      snippet: r.sessionTitle,
      updatedAt: r.updatedAt
    }))
  }

  if (q.length >= 3) {
    return db
      .prepare(
        `SELECT f.sessionId AS sessionId, f.msgIndex AS msgIndex, f.role AS role,
                snippet(messages_fts, 3, char(2), char(3), '…', 12) AS snippet,
                s.title AS sessionTitle, s.updatedAt AS updatedAt
         FROM messages_fts f JOIN sessions s ON s.id = f.sessionId
         WHERE messages_fts MATCH ?
         ORDER BY bm25(messages_fts), s.updatedAt DESC
         LIMIT ?`
      )
      .all(ftsPhrase(q), limit) as SearchHit[]
  }

  // < 3 chars: trigram MATCH can't help; substring-scan the stored text.
  const rows = db
    .prepare(
      `SELECT f.sessionId AS sessionId, f.msgIndex AS msgIndex, f.role AS role,
              f.text AS text, s.title AS sessionTitle, s.updatedAt AS updatedAt
       FROM messages_fts f JOIN sessions s ON s.id = f.sessionId
       WHERE f.text LIKE ? ESCAPE '\\'
       ORDER BY s.updatedAt DESC
       LIMIT ?`
    )
    .all(`%${escapeLike(q)}%`, limit) as {
    sessionId: string
    msgIndex: number
    role: SearchHit['role']
    text: string
    sessionTitle: string
    updatedAt: number
  }[]
  return rows.map((r) => ({
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    msgIndex: r.msgIndex,
    role: r.role,
    snippet: likeSnippet(r.text, q),
    updatedAt: r.updatedAt
  }))
}
