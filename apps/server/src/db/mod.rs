//! Database access. Uses SQLx RUNTIME queries (no compile-time macros) so the
//! crate builds without a live Postgres and without DATABASE_URL.
//!
//! Organized per module so new config modules slot in as their own file:
//! - [`users`], [`sessions`] — accounts and session sync.
//! - [`llm`], [`mcp`], [`skill`] — per-module config catalogs.
//! - [`config`] — aggregate snapshot loaders + the global version bump.

pub mod announcement;
pub mod config;
pub mod llm;
pub mod mcp;
pub mod memories;
pub mod sessions;
pub mod skill;
pub mod system_prompt;
pub mod users;

// Re-export the flat user/session API so existing call sites keep working.
pub use memories::{pull_memories, upsert_memories};
pub use sessions::{
    delete_session, fetch_session, patch_session, pull_sessions, upsert_session,
};
pub use users::{create_user, find_user_by_email, upsert_admin};

use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Attempt to connect to Postgres from `DATABASE_URL`. Returns `None` (with a
/// warning) if the variable is missing or the connection fails — the server
/// still starts so it can build/run without a DB.
pub async fn connect() -> Option<PgPool> {
    let url = match std::env::var("DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            tracing::warn!("DATABASE_URL not set; starting without a database (DB-backed routes will return 503)");
            return None;
        }
    };
    match PgPoolOptions::new().max_connections(5).connect(&url).await {
        Ok(pool) => {
            tracing::info!("connected to Postgres");
            Some(pool)
        }
        Err(e) => {
            tracing::warn!("failed to connect to Postgres ({e}); starting without a database");
            None
        }
    }
}

/// Run migrations from the embedded `migrations/` directory.
pub async fn migrate(pool: &PgPool) -> AppResult<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(|e| AppError::Internal(format!("migration failed: {e}")))?;
    Ok(())
}

/* ---------- shared helpers ---------- */

pub(crate) fn parse_uuid(s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|_| AppError::BadRequest(format!("invalid uuid: {s}")))
}

pub(crate) fn ts_from_millis(ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_else(Utc::now)
}

pub(crate) fn json_err(e: serde_json::Error) -> AppError {
    AppError::Internal(e.to_string())
}
