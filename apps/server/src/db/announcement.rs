//! Announcement catalog CRUD. Every mutation bumps the global config version.
//! Modeled on `db/system_prompt.rs` (a flat catalog); the full row ships in the
//! snapshot.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, parse_uuid};
use crate::error::AppResult;
use crate::models::announcement::{AnnouncementConfig, AnnouncementInput, AnnouncementKind};

fn map_row(row: &PgRow) -> AppResult<AnnouncementConfig> {
    Ok(AnnouncementConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        kind: AnnouncementKind::from_db(row.get::<String, _>("kind").as_str()),
        title: row.get("title"),
        content: row.get("content"),
        enabled: row.get("enabled"),
    })
}

const SELECT: &str = "SELECT id, kind, title, content, enabled FROM announcements";

/// All announcements in stable display order (used by both client and admin snapshots).
pub async fn list(pool: &PgPool) -> AppResult<Vec<AnnouncementConfig>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY sort_order, created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_row).collect()
}

pub async fn create(
    pool: &PgPool,
    input: &AnnouncementInput,
) -> AppResult<(AnnouncementConfig, i64)> {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO announcements (id, kind, title, content, enabled)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, kind, title, content, enabled",
    )
    .bind(id)
    .bind(input.kind.as_str())
    .bind(&input.title)
    .bind(&input.content)
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
    input: &AnnouncementInput,
) -> AppResult<Option<(AnnouncementConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE announcements
         SET kind = $2, title = $3, content = $4, enabled = $5, updated_at = now()
         WHERE id = $1
         RETURNING id, kind, title, content, enabled",
    )
    .bind(uid)
    .bind(input.kind.as_str())
    .bind(&input.title)
    .bind(&input.content)
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

    let deleted = sqlx::query("DELETE FROM announcements WHERE id = $1 RETURNING id")
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
