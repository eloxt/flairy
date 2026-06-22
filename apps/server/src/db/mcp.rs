//! MCP server catalog CRUD. Every mutation bumps the global config version.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, json_err, parse_uuid};
use crate::error::AppResult;
use crate::models::mcp::{McpServerConfig, McpServerInput};

pub(crate) fn map_mcp(row: &PgRow) -> AppResult<McpServerConfig> {
    let transport = serde_json::from_value(row.get("transport")).map_err(json_err)?;
    Ok(McpServerConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        transport,
        enabled: row.get("enabled"),
    })
}

const SELECT: &str = "SELECT id, name, transport, enabled FROM mcp_servers";

/// All servers in stable display order.
pub async fn list(pool: &PgPool) -> AppResult<Vec<McpServerConfig>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY sort_order, created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_mcp).collect()
}

pub async fn create(pool: &PgPool, input: &McpServerInput) -> AppResult<(McpServerConfig, i64)> {
    let id = Uuid::new_v4();
    let transport = serde_json::to_value(&input.transport).map_err(json_err)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, enabled)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, transport, enabled",
    )
    .bind(id)
    .bind(&input.name)
    .bind(&transport)
    .bind(input.enabled)
    .fetch_one(&mut *tx)
    .await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok((map_mcp(&row)?, version))
}

pub async fn update(
    pool: &PgPool,
    id: &str,
    input: &McpServerInput,
) -> AppResult<Option<(McpServerConfig, i64)>> {
    let uid = parse_uuid(id)?;
    let transport = serde_json::to_value(&input.transport).map_err(json_err)?;
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE mcp_servers
         SET name = $2, transport = $3, enabled = $4, updated_at = now()
         WHERE id = $1
         RETURNING id, name, transport, enabled",
    )
    .bind(uid)
    .bind(&input.name)
    .bind(&transport)
    .bind(input.enabled)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some((map_mcp(&row)?, version)))
}

pub async fn delete(pool: &PgPool, id: &str) -> AppResult<Option<i64>> {
    let uid = parse_uuid(id)?;
    let mut tx = pool.begin().await?;

    let deleted = sqlx::query("DELETE FROM mcp_servers WHERE id = $1 RETURNING id")
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
