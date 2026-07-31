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
            );",
        )
        .ok()?;
        Some(Self { conn })
    }

    pub fn save(&self, session: &Session) {
        if session.agent_history.is_empty() {
            return;
        }
        let history = serde_json::to_string(&session.agent_history).unwrap_or_default();
        let _ = self.conn.execute(
            "INSERT INTO sessions (id, title, updated_at, history) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET title=?2, updated_at=?3, history=?4",
            rusqlite::params![session.id, session.title, session.updated_at, history],
        );
    }

    pub fn delete(&self, id: &str) {
        let _ = self.conn.execute("DELETE FROM sessions WHERE id = ?1", [id]);
    }

    pub fn load_all(&self) -> Vec<Session> {
        let Ok(mut stmt) = self
            .conn
            .prepare("SELECT id, title, updated_at, history FROM sessions ORDER BY updated_at DESC")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.filter_map(|r| r.ok())
            .map(|(id, title, updated_at, history)| {
                let agent_history: Vec<flairy_agent::Message> =
                    serde_json::from_str(&history).unwrap_or_default();
                let msgs = crate::contract::msgs_from_history(&agent_history);
                Session {
                    id,
                    title,
                    running: false,
                    msgs,
                    agent_history,
                    updated_at,
                    queued: Vec::new(),
                    allowed_tools: Default::default(),
                    usage_input: 0,
                    usage_output: 0,
                    requests: 0,
                    last_input: 0,
                }
            })
            .collect()
    }
}
