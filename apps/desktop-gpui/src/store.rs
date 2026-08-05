//! Local SQLite persistence (offline-first mirror of sessions).
//! Schema: one row per session, agent history as opaque JSON — UI rows are
//! re-hydrated from history on load, same as the sync path.

use crate::app::Session;
use rusqlite::Connection;
use std::path::PathBuf;

fn db_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(home).join("Library/Application Support/Flairy");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("flairy-gpui.db")
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open() -> Option<Self> {
        let conn = Connection::open(db_path()).ok()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                history TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
                source TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                prompt TEXT NOT NULL,
                cron TEXT,
                run_at INTEGER,
                active INTEGER NOT NULL DEFAULT 1,
                last_run INTEGER,
                created_at INTEGER NOT NULL
            );",
        )
        .ok()?;
        // Idempotent in-place migrations (no framework): adding usage columns
        // to pre-existing sessions tables. Errors (column exists) are ignored.
        for column in ["usage_input", "usage_output", "requests", "last_input"] {
            let _ = conn.execute(
                &format!("ALTER TABLE sessions ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"),
                [],
            );
        }
        // Accumulate-only auto tool selection union (JSON array of names).
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN tool_selection TEXT NOT NULL DEFAULT ''",
            [],
        );
        // Project workspace (NULL ⇒ plain chat). Device-local, never synced.
        let _ = conn.execute("ALTER TABLE sessions ADD COLUMN workspace_path TEXT", []);
        // Context compression: summary of history[..up_to] (device-local).
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN compression_summary TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE sessions ADD COLUMN compression_up_to INTEGER NOT NULL DEFAULT 0",
            [],
        );
        Some(Self { conn })
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            })
            .ok()
    }

    pub fn set_setting(&self, key: &str, value: &str) {
        let _ = self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=?2",
            [key, value],
        );
    }

    /// Upsert a batch of memories, newer `updated_at` wins (remote merges and
    /// local writes share this path). Tombstones (deleted_at set) are kept so
    /// deletions propagate instead of being resurrected by the next pull.
    pub fn upsert_memories(&self, memories: &[flairy_contract::Memory]) {
        for m in memories {
            let _ = self.conn.execute(
                "INSERT INTO memories (id, kind, text, source, created_at, updated_at, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE
                 SET kind=?2, text=?3, source=?4, created_at=?5, updated_at=?6, deleted_at=?7
                 WHERE excluded.updated_at > memories.updated_at",
                rusqlite::params![
                    m.id,
                    m.kind,
                    m.text,
                    m.source,
                    m.created_at,
                    m.updated_at,
                    m.deleted_at
                ],
            );
        }
    }

    pub fn create_task(&self, task: &crate::schedule::ScheduledTask) {
        let _ = self.conn.execute(
            "INSERT INTO scheduled_tasks (id, session_id, prompt, cron, run_at, active, last_run, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                task.id,
                task.session_id,
                task.prompt,
                task.cron,
                task.run_at,
                task.active as i64,
                task.last_run,
                task.created_at,
            ],
        );
    }

    pub fn list_tasks(&self) -> Vec<crate::schedule::ScheduledTask> {
        let Ok(mut stmt) = self.conn.prepare(
            "SELECT id, session_id, prompt, cron, run_at, active, last_run, created_at
             FROM scheduled_tasks ORDER BY created_at ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| {
            Ok(crate::schedule::ScheduledTask {
                id: row.get(0)?,
                session_id: row.get(1)?,
                prompt: row.get(2)?,
                cron: row.get(3)?,
                run_at: row.get(4)?,
                active: row.get::<_, i64>(5)? != 0,
                last_run: row.get(6)?,
                created_at: row.get(7)?,
            })
        });
        rows.map(|r| r.filter_map(|t| t.ok()).collect()).unwrap_or_default()
    }

    pub fn set_task_active(&self, id: &str, active: bool) -> bool {
        self.conn
            .execute(
                "UPDATE scheduled_tasks SET active = ?2 WHERE id = ?1",
                rusqlite::params![id, active as i64],
            )
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    pub fn delete_task(&self, id: &str) -> bool {
        self.conn
            .execute("DELETE FROM scheduled_tasks WHERE id = ?1", [id])
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// Stamp a run; one-shot tasks deactivate after firing.
    pub fn mark_task_run(&self, id: &str, now: i64, deactivate: bool) {
        let _ = self.conn.execute(
            "UPDATE scheduled_tasks SET last_run = ?2, active = active AND NOT ?3 WHERE id = ?1",
            rusqlite::params![id, now, deactivate],
        );
    }

    /// Soft-delete one memory (tombstone wins merges by newer updated_at).
    pub fn forget_memory(&self, id: &str) {
        let now = flairy_ai::types::now_ms() as i64;
        let _ = self.conn.execute(
            "UPDATE memories SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        );
    }

    /// Active (not soft-deleted) memories, oldest first — prompt order.
    pub fn active_memories(&self) -> Vec<flairy_contract::Memory> {
        let Ok(mut stmt) = self.conn.prepare(
            "SELECT id, kind, text, source, created_at, updated_at, deleted_at
             FROM memories WHERE deleted_at IS NULL ORDER BY created_at ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| {
            Ok(flairy_contract::Memory {
                id: row.get(0)?,
                kind: row.get(1)?,
                text: row.get(2)?,
                source: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                deleted_at: row.get(6)?,
            })
        });
        rows.map(|r| r.filter_map(|m| m.ok()).collect()).unwrap_or_default()
    }

    pub fn save(&self, session: &Session) {
        // Blank plain chats never persist; project sessions do even when empty
        // (they're created eagerly and must survive a restart).
        if session.agent_history.is_empty() && session.workspace_path.is_none() {
            return;
        }
        let history = serde_json::to_string(&session.agent_history).unwrap_or_default();
        let selection = if session.tool_selection.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&session.tool_selection.iter().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        let _ = self.conn.execute(
            "INSERT INTO sessions
                (id, title, updated_at, history, usage_input, usage_output, requests, last_input, tool_selection, workspace_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET title=?2, updated_at=?3, history=?4,
                usage_input=?5, usage_output=?6, requests=?7, last_input=?8, tool_selection=?9, workspace_path=?10",
            rusqlite::params![
                session.id,
                session.title,
                session.updated_at,
                history,
                session.usage_input as i64,
                session.usage_output as i64,
                session.requests,
                session.last_input,
                selection,
                session.workspace_path,
            ],
        );
        let _ = self.conn.execute(
            "UPDATE sessions SET compression_summary=?2, compression_up_to=?3 WHERE id=?1",
            rusqlite::params![
                session.id,
                session.compression_summary,
                session.compression_up_to as i64,
            ],
        );
    }

    pub fn delete(&self, id: &str) {
        let _ = self.conn.execute("DELETE FROM sessions WHERE id = ?1", [id]);
    }

    pub fn load_all(&self) -> Vec<Session> {
        let Ok(mut stmt) = self.conn.prepare(
            "SELECT id, title, updated_at, history, usage_input, usage_output, requests, last_input, tool_selection, workspace_path, compression_summary, compression_up_to
             FROM sessions ORDER BY updated_at DESC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, u32>(6)?,
                row.get::<_, u32>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i64>(11)?,
            ))
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|r| r.ok())
            .map(
                |(id, title, updated_at, history, usage_input, usage_output, requests, last_input, selection, workspace_path, compression_summary, compression_up_to)| {
                    let agent_history: Vec<flairy_agent::Message> =
                        serde_json::from_str(&history).unwrap_or_default();
                    let msgs = crate::contract::msgs_from_history(&agent_history);
                    let tool_selection: std::collections::HashSet<String> =
                        serde_json::from_str(&selection).unwrap_or_default();
                    let compression_up_to =
                        (compression_up_to.max(0) as usize).min(agent_history.len());
                    Session {
                        id,
                        title,
                        running: false,
                        msgs,
                        agent_history,
                        updated_at,
                        queued: Vec::new(),
                        allowed_tools: Default::default(),
                        usage_input: usage_input.max(0) as u64,
                        usage_output: usage_output.max(0) as u64,
                        requests,
                        last_input,
                        tool_selection,
                        workspace_path,
                        compression_summary,
                        compression_up_to,
                        run_compacted_up_to: None,
                        compressing: false,
                    }
                },
            )
            .collect()
    }
}
