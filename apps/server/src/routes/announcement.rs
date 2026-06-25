//! Announcement catalog routes (admin-gated).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use axum::{Json, Router};

use super::authed_admin;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::announcement::{AnnouncementConfig, AnnouncementInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/announcements", get(list).post(create))
        .route("/api/announcements/{id}", put(update).delete(delete))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<AnnouncementConfig>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::announcement::list(pool).await?))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AnnouncementInput>,
) -> AppResult<(StatusCode, Json<AnnouncementConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (announcement, _version) = db::announcement::create(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(announcement)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<AnnouncementInput>,
) -> AppResult<Json<AnnouncementConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (announcement, _version) = db::announcement::update(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(announcement))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::announcement::delete(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}
