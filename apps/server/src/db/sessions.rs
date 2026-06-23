//! Session sync: full upsert, incremental patch, and pull.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{parse_uuid, ts_from_millis};
use crate::error::AppResult;
use crate::models::session::{MessageRole, Session, SessionWithMessages, SyncMessage};

fn role_to_str(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::ToolResult => "toolResult",
    }
}

fn role_from_str(s: &str) -> MessageRole {
    match s {
        "assistant" => MessageRole::Assistant,
        "toolResult" => MessageRole::ToolResult,
        _ => MessageRole::User,
    }
}

fn map_session(row: &PgRow) -> Session {
    let created: DateTime<Utc> = row.get("created_at");
    let updated: DateTime<Utc> = row.get("updated_at");
    Session {
        id: row.get::<Uuid, _>("id").to_string(),
        user_id: row.get::<Uuid, _>("user_id").to_string(),
        title: row.get("title"),
        created_at: created.timestamp_millis(),
        updated_at: updated.timestamp_millis(),
    }
}

/// Replace a full session (session row + all its messages) for a user.
pub async fn upsert_session(
    pool: &PgPool,
    user_id: &str,
    session: &Session,
    messages: &[SyncMessage],
) -> AppResult<()> {
    let uid = parse_uuid(user_id)?;
    let sid = parse_uuid(&session.id)?;
    let created = ts_from_millis(session.created_at);
    let updated = ts_from_millis(session.updated_at);

    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO sessions (id, user_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
         SET title = EXCLUDED.title,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(sid)
    .bind(uid)
    .bind(&session.title)
    .bind(created)
    .bind(updated)
    .execute(&mut *tx)
    .await?;

    // Full replace: clear existing messages then reinsert.
    sqlx::query("DELETE FROM messages WHERE session_id = $1")
        .bind(sid)
        .execute(&mut *tx)
        .await?;

    for m in messages {
        insert_message(&mut tx, sid, m).await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Append messages to an existing session and bump its `updated_at`. When
/// `title` is `Some`, the session title is updated too; `None` (bound as SQL
/// NULL) leaves the stored title unchanged via `COALESCE`.
pub async fn patch_session(
    pool: &PgPool,
    session_id: &str,
    append: &[SyncMessage],
    updated_at: i64,
    title: Option<String>,
) -> AppResult<()> {
    let sid = parse_uuid(session_id)?;
    let updated = ts_from_millis(updated_at);

    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE sessions SET updated_at = $1, title = COALESCE($2, title) WHERE id = $3")
        .bind(updated)
        .bind(title)
        .bind(sid)
        .execute(&mut *tx)
        .await?;

    for m in append {
        insert_message(&mut tx, sid, m).await?;
    }

    tx.commit().await?;
    Ok(())
}

async fn insert_message(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session_id: Uuid,
    m: &SyncMessage,
) -> AppResult<()> {
    let mid = parse_uuid(&m.id)?;
    sqlx::query(
        "INSERT INTO messages (id, session_id, role, text, raw, ts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
         SET role = EXCLUDED.role,
             text = EXCLUDED.text,
             raw = EXCLUDED.raw,
             ts = EXCLUDED.ts",
    )
    .bind(mid)
    .bind(session_id)
    .bind(role_to_str(&m.role))
    .bind(&m.text)
    .bind(&m.raw)
    .bind(m.timestamp)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Pull all sessions (with messages) for a user changed since `since` (ms).
pub async fn pull_sessions(
    pool: &PgPool,
    user_id: &str,
    since: Option<i64>,
) -> AppResult<Vec<SessionWithMessages>> {
    let uid = parse_uuid(user_id)?;

    let session_rows = match since {
        Some(ms) => {
            let watermark = ts_from_millis(ms);
            sqlx::query(
                "SELECT id, user_id, title, created_at, updated_at
                 FROM sessions WHERE user_id = $1 AND updated_at > $2
                 ORDER BY updated_at ASC",
            )
            .bind(uid)
            .bind(watermark)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT id, user_id, title, created_at, updated_at
                 FROM sessions WHERE user_id = $1
                 ORDER BY updated_at ASC",
            )
            .bind(uid)
            .fetch_all(pool)
            .await?
        }
    };

    let mut out = Vec::with_capacity(session_rows.len());
    for row in &session_rows {
        let session = map_session(row);
        let sid = row.get::<Uuid, _>("id");
        let messages = fetch_messages(pool, sid).await?;
        out.push(SessionWithMessages { session, messages });
    }
    Ok(out)
}

/// Delete a session (its messages cascade via the FK) for a user. Scoping the
/// delete by `user_id` keeps one user from deleting another's session. Returns
/// whether a row was actually removed (false for an already-gone id).
pub async fn delete_session(pool: &PgPool, user_id: &str, session_id: &str) -> AppResult<bool> {
    let uid = parse_uuid(user_id)?;
    let sid = parse_uuid(session_id)?;
    let res = sqlx::query("DELETE FROM sessions WHERE id = $1 AND user_id = $2")
        .bind(sid)
        .bind(uid)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Fetch a single session with its messages.
pub async fn fetch_session(
    pool: &PgPool,
    session_id: &str,
) -> AppResult<Option<SessionWithMessages>> {
    let sid = parse_uuid(session_id)?;
    let row = sqlx::query(
        "SELECT id, user_id, title, created_at, updated_at FROM sessions WHERE id = $1",
    )
    .bind(sid)
    .fetch_optional(pool)
    .await?;

    let Some(r) = row else { return Ok(None) };
    let session = map_session(&r);
    let messages = fetch_messages(pool, sid).await?;
    Ok(Some(SessionWithMessages { session, messages }))
}

async fn fetch_messages(pool: &PgPool, session_id: Uuid) -> AppResult<Vec<SyncMessage>> {
    let rows = sqlx::query(
        "SELECT id, role, text, raw, ts FROM messages WHERE session_id = $1 ORDER BY ts ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| SyncMessage {
            id: r.get::<Uuid, _>("id").to_string(),
            role: role_from_str(r.get::<&str, _>("role")),
            text: r.get("text"),
            timestamp: r.get("ts"),
            raw: r.get("raw"),
        })
        .collect())
}
