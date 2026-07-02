//! LLM catalog routes (admin-gated), two levels: provider connections and the
//! models under them. Every mutation broadcasts the new client config snapshot
//! to all connected devices.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use super::authed_admin;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::llm::{
    LlmModelConfig, LlmModelInput, LlmProviderConfig, LlmProviderInput, LlmRole,
};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/llm-providers", get(list_providers).post(create_provider))
        .route(
            "/api/llm-providers/{id}",
            axum::routing::put(update_provider).delete(delete_provider),
        )
        .route("/api/llm-models", get(list_models).post(create_model))
        .route(
            "/api/llm-models/{id}",
            axum::routing::put(update_model).delete(delete_model),
        )
        .route(
            "/api/llm-roles/{role}",
            axum::routing::put(assign_role).delete(clear_role),
        )
        .route(
            "/api/llm-roles/{role}/users/{user_id}",
            axum::routing::put(assign_user_role).delete(clear_user_role),
        )
}

// --- Providers -------------------------------------------------------------

async fn list_providers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<LlmProviderConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::llm::list_providers(pool).await?))
}

async fn create_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LlmProviderInput>,
) -> AppResult<(StatusCode, Json<LlmProviderConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (provider, _version) = db::llm::create_provider(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(provider)))
}

async fn update_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<LlmProviderInput>,
) -> AppResult<Json<LlmProviderConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (provider, _version) = db::llm::update_provider(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(provider))
}

async fn delete_provider(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::llm::delete_provider(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Models ----------------------------------------------------------------

async fn list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<LlmModelConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::llm::list_models(pool).await?))
}

async fn create_model(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LlmModelInput>,
) -> AppResult<(StatusCode, Json<LlmModelConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (model, _version) = db::llm::create_model(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(model)))
}

async fn update_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<LlmModelInput>,
) -> AppResult<Json<LlmModelConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (model, _version) = db::llm::update_model(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(model))
}

async fn delete_model(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::llm::delete_model(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Role assignments ------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleAssignInput {
    model_id: String,
}

async fn assign_role(
    State(state): State<AppState>,
    Path(role): Path<String>,
    headers: HeaderMap,
    Json(body): Json<RoleAssignInput>,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    LlmRole::from_str(&role).ok_or(AppError::NotFound)?;
    let pool = state.pool()?;
    db::llm::assign_role(pool, &role, &body.model_id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_role(
    State(state): State<AppState>,
    Path(role): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let parsed = LlmRole::from_str(&role).ok_or(AppError::NotFound)?;
    if parsed == LlmRole::Main {
        return Err(AppError::BadRequest(
            "the main role cannot be cleared".to_string(),
        ));
    }
    let pool = state.pool()?;
    db::llm::clear_role(pool, &role).await?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

// --- Per-user role overrides -------------------------------------------------

async fn assign_user_role(
    State(state): State<AppState>,
    Path((role, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<RoleAssignInput>,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    LlmRole::from_str(&role).ok_or(AppError::NotFound)?;
    let pool = state.pool()?;
    db::llm::assign_user_role(pool, &role, &user_id, &body.model_id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_user_role(
    State(state): State<AppState>,
    Path((role, user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    LlmRole::from_str(&role).ok_or(AppError::NotFound)?;
    let pool = state.pool()?;
    db::llm::clear_user_role(pool, &role, &user_id).await?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}
