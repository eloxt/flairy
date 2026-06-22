//! System-prompt catalog CRUD. Every mutation bumps the global config version.
//! Modeled on `db/mcp.rs` (a flat catalog); the full body ships in the snapshot.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, parse_uuid};
use crate::error::AppResult;
use crate::models::system_prompt::{SystemPromptConfig, SystemPromptInput};

fn map_row(row: &PgRow) -> AppResult<SystemPromptConfig> {
    Ok(SystemPromptConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        body: row.get("body"),
        enabled: row.get("enabled"),
    })
}

const SELECT: &str = "SELECT id, name, body, enabled FROM system_prompts";

/// All prompts in stable display order (used by both client and admin snapshots).
pub async fn list(pool: &PgPool) -> AppResult<Vec<SystemPromptConfig>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY sort_order, created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_row).collect()
}

pub async fn create(
    pool: &PgPool,
    input: &SystemPromptInput,
) -> AppResult<(SystemPromptConfig, i64)> {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO system_prompts (id, name, body, enabled)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, body, enabled",
    )
    .bind(id)
    .bind(&input.name)
    .bind(&input.body)
    .bind(input.enabled)
    .fetch_one(&mut *tx)
    .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok((map_row(&row)?, version))
}

pub async fn update(
    pool: &PgPool,
    id: &str,
    input: &SystemPromptInput,
) -> AppResult<Option<(SystemPromptConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE system_prompts
         SET name = $2, body = $3, enabled = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, name, body, enabled",
    )
    .bind(uid)
    .bind(&input.name)
    .bind(&input.body)
    .bind(input.enabled)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some((map_row(&row)?, version)))
}

pub async fn delete(pool: &PgPool, id: &str) -> AppResult<Option<i64>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let deleted = sqlx::query("DELETE FROM system_prompts WHERE id = $1 RETURNING id")
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?;

    if deleted.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}
