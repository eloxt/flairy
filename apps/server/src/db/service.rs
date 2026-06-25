//! External-services catalog CRUD. Every mutation bumps the global config
//! version. Modeled on `db/announcement.rs` (a flat catalog); the full row
//! ships in the snapshot.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, parse_uuid};
use crate::error::AppResult;
use crate::models::service::{ServiceConfig, ServiceInput, ServiceKind};

fn map_row(row: &PgRow) -> AppResult<ServiceConfig> {
    Ok(ServiceConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        kind: ServiceKind::from_db(row.get::<String, _>("kind").as_str()),
        name: row.get("name"),
        enabled: row.get("enabled"),
        secret: row.get("secret"),
        settings: row.get("settings"),
    })
}

const SELECT: &str = "SELECT id, kind, name, enabled, secret, settings FROM services";

/// All services in stable display order (used by both client and admin snapshots).
pub async fn list(pool: &PgPool) -> AppResult<Vec<ServiceConfig>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY sort_order, created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_row).collect()
}

pub async fn create(pool: &PgPool, input: &ServiceInput) -> AppResult<(ServiceConfig, i64)> {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO services (id, kind, name, enabled, secret, settings)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, kind, name, enabled, secret, settings",
    )
    .bind(id)
    .bind(input.kind.as_str())
    .bind(&input.name)
    .bind(input.enabled)
    .bind(&input.secret)
    .bind(&input.settings)
    .fetch_one(&mut *tx)
    .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok((map_row(&row)?, version))
}

pub async fn update(
    pool: &PgPool,
    id: &str,
    input: &ServiceInput,
) -> AppResult<Option<(ServiceConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE services
         SET kind = $2, name = $3, enabled = $4, secret = $5, settings = $6, updated_at = now()
         WHERE id = $1
         RETURNING id, kind, name, enabled, secret, settings",
    )
    .bind(uid)
    .bind(input.kind.as_str())
    .bind(&input.name)
    .bind(input.enabled)
    .bind(&input.secret)
    .bind(&input.settings)
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

    let deleted = sqlx::query("DELETE FROM services WHERE id = $1 RETURNING id")
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
