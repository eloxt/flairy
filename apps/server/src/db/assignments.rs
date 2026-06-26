//! Shared, resource-type-agnostic helpers over `resource_assignments`.
//!
//! One unified table backs per-user assignment for every resource kind
//! (`mcp` | `skill` | `service`). These helpers are reused by each module's
//! `set_assignment` mutation and by the user-filtered client reads.

use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Replace the assignment set for `(resource_type, resource_id)`: delete the
/// existing rows then insert the new set. Pass an empty slice to clear.
pub async fn replace_assignments(
    tx: &mut Transaction<'_, Postgres>,
    resource_type: &str,
    resource_id: Uuid,
    user_ids: &[Uuid],
) -> AppResult<()> {
    sqlx::query("DELETE FROM resource_assignments WHERE resource_type = $1 AND resource_id = $2")
        .bind(resource_type)
        .bind(resource_id)
        .execute(&mut **tx)
        .await?;

    for uid in user_ids {
        sqlx::query(
            "INSERT INTO resource_assignments (resource_type, resource_id, user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING",
        )
        .bind(resource_type)
        .bind(resource_id)
        .bind(uid)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// List the user ids assigned to a resource, oldest assignment first.
/// (Assignment data ships inline in `AdminConfigSnapshot`; this stays as a
/// resource-type-agnostic helper for callers that need it standalone.)
#[allow(dead_code)]
pub async fn list_assigned_user_ids(
    pool: &PgPool,
    resource_type: &str,
    resource_id: &str,
) -> AppResult<Vec<String>> {
    let rid = super::parse_uuid(resource_id)?;
    let rows = sqlx::query(
        "SELECT user_id FROM resource_assignments
         WHERE resource_type = $1 AND resource_id = $2
         ORDER BY created_at ASC",
    )
    .bind(resource_type)
    .bind(rid)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| r.get::<Uuid, _>("user_id").to_string())
        .collect())
}

/// Delete every assignment row for a resource (used on resource delete, since
/// `resource_id` has no FK to cascade from).
pub async fn purge_assignments(
    tx: &mut Transaction<'_, Postgres>,
    resource_type: &str,
    resource_id: Uuid,
) -> AppResult<()> {
    sqlx::query("DELETE FROM resource_assignments WHERE resource_type = $1 AND resource_id = $2")
        .bind(resource_type)
        .bind(resource_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Validate that every (deduped) user id exists. Returns `BadRequest` if any is
/// unknown. The caller must deduplicate `user_ids` first so the count compares
/// cleanly against the slice length.
pub async fn ensure_users_exist(
    tx: &mut Transaction<'_, Postgres>,
    user_ids: &[Uuid],
) -> AppResult<()> {
    if user_ids.is_empty() {
        return Ok(());
    }
    let count: i64 = sqlx::query("SELECT COUNT(DISTINCT id) AS n FROM users WHERE id = ANY($1)")
        .bind(user_ids)
        .fetch_one(&mut **tx)
        .await?
        .get("n");
    if (count as usize) != user_ids.len() {
        return Err(AppError::BadRequest(
            "one or more assigned user ids do not exist".into(),
        ));
    }
    Ok(())
}
