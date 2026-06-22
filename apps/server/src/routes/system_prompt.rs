//! System-prompt catalog routes (admin-gated).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};

use super::authed_admin;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::system_prompt::{SystemPromptConfig, SystemPromptInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/system-prompts", get(list).post(create))
        .route("/api/system-prompts/{id}", put(update).delete(delete))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<SystemPromptConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::system_prompt::list(pool).await?))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SystemPromptInput>,
) -> AppResult<(StatusCode, Json<SystemPromptConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (prompt, _version) = db::system_prompt::create(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(prompt)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<SystemPromptInput>,
) -> AppResult<Json<SystemPromptConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (prompt, _version) = db::system_prompt::update(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(prompt))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::system_prompt::delete(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}
