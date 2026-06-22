//! Aggregate config read model: `GET /api/config` returns the full admin
//! snapshot (LLM catalog + mcp/skill lists + version) powering every admin page.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};

use super::authed_admin;
use crate::db;
use crate::error::AppResult;
use crate::models::config::AdminConfigSnapshot;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/config", get(get_config))
}

async fn get_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<AdminConfigSnapshot>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let snapshot = db::config::load_admin_snapshot(pool).await?;
    Ok(Json(snapshot))
}
