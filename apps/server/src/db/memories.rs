//! Memory sync: batch upsert + pull. User-scoped, soft-delete aware.

use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::parse_uuid;
use crate::error::AppResult;
use crate::models::memory::Memory;

fn map_memory(row: &sqlx::postgres::PgRow) -> Memory {
    Memory {
        id: row.get::<Uuid, _>("id").to_string(),
        kind: row.get("type"),
        text: row.get("text"),
        source: row.get("source"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        deleted_at: row.get("deleted_at"),
    }
}

/// Upsert a batch of memories for a user (keyed by id). Last-writer-wins on
/// `updated_at`: an incoming row only overwrites a stored one that isn't newer,
/// so a stale device replaying old state can't clobber a fresher edit/delete.
pub async fn upsert_memories(
    pool: &PgPool,
    user_id: &str,
    memories: &[Memory],
) -> AppResult<()> {
    let uid = parse_uuid(user_id)?;
    let mut tx = pool.begin().await?;
    for m in memories {
        let mid = parse_uuid(&m.id)?;
        sqlx::query(
            "INSERT INTO memories (id, user_id, type, text, source, created_at, updated_at, deleted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE
             SET type = EXCLUDED.type,
                 text = EXCLUDED.text,
                 source = EXCLUDED.source,
                 updated_at = EXCLUDED.updated_at,
                 deleted_at = EXCLUDED.deleted_at
             WHERE memories.updated_at <= EXCLUDED.updated_at",
        )
        .bind(mid)
        .bind(uid)
        .bind(&m.kind)
        .bind(&m.text)
        .bind(&m.source)
        .bind(m.created_at)
        .bind(m.updated_at)
        .bind(m.deleted_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Pull a user's memories changed since `since` (ms). Includes soft-deleted rows
/// so a deletion reaches a fresh/stale device.
pub async fn pull_memories(
    pool: &PgPool,
    user_id: &str,
    since: Option<i64>,
) -> AppResult<Vec<Memory>> {
    let uid = parse_uuid(user_id)?;
    let rows = match since {
        Some(ms) => {
            sqlx::query(
                "SELECT id, type, text, source, created_at, updated_at, deleted_at
                 FROM memories WHERE user_id = $1 AND updated_at > $2
                 ORDER BY updated_at ASC",
            )
            .bind(uid)
            .bind(ms)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query(
                "SELECT id, type, text, source, created_at, updated_at, deleted_at
                 FROM memories WHERE user_id = $1
                 ORDER BY updated_at ASC",
            )
            .bind(uid)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows.iter().map(map_memory).collect())
}
