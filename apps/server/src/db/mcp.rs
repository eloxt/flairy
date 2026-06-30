//! MCP server catalog CRUD. Every mutation bumps the global config version.

use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::{config::bump_version, json_err, parse_uuid};
use crate::error::{AppError, AppResult};
use crate::models::audience::{Audience, ResourceAssignment};
use crate::models::mcp::{AdminMcpServer, McpServerConfig, McpServerInput};

pub(crate) fn map_mcp(row: &PgRow) -> AppResult<McpServerConfig> {
    let transport = serde_json::from_value(row.get("transport")).map_err(json_err)?;
    Ok(McpServerConfig {
        id: row.get::<Uuid, _>("id").to_string(),
        name: row.get("name"),
        transport,
        allowed_tools: row.get("allowed_tools"),
        enabled: row.get("enabled"),
    })
}

const SELECT: &str = "SELECT id, name, transport, allowed_tools, enabled FROM mcp_servers";

/// All servers in stable display order.
pub async fn list(pool: &PgPool) -> AppResult<Vec<McpServerConfig>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY sort_order, created_at ASC"))
        .fetch_all(pool)
        .await?;
    rows.iter().map(map_mcp).collect()
}

/// Servers visible to one user: `audience='all'` plus any specifically assigned.
pub async fn list_for_user(pool: &PgPool, user_id: &str) -> AppResult<Vec<McpServerConfig>> {
    let uid = parse_uuid(user_id)?;
    let sql = format!(
        "{SELECT} WHERE audience = 'all' OR id IN \
         (SELECT resource_id FROM resource_assignments \
          WHERE resource_type = 'mcp' AND user_id = $1) \
         ORDER BY sort_order, created_at ASC"
    );
    let rows = sqlx::query(&sql).bind(uid).fetch_all(pool).await?;
    rows.iter().map(map_mcp).collect()
}

fn map_admin_mcp(row: &PgRow) -> AppResult<AdminMcpServer> {
    Ok(AdminMcpServer {
        config: map_mcp(row)?,
        audience: Audience::from_db(row.get::<String, _>("audience").as_str()),
        assigned_user_ids: row.get::<Vec<String>, _>("assigned_user_ids"),
    })
}

/// Admin read: servers with their audience + assigned user ids.
pub async fn list_admin(pool: &PgPool) -> AppResult<Vec<AdminMcpServer>> {
    let rows = sqlx::query(
        "SELECT id, name, transport, allowed_tools, enabled, audience, \
         ARRAY(SELECT ra.user_id::text FROM resource_assignments ra \
           WHERE ra.resource_type = 'mcp' AND ra.resource_id = mcp_servers.id \
           ORDER BY ra.created_at) AS assigned_user_ids \
         FROM mcp_servers ORDER BY sort_order, created_at ASC",
    )
    .fetch_all(pool)
    .await?;
    rows.iter().map(map_admin_mcp).collect()
}

/// Set the audience + assignment for one server (transactional, bumps version).
pub async fn set_assignment(
    pool: &PgPool,
    id: &str,
    assignment: &ResourceAssignment,
) -> AppResult<i64> {
    let rid = parse_uuid(id)?;
    let mut user_ids = Vec::with_capacity(assignment.user_ids.len());
    for u in &assignment.user_ids {
        user_ids.push(parse_uuid(u)?);
    }
    user_ids.sort();
    user_ids.dedup();

    let mut tx = pool.begin().await?;
    super::assignments::ensure_users_exist(&mut tx, &user_ids).await?;

    let updated = sqlx::query(
        "UPDATE mcp_servers SET audience = $2, updated_at = now() WHERE id = $1 RETURNING id",
    )
    .bind(rid)
    .bind(assignment.audience.as_str())
    .fetch_optional(&mut *tx)
    .await?;
    if updated.is_none() {
        tx.rollback().await?;
        return Err(AppError::NotFound);
    }

    let to_assign: &[Uuid] = match assignment.audience {
        Audience::Specific => &user_ids,
        Audience::All => &[],
    };
    super::assignments::replace_assignments(&mut tx, "mcp", rid, to_assign).await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(version)
}

pub async fn create(pool: &PgPool, input: &McpServerInput) -> AppResult<(McpServerConfig, i64)> {
    let id = Uuid::new_v4();
    let transport = serde_json::to_value(&input.transport).map_err(json_err)?;
    let allowed_tools = normalize_allowed_tools(&input.allowed_tools);
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, allowed_tools, enabled)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, transport, allowed_tools, enabled",
    )
    .bind(id)
    .bind(&input.name)
    .bind(&transport)
    .bind(&allowed_tools)
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
    let allowed_tools = normalize_allowed_tools(&input.allowed_tools);
    let mut tx = pool.begin().await?;

    let row = sqlx::query(
        "UPDATE mcp_servers
         SET name = $2, transport = $3, allowed_tools = $4, enabled = $5, updated_at = now()
         WHERE id = $1
         RETURNING id, name, transport, allowed_tools, enabled",
    )
    .bind(uid)
    .bind(&input.name)
    .bind(&transport)
    .bind(&allowed_tools)
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

    super::assignments::purge_assignments(&mut tx, "mcp", uid).await?;

    let version = bump_version(&mut tx).await?;
    tx.commit().await?;
    Ok(Some(version))
}

fn normalize_allowed_tools(tools: &[String]) -> Vec<String> {
    let mut out: Vec<String> = tools
        .iter()
        .map(|tool| tool.trim())
        .filter(|tool| !tool.is_empty())
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out
}
