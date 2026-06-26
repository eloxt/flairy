//! MCP server catalog routes (admin-gated).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};

use super::authed_admin;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::audience::ResourceAssignment;
use crate::models::mcp::{McpServerConfig, McpServerInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mcp-servers", get(list).post(create))
        .route("/api/mcp-servers/{id}", put(update).delete(delete))
        .route("/api/mcp-servers/{id}/assignment", put(set_assignment))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<McpServerConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::mcp::list(pool).await?))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<McpServerInput>,
) -> AppResult<(StatusCode, Json<McpServerConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (server, _version) = db::mcp::create(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(server)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<McpServerInput>,
) -> AppResult<Json<McpServerConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (server, _version) = db::mcp::update(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(server))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::mcp::delete(pool, &id).await?.ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_assignment(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ResourceAssignment>,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::mcp::set_assignment(pool, &id, &body).await?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}
