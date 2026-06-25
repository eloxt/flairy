//! External-services catalog routes (admin-gated).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};

use super::authed_admin;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::service::{ServiceConfig, ServiceInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/services", get(list).post(create))
        .route("/api/services/{id}", put(update).delete(delete))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<ServiceConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::service::list(pool).await?))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ServiceInput>,
) -> AppResult<(StatusCode, Json<ServiceConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (service, _version) = db::service::create(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(service)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ServiceInput>,
) -> AppResult<Json<ServiceConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (service, _version) = db::service::update(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(service))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::service::delete(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}
