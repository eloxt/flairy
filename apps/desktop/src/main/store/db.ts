import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Memory, SessionRemotePayload } from '@flairy/shared'
import type { SessionMeta, CreateSessionArgs, SearchHit, ChatWidth, ConfigMode } from '@shared/ipc'
import { dehydrateImages, IMAGE_REF_SCAN_RE } from './image-store'
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
  // WAL's standard durability setting: without it every commit fsyncs (FULL),
  // and messages are re-persisted on turn boundaries plus many small setting/
  // recents writes. NORMAL only risks the last few transactions on an OS crash
  // — and the message blob is rewritten wholesale on the next persist anyway.
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      cwd       TEXT NOT NULL,
      workspacePath TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      sessionId TEXT PRIMARY KEY,
      json      TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    -- Context-compression summary, one row per session. The agent keeps the full
    -- message history intact (display + sync); this summary only replaces the
    -- OLDER prefix in the LLM-bound view (convertToLlm). upTo is the count of
    -- conversational messages (user/assistant/toolResult, in filtered order)
    -- already folded into summary. Kept separate from the messages blob so the
    -- blob's atomic write/sync stays untouched.
    CREATE TABLE IF NOT EXISTS context_compression (
      sessionId TEXT PRIMARY KEY,
      summary   TEXT NOT NULL DEFAULT '',
      upTo      INTEGER NOT NULL DEFAULT 0,
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
    -- User-authored LOCAL config for "detached" mode (Advanced settings). Single
    -- row (id = 0). The blob is the local config bundle JSON ENCRYPTED via
    -- safeStorage (it carries LLM/MCP/service secrets) — never plaintext. Kept
    -- separate from config_cache so switching modes never clobbers the other.
    CREATE TABLE IF NOT EXISTS local_config (
      id        INTEGER PRIMARY KEY CHECK (id = 0),
      blob      BLOB NOT NULL,
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
    -- Long-term agent memory (user-scoped). Written by the remember tool,
    -- injected into the system prompt, and mirrored to the server for multi-device
    -- sync. Deletes are SOFT (deletedAt set) so a deletion propagates via
    -- memory:pull instead of being resurrected. Mirrors the server memories
    -- table and the @flairy/shared Memory contract.
    CREATE TABLE IF NOT EXISTS memories (
      id        TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      text      TEXT NOT NULL,
      source    TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      deletedAt INTEGER
    );
    -- Telegram: (chat_id, thread_key) → session_id mapping.
    -- thread_key = message_thread_id ?? 0 so the General/default forum topic
    -- dedupes correctly (NULLs are distinct under SQLite UNIQUE, non-NULL 0 is not).
    CREATE TABLE IF NOT EXISTS telegram_threads (
      session_id TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL,
      thread_key INTEGER NOT NULL DEFAULT 0,
      title      TEXT,
      created_at INTEGER,
      UNIQUE(chat_id, thread_key)
    );
    -- Single-row binding: the one Telegram chat paired as the sole owner.
    -- id = 0 constraint (same pattern as config_cache) enforces a single row.
    CREATE TABLE IF NOT EXISTS telegram_binding (
      id               INTEGER PRIMARY KEY CHECK (id = 0),
      bound_chat_id    TEXT,
      bound_chat_title TEXT,
      bound_user_id    TEXT,
      enabled          INTEGER,
      updated_at       INTEGER
    );
    -- Append-only audit of every remote-driven tool decision.
    -- args_preview is a redacted/truncated snippet (mask token-shaped substrings);
    -- args_hash is the tamper-evidence. Full args are only shown ephemerally
    -- in the approval card and are never persisted in cleartext.
    CREATE TABLE IF NOT EXISTS telegram_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT,
      chat_id      TEXT,
      thread_key   INTEGER,
      tool_name    TEXT,
      args_hash    TEXT,
      args_preview TEXT,
      decision     TEXT,
      created_at   INTEGER
    );
  `)
  // Skills are no longer cached in SQLite — they're materialized straight to
  // userData/skills with an on-disk manifest. Drop the legacy table if present.
  db.exec('DROP TABLE IF EXISTS skill_cache;')

  // Idempotent migration: project/chat is local-only. A null workspacePath means
  // a synced chat; a path means a local project grouped by that workspace.
  {
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
      (c) => c.name
    )
    if (!cols.includes('workspacePath')) {
      db.exec('ALTER TABLE sessions ADD COLUMN workspacePath TEXT')
      db.prepare(
        `UPDATE sessions
         SET workspacePath = cwd
         WHERE cwd NOT IN ('~', ?)`
      ).run(app.getPath('home'))
    }
  }

  // Idempotent migration: existing installs created telegram_binding before the
  // bound_user_id column existed. Add it if missing so a paired chat can pin
  // approvals to the specific user who completed pairing (L3 hardening).
  {
    const cols = (
      db.prepare('PRAGMA table_info(telegram_binding)').all() as { name: string }[]
    ).map((c) => c.name)
    if (!cols.includes('bound_user_id')) {
      db.exec('ALTER TABLE telegram_binding ADD COLUMN bound_user_id TEXT')
    }
  }

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
  if (ftsAvailable) {
    // One-time upgrade backfill, deferred past window creation and chunked so
    // it can't hold up first paint (it used to run synchronously before the
    // first window, one autocommit-fsync per message — seconds of blank screen
    // on a large history). unref'd: a quick quit just retries next launch.
    const timer = setTimeout(backfillFtsIfNeeded, 5_000)
    timer.unref()
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

/** Persist the encrypted local-config bundle blob (singleton row). */
export function saveLocalConfigBlob(blob: Buffer): void {
  db.prepare(
    `INSERT INTO local_config (id, blob, updatedAt) VALUES (0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updatedAt = excluded.updatedAt`
  ).run(blob, Date.now())
}

/** Read the encrypted local-config bundle blob, or undefined if none saved. */
export function loadLocalConfigBlob(): Buffer | undefined {
  const row = db.prepare('SELECT blob FROM local_config WHERE id = 0').get() as
    | { blob: Buffer }
    | undefined
  return row?.blob
}

/** Drop the saved local config (e.g. on sign-out). */
export function clearLocalConfigBlob(): void {
  db.prepare('DELETE FROM local_config WHERE id = 0').run()
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

/**
 * Close-to-tray preference. Defaults ON: only an explicit '0' disables it, so a
 * fresh install keeps Flairy running in the tray when its window is closed.
 */
export function getCloseToTrayPref(): boolean {
  return getSetting('closeToTray') !== '0'
}

export function setCloseToTrayPref(value: boolean): void {
  setSetting('closeToTray', value ? '1' : '0')
}

/** Default quick-launcher summon chord (Electron accelerator string). */
export const DEFAULT_LAUNCHER_SHORTCUT = 'Control+Space'

/**
 * Quick-launcher global shortcut preference. An Electron accelerator string;
 * the empty string means the user turned the shortcut off. Missing (never set)
 * falls back to the default chord.
 */
export function getLauncherShortcutPref(): string {
  return getSetting('launcherShortcut') ?? DEFAULT_LAUNCHER_SHORTCUT
}

export function setLauncherShortcutPref(value: string): void {
  setSetting('launcherShortcut', value)
}

/** Chat column width preference. Unknown/missing values fall back to "standard". */
export function getChatWidthPref(): ChatWidth {
  const v = getSetting('chatWidth')
  return v === 'wide' || v === 'full' ? v : 'standard'
}

export function setChatWidthPref(value: ChatWidth): void {
  setSetting('chatWidth', value)
}

/**
 * Advanced-settings unlock flag. Hidden by default: the tab only appears after
 * the user taps the version number 10× (persisted so it stays revealed). Only an
 * explicit '1' unlocks it.
 */
export function getAdvancedUnlockedPref(): boolean {
  return getSetting('advancedUnlocked') === '1'
}

export function setAdvancedUnlockedPref(value: boolean): void {
  setSetting('advancedUnlocked', value ? '1' : '0')
}

/**
 * The user's own main-model pick (an `llm_models` id from
 * `ConfigSnapshot.modelOptions`), per device. Null/empty means no pick — the
 * admin-assigned main model applies.
 */
export function getPreferredMainModelPref(): string | null {
  return getSetting('preferredMainModelId') || null
}

export function setPreferredMainModelPref(id: string | null): void {
  setSetting('preferredMainModelId', id ?? '')
}

/** Config source. Defaults to 'server'; 'local' means the detached/offline mode. */
export function getConfigModePref(): ConfigMode {
  return getSetting('configMode') === 'local' ? 'local' : 'server'
}

export function setConfigModePref(value: ConfigMode): void {
  setSetting('configMode', value)
}

export function createSession({ title, cwd, workspacePath }: CreateSessionArgs): SessionMeta {
  const now = Date.now()
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath ?? workspaceFromCwd(cwd))
  const meta: SessionMeta = {
    id: randomUUID(),
    title: title ?? t('defaultSessionTitle'),
    cwd,
    workspacePath: normalizedWorkspace,
    kind: normalizedWorkspace ? 'project' : 'chat',
    createdAt: now,
    updatedAt: now
  }
  db.prepare(
    'INSERT INTO sessions (id, title, cwd, workspacePath, createdAt, updatedAt) VALUES (@id, @title, @cwd, @workspacePath, @createdAt, @updatedAt)'
  ).run(meta)
  reindexTitle(meta.id, meta.title)
  return meta
}

// `fromTelegram` marks sessions created from a Telegram chat (a telegram_threads
// mapping exists) so the renderer can tag them in the sidebar and make them
// read-only (they are driven only from Telegram).
const SESSION_SELECT =
  'SELECT sessions.*, EXISTS(SELECT 1 FROM telegram_threads t WHERE t.session_id = sessions.id) AS fromTelegram FROM sessions'

// SQLite returns `fromTelegram` as 0/1; SessionMeta types it as a boolean, so omit
// it from the base before intersecting to avoid a `boolean & number` (never) clash.
type RawSessionRow = Omit<SessionMeta, 'fromTelegram' | 'kind'> & { fromTelegram: number }

function normalizeWorkspacePath(path: string | null | undefined): string | null {
  if (!path || path === '~') return null
  const normalized = normalizeDir(path)
  return normalized === app.getPath('home') ? null : normalized
}

function workspaceFromCwd(cwd: string): string | null {
  return normalizeWorkspacePath(cwd)
}

function mapSessionRow(r: RawSessionRow): SessionMeta {
  const workspacePath = normalizeWorkspacePath(r.workspacePath)
  return {
    ...r,
    workspacePath,
    kind: workspacePath ? 'project' : 'chat',
    fromTelegram: !!r.fromTelegram
  }
}

export function listSessions(): SessionMeta[] {
  const rows = db.prepare(`${SESSION_SELECT} ORDER BY updatedAt DESC`).all() as RawSessionRow[]
  return rows.map(mapSessionRow)
}

export function getSession(id: string): SessionMeta | undefined {
  const row = db.prepare(`${SESSION_SELECT} WHERE sessions.id = ?`).get(id) as
    | RawSessionRow
    | undefined
  return row ? mapSessionRow(row) : undefined
}

/**
 * Update a session's working directory. Intentionally does NOT touch
 * `updatedAt`: the session list is ordered by `updatedAt DESC`, and a pure cwd
 * change shouldn't reorder the sidebar.
 */
export function updateSessionCwd(id: string, cwd: string): SessionMeta | undefined {
  db.prepare('UPDATE sessions SET cwd = ?, workspacePath = ? WHERE id = ?').run(
    cwd,
    workspaceFromCwd(cwd),
    id
  )
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

/**
 * Ensure a directory is present in recents WITHOUT reordering it if it already
 * is (unlike {@link addRecentDirectory}, which bumps `lastUsedAt`). Used on
 * session open so a session's cwd shows up in the composer menu. A freshly
 * added entry sorts newest; an existing one keeps its place.
 */
export function ensureRecentDirectory(path: string): void {
  const res = db
    .prepare(
      `INSERT INTO recent_directories (path, lastUsedAt) VALUES (?, ?)
       ON CONFLICT(path) DO NOTHING`
    )
    .run(normalizeDir(path), Date.now())
  if (res.changes > 0) pruneRecentDirectories()
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
  ftsWatermarks.delete(id)
  return db.transaction((sid: string): boolean => {
    db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sid)
    if (ftsAvailable) db.prepare('DELETE FROM messages_fts WHERE sessionId = ?').run(sid)
    db.prepare('DELETE FROM context_compression WHERE sessionId = ?').run(sid)
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
 *
 * Telegram thread mappings are wiped in the same transaction: otherwise a mapping
 * would outlive its session row and "self-heal" a Telegram message into a session
 * under the NEXT account that signs in on this machine.
 */
export function clearAllSessions(): void {
  ftsWatermarks.clear()
  db.transaction(() => {
    db.prepare('DELETE FROM messages').run()
    if (ftsAvailable) db.prepare('DELETE FROM messages_fts').run()
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM context_compression').run()
    db.prepare('DELETE FROM telegram_threads').run()
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

/**
 * Persist a session's messages. Inline base64 images are extracted to the
 * on-disk image store first, so the SQLite blob (and everything later loaded
 * from it) carries only small refs. Returns the dehydrated array so the caller
 * can adopt it in memory too (identical to `messages` when nothing changed).
 */
export async function saveMessages(sessionId: string, messages: unknown[]): Promise<unknown[]> {
  const now = Date.now()
  const stored = dehydrateImages(messages)
  // Atomic: the message write and the FTS reindex commit together so a crash
  // between them can't drift the index from the source blob. The body is fully
  // synchronous better-sqlite3 work, so wrap the BODY (not this async function —
  // better-sqlite3 rejects a Promise-returning transaction fn).
  db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (sessionId, json, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt`
    ).run(sessionId, JSON.stringify(stored), now)
    db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(now, sessionId)
    updateMessagesFts(sessionId, messages, stored)
  })()
  return stored
}

/**
 * Every image-store file name still referenced by ANY persisted message, for
 * the orphan sweep (see image-store.sweepOrphanImages). Scans the raw JSON
 * blobs with a regex — refs are stored literally, so no per-session parse (and
 * no full-history allocation) is needed; rows stream one at a time.
 */
export function collectLiveImageNames(): Set<string> {
  const names = new Set<string>()
  const rows = db.prepare('SELECT json FROM messages').iterate() as IterableIterator<{
    json: string
  }>
  for (const row of rows) {
    for (const m of row.json.matchAll(IMAGE_REF_SCAN_RE)) names.add(m[1])
  }
  return names
}

/**
 * Load the persisted context-compression summary for a session, if any. Returns
 * null for a session that has never been compressed (so callers default cleanly).
 * `upTo` counts conversational messages (user/assistant/toolResult) in the
 * filtered order `convertToLlm` sees.
 */
export function loadCompression(
  sessionId: string
): { summary: string; upTo: number } | null {
  const row = db
    .prepare('SELECT summary, upTo FROM context_compression WHERE sessionId = ?')
    .get(sessionId) as { summary: string; upTo: number } | undefined
  return row ?? null
}

/**
 * Persist (or clear, when `summary` is empty) the context-compression summary.
 * One row per session, upserted atomically.
 */
export function saveCompression(
  sessionId: string,
  summary: string,
  upTo: number
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO context_compression (sessionId, summary, upTo, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(sessionId) DO UPDATE SET
       summary = excluded.summary,
       upTo = excluded.upTo,
       updatedAt = excluded.updatedAt`
  ).run(sessionId, summary, upTo, now)
}

/**
 * Drop a session's compression row. Called when a remote sync replaces the
 * message history the summary was bound to (see upsertRemoteSession).
 */
export function clearCompression(sessionId: string): void {
  db.prepare('DELETE FROM context_compression WHERE sessionId = ?').run(sessionId)
}

/**
 * Apply a chat pushed from another device. Project sessions are local-only; if a
 * local project has the same id (e.g. converted while offline), ignore the stale
 * remote chat so it cannot overwrite the project row on reconnect.
 */
export function upsertRemoteSession(payload: SessionRemotePayload): boolean {
  const { session, messages } = payload
  const existing = getSession(session.id)
  if (existing?.kind === 'project') return false
  const cwd = existing?.cwd ?? '~'
  // Extract inline base64 images (another device syncs full bytes) into the
  // local image store so the SQLite blob stays small, mirroring saveMessages.
  const raw = dehydrateImages(messages.map((m) => m.raw))
  const json = JSON.stringify(raw)

  // Atomic so the session/messages write and the FTS reindex commit together.
  db.transaction(() => {
    // The compression summary is bound to the exact history it folded (upTo is
    // a message index). If the remote payload rewrites that history, drop it —
    // keeping it would slice the wrong messages out of the LLM view on next
    // open. An identical blob (routine reconnect pull) keeps it.
    const prev = db
      .prepare('SELECT json FROM messages WHERE sessionId = ?')
      .get(session.id) as { json: string } | undefined
    if (prev?.json !== json) clearCompression(session.id)

    db.prepare(
      `INSERT INTO sessions (id, title, cwd, workspacePath, createdAt, updatedAt)
       VALUES (@id, @title, @cwd, NULL, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         workspacePath = NULL,
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
    ).run(session.id, json, session.updatedAt)

    reindexTitle(session.id, session.title)
    reindexMessages(session.id, raw)
  })()
  return true
}

/* ---------- Long-term agent memory ---------- */

/** Map a DB row to the wire Memory shape (NULL deletedAt → null). */
function mapMemoryRow(r: {
  id: string
  type: string
  text: string
  source: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}): Memory {
  return {
    id: r.id,
    type: r.type as Memory['type'],
    text: r.text,
    source: r.source ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt
  }
}

/**
 * Active (not soft-deleted) memories, newest first. Used by the management UI.
 */
export function listMemories(): Memory[] {
  const rows = db
    .prepare(
      'SELECT id, type, text, source, createdAt, updatedAt, deletedAt FROM memories WHERE deletedAt IS NULL ORDER BY updatedAt DESC'
    )
    .all() as Parameters<typeof mapMemoryRow>[0][]
  return rows.map(mapMemoryRow)
}

/**
 * Active memories oldest-first, for system-prompt injection (stable order so the
 * prompt doesn't churn between turns). Capped so the prompt can't grow unbounded.
 */
export function listActiveMemoriesForPrompt(limit = 200): Memory[] {
  const rows = db
    .prepare(
      'SELECT id, type, text, source, createdAt, updatedAt, deletedAt FROM memories WHERE deletedAt IS NULL ORDER BY createdAt ASC LIMIT ?'
    )
    .all(limit) as Parameters<typeof mapMemoryRow>[0][]
  return rows.map(mapMemoryRow)
}

/**
 * Insert or update a single memory (last-writer-wins on updatedAt, so a stale
 * write can't clobber a fresher one). Returns the stored row.
 */
export function upsertMemory(memory: Memory): Memory {
  db.prepare(
    `INSERT INTO memories (id, type, text, source, createdAt, updatedAt, deletedAt)
     VALUES (@id, @type, @text, @source, @createdAt, @updatedAt, @deletedAt)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       text = excluded.text,
       source = excluded.source,
       updatedAt = excluded.updatedAt,
       deletedAt = excluded.deletedAt
     WHERE memories.updatedAt <= excluded.updatedAt`
  ).run({
    id: memory.id,
    type: memory.type,
    text: memory.text,
    source: memory.source ?? null,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    deletedAt: memory.deletedAt ?? null
  })
  return memory
}

/**
 * Soft-delete a memory (set deletedAt = now, bump updatedAt). Returns the
 * updated row so the caller can mirror the tombstone to the server, or undefined
 * if the id is unknown. No-op if already deleted.
 */
export function softDeleteMemory(id: string): Memory | undefined {
  const now = Date.now()
  db.prepare(
    'UPDATE memories SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL'
  ).run(now, now, id)
  const row = db
    .prepare(
      'SELECT id, type, text, source, createdAt, updatedAt, deletedAt FROM memories WHERE id = ?'
    )
    .get(id) as Parameters<typeof mapMemoryRow>[0] | undefined
  return row ? mapMemoryRow(row) : undefined
}

/**
 * Apply a batch of memories pushed/pulled from the server (last-writer-wins per
 * id). Carries tombstones (deletedAt set) so remote deletions land locally.
 */
export function upsertRemoteMemories(memories: Memory[]): void {
  db.transaction(() => {
    for (const m of memories) upsertMemory(m)
  })()
}

/**
 * Wipe all locally-cached memories (sign-out), mirroring clearAllSessions: the
 * server is the source of truth and a relogin repopulates via memory:pull, so
 * clearing here stops one account's memories leaking to the next on this machine.
 */
export function clearAllMemories(): void {
  db.prepare('DELETE FROM memories').run()
}

/* ---------- Telegram thread mapping ---------- */

/** A row from the telegram_threads table (camelCase for TS consumers). */
export interface TelegramThreadRow {
  sessionId: string
  chatId: string
  threadKey: number
  title: string | null
  createdAt: number | null
}

type RawThreadRow = {
  session_id: string
  chat_id: string
  thread_key: number
  title: string | null
  created_at: number | null
}

function mapThreadRow(r: RawThreadRow): TelegramThreadRow {
  return {
    sessionId: r.session_id,
    chatId: r.chat_id,
    threadKey: r.thread_key,
    title: r.title,
    createdAt: r.created_at
  }
}

/**
 * Look up the thread mapping for a (chatId, threadKey) pair.
 * Returns undefined if no session has been mapped to this topic yet.
 */
export function getTelegramThread(chatId: string, threadKey: number): TelegramThreadRow | undefined {
  const row = db
    .prepare(
      'SELECT session_id, chat_id, thread_key, title, created_at FROM telegram_threads WHERE chat_id = ? AND thread_key = ?'
    )
    .get(chatId, threadKey) as RawThreadRow | undefined
  return row ? mapThreadRow(row) : undefined
}

/** Persist a new (chatId, threadKey) → sessionId mapping. */
export function createTelegramThread({
  sessionId,
  chatId,
  threadKey,
  title
}: {
  sessionId: string
  chatId: string
  threadKey: number
  title?: string
}): TelegramThreadRow {
  const now = Date.now()
  db.prepare(
    `INSERT INTO telegram_threads (session_id, chat_id, thread_key, title, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, chatId, threadKey, title ?? null, now)
  return { sessionId, chatId, threadKey, title: title ?? null, createdAt: now }
}

/** Look up the Telegram thread row for a given Flairy sessionId (reverse lookup). */
export function getTelegramThreadBySession(sessionId: string): TelegramThreadRow | undefined {
  const row = db
    .prepare(
      'SELECT session_id, chat_id, thread_key, title, created_at FROM telegram_threads WHERE session_id = ?'
    )
    .get(sessionId) as RawThreadRow | undefined
  return row ? mapThreadRow(row) : undefined
}

/** Update the stored title for a Telegram thread (mirrors the session's generated title). */
export function updateTelegramThreadTitle(sessionId: string, title: string): void {
  db.prepare('UPDATE telegram_threads SET title = ? WHERE session_id = ?').run(title, sessionId)
}

/**
 * Delete the Telegram thread mapping for a session (called on session delete,
 * remote-delete, and logout to keep the mapping table clean).
 */
export function deleteTelegramThread(sessionId: string): void {
  db.prepare('DELETE FROM telegram_threads WHERE session_id = ?').run(sessionId)
}

/**
 * All session ids that have an active Telegram thread mapping.
 * Used at startup to seed the TelegramManager's in-memory owned-session Set.
 */
export function listTelegramSessionIds(): string[] {
  return (db.prepare('SELECT session_id FROM telegram_threads').all() as { session_id: string }[]).map(
    (r) => r.session_id
  )
}

/* ---------- Telegram binding (single-row) ---------- */

/** The paired Telegram chat that owns this Flairy instance. */
export interface TelegramBindingRow {
  chatId: string | null
  chatTitle: string | null
  /** Telegram user id of the sender who completed pairing; pins approval taps. */
  userId: string | null
  enabled: boolean
  updatedAt: number | null
}

/** Read the current binding, or undefined if no chat has been paired yet. */
export function getTelegramBinding(): TelegramBindingRow | undefined {
  const row = db
    .prepare(
      'SELECT bound_chat_id, bound_chat_title, bound_user_id, enabled, updated_at FROM telegram_binding WHERE id = 0'
    )
    .get() as
    | {
        bound_chat_id: string | null
        bound_chat_title: string | null
        bound_user_id: string | null
        enabled: number | null
        updated_at: number | null
      }
    | undefined
  if (!row) return undefined
  return {
    chatId: row.bound_chat_id,
    chatTitle: row.bound_chat_title,
    userId: row.bound_user_id,
    enabled: Boolean(row.enabled),
    updatedAt: row.updated_at
  }
}

/** Upsert the binding row. Callers pass a precomputed chatId, title, user id, and enabled flag. */
export function setTelegramBinding({
  chatId,
  title,
  userId,
  enabled
}: {
  chatId: string
  title: string
  userId: string | null
  enabled: boolean
}): void {
  db.prepare(
    `INSERT INTO telegram_binding (id, bound_chat_id, bound_chat_title, bound_user_id, enabled, updated_at)
     VALUES (0, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       bound_chat_id    = excluded.bound_chat_id,
       bound_chat_title = excluded.bound_chat_title,
       bound_user_id    = excluded.bound_user_id,
       enabled          = excluded.enabled,
       updated_at       = excluded.updated_at`
  ).run(chatId, title, userId, enabled ? 1 : 0, Date.now())
}

/** Flip only the binding's `enabled` flag (pause / resume). No-op if unpaired. */
export function setTelegramBindingEnabled(enabled: boolean): void {
  db.prepare('UPDATE telegram_binding SET enabled = ?, updated_at = ? WHERE id = 0').run(
    enabled ? 1 : 0,
    Date.now()
  )
}

/** Remove the binding row (unpair or sign-out). No-op if already absent. */
export function clearTelegramBinding(): void {
  db.prepare('DELETE FROM telegram_binding WHERE id = 0').run()
}

/* ---------- Telegram audit log ---------- */

/**
 * Append one record to the immutable Telegram tool-decision audit log.
 * `argsHash` is the tamper-evidence; `argsPreview` is a redacted/truncated
 * snippet — both are computed by the caller before this call.
 */
export function appendTelegramAudit({
  sessionId,
  chatId,
  threadKey,
  toolName,
  argsHash,
  argsPreview,
  decision
}: {
  sessionId: string
  chatId: string
  threadKey: number
  toolName: string
  argsHash: string
  argsPreview: string
  decision: string
}): void {
  db.prepare(
    `INSERT INTO telegram_audit (session_id, chat_id, thread_key, tool_name, args_hash, args_preview, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, chatId, threadKey, toolName, argsHash, argsPreview, decision, Date.now())
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

/**
 * Per-session FTS high-watermark: how many messages are already indexed, plus
 * the OBJECT IDENTITIES that message[count-1] may present as on the next save
 * (the live in-memory array and/or its dehydrated clone — image extraction
 * clones image-bearing messages, and the agent adopts the clone array at run
 * end). If the next save's prefix still ends in one of these objects, history
 * was append-only and only the new tail needs indexing. In-memory only: the
 * first save of a session per app run does one full reindex, then increments.
 */
type FtsWatermark = { count: number; lastMsgIds: unknown[] }
const ftsWatermarks = new Map<string, FtsWatermark>()

function setFtsWatermark(sessionId: string, live: unknown[], stored?: unknown[]): void {
  const n = live.length
  const ids: unknown[] = []
  if (n > 0) {
    ids.push(live[n - 1])
    if (stored && stored[n - 1] !== live[n - 1]) ids.push(stored[n - 1])
  }
  ftsWatermarks.set(sessionId, { count: n, lastMsgIds: ids })
}

/**
 * Incremental FTS update for a routine save. History is append-only between
 * saves in the common case (pi only appends complete messages at turn
 * boundaries), verified via the watermark's object-identity check — so only
 * the new tail is inserted, skipping both the full-table DELETE scan
 * (`sessionId` is UNINDEXED in fts5, so that DELETE walks the ENTIRE index)
 * and the trigram re-tokenization of the whole history (~90ms on a 2MB
 * session, previously paid on every model round-trip). Any shrink or prefix
 * divergence (retry pop, remote restore) falls back to a full reindex.
 */
function updateMessagesFts(sessionId: string, live: unknown[], stored: unknown[]): void {
  if (!ftsAvailable) return
  const wm = ftsWatermarks.get(sessionId)
  const n = stored.length
  const prefixIntact =
    wm !== undefined &&
    wm.count <= n &&
    (wm.count === 0 ||
      wm.lastMsgIds.includes(live[wm.count - 1]) ||
      wm.lastMsgIds.includes(stored[wm.count - 1]))
  if (!prefixIntact) {
    reindexMessages(sessionId, stored)
    setFtsWatermark(sessionId, live, stored)
    return
  }
  if (wm.count < n) {
    const ins = db.prepare(
      'INSERT INTO messages_fts (sessionId, msgIndex, role, text) VALUES (?, ?, ?, ?)'
    )
    for (let i = wm.count; i < n; i++) {
      const ex = extractMessageText(stored[i])
      if (ex) ins.run(sessionId, i, ex.role, ex.text)
    }
  }
  setFtsWatermark(sessionId, live, stored)
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
  setFtsWatermark(sessionId, messages)
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
 * One-time backfill of the FTS index from existing history. Guarded by a
 * setting flag so it runs once. Each session commits as ONE transaction (a
 * per-message autocommit here used to mean one fsync per message) but stays
 * individually try/caught so a single corrupt blob can't abort the whole
 * backfill. Sessions are processed in small batches with a setImmediate yield
 * between them, so a big history doesn't monopolize the main thread.
 */
function backfillFtsIfNeeded(): void {
  if (getSetting('fts_backfilled') === '1') return
  const sessions = listSessions()
  const BATCH = 5
  let i = 0
  const step = (): void => {
    const end = Math.min(i + BATCH, sessions.length)
    for (; i < end; i++) {
      const s = sessions[i]
      try {
        db.transaction(() => {
          reindexTitle(s.id, s.title)
          reindexMessages(s.id, loadMessages(s.id))
        })()
      } catch (err) {
        console.error(`[db] FTS backfill failed for session ${s.id}:`, err)
      }
    }
    if (i < sessions.length) setImmediate(step)
    else setSetting('fts_backfilled', '1')
  }
  step()
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
