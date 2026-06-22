//! Aggregate config: the global version bump shared by every module mutation,
//! plus the snapshot loaders for the client and admin read models.

use sqlx::{PgPool, Postgres, Row, Transaction};

use crate::error::AppResult;
use crate::models::config::{AdminConfigSnapshot, ConfigSnapshot};

/// Bump the single global config version inside a transaction and return the
/// new value. Every catalog mutation calls this so clients can diff snapshots.
pub async fn bump_version(tx: &mut Transaction<'_, Postgres>) -> AppResult<i64> {
    let row = sqlx::query(
        "INSERT INTO config_meta (id, version) VALUES (true, 1)
         ON CONFLICT (id) DO UPDATE
         SET version = config_meta.version + 1, updated_at = now()
         RETURNING version",
    )
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.get::<i64, _>("version"))
}

/// Read the current global version (0 if the row is missing).
pub async fn current_version(pool: &PgPool) -> AppResult<i64> {
    let row = sqlx::query("SELECT version FROM config_meta WHERE id")
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<i64, _>("version")).unwrap_or(0))
}

/// The CLIENT read model: the per-role active LLMs + full mcp/skill lists + version.
pub async fn load_client_snapshot(pool: &PgPool) -> AppResult<ConfigSnapshot> {
    Ok(ConfigSnapshot {
        llm: super::llm::role_models(pool).await?,
        mcp_servers: super::mcp::list(pool).await?,
        skills: super::skill::list_summaries(pool).await?,
        system_prompts: super::system_prompt::list(pool).await?,
        version: current_version(pool).await?,
    })
}

/// The ADMIN read model: the full LLM catalog (providers + models + role
/// assignments) + mcp/skill lists + version.
pub async fn load_admin_snapshot(pool: &PgPool) -> AppResult<AdminConfigSnapshot> {
    Ok(AdminConfigSnapshot {
        llm_providers: super::llm::list_providers(pool).await?,
        llm_models: super::llm::list_models(pool).await?,
        llm_role_assignments: super::llm::list_role_assignments(pool).await?,
        mcp_servers: super::mcp::list(pool).await?,
        skills: super::skill::list_items(pool).await?,
        system_prompts: super::system_prompt::list(pool).await?,
        version: current_version(pool).await?,
    })
}
