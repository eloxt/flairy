//! Skill repository routes.
//!
//! Admin-gated CRUD + upload, plus a client-facing raw-file read for any
//! authenticated user.

use axum::body::Bytes;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::{authed, authed_admin};
use crate::db;
use crate::db::skill::{SkillListParams, MAX_SKILL_FILE_SIZE};
use crate::error::{AppError, AppResult};
use crate::models::skill::{SkillConfig, SkillInput};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        // File routes are registered before `/api/skills/{id}` so the static
        // `files` segment is matched ahead of the `:id` capture.
        .route("/api/skills/files/upload", post(upload_file))
        .route("/api/skills/{id}/files/{*path}", get(read_file))
        .route("/api/skills", get(list).post(create))
        .route(
            "/api/skills/{id}",
            get(get_skill).put(update).delete(delete),
        )
}

/* ---------- list ---------- */

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    search: Option<String>,
    sort_by: Option<String>,
    order: Option<String>,
}

fn normalize_sort_by(raw: Option<&str>) -> String {
    match raw {
        Some("name") => "name".to_string(),
        Some("updated_at") => "updated_at".to_string(),
        _ => "created_at".to_string(),
    }
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<serde_json::Value>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;

    let limit = q.limit.filter(|&l| l > 0).unwrap_or(50).min(100);
    let offset = q.offset.filter(|&o| o >= 0).unwrap_or(0);
    let order = match q.order.as_deref() {
        Some(o) if o.eq_ignore_ascii_case("asc") => "asc".to_string(),
        _ => "desc".to_string(),
    };
    let params = SkillListParams {
        limit,
        offset,
        search: q.search,
        sort_by: normalize_sort_by(q.sort_by.as_deref()),
        order,
    };

    let (skills, total) = db::skill::list(pool, &params).await?;
    Ok(Json(json!({
        "skills": skills,
        "total": total,
        "limit": limit,
        "offset": offset,
    })))
}

/* ---------- get ---------- */

async fn get_skill(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<Json<SkillConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let skill = db::skill::get(pool, &id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(skill))
}

/* ---------- create ---------- */

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SkillInput>,
) -> AppResult<(StatusCode, Json<SkillConfig>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (skill, _version) = db::skill::create(pool, &input).await?;
    state.broadcast_config().await;
    Ok((StatusCode::CREATED, Json(skill)))
}

/* ---------- update ---------- */

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<SkillInput>,
) -> AppResult<Json<SkillConfig>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    let (skill, _version) = db::skill::update(pool, &id, &input)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(Json(skill))
}

/* ---------- delete ---------- */

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    db::skill::delete(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    state.broadcast_config().await;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- upload ---------- */

async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<crate::models::skill::UploadFileResponse>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;

    let mut filename = String::new();
    let mut mime_type = "application/octet-stream".to_string();
    let mut bytes: Option<Bytes> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("invalid multipart form: {e}")))?
    {
        if field.name() == Some("file") {
            if let Some(fname) = field.file_name() {
                filename = fname.to_string();
            }
            if let Some(ct) = field.content_type() {
                mime_type = ct.to_string();
            }
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::BadRequest(format!("failed to read upload: {e}")))?;
            if data.len() > MAX_SKILL_FILE_SIZE {
                return Err(AppError::BadRequest("file exceeds 50 MB limit".into()));
            }
            bytes = Some(data);
        }
    }

    let bytes = bytes.ok_or_else(|| AppError::BadRequest("file field is required".into()))?;
    if filename.is_empty() {
        filename = "upload".to_string();
    }

    let resp = db::skill::upload_file(pool, &bytes, &filename, &mime_type).await?;
    Ok(Json(resp))
}

/* ---------- raw file read (any authenticated user) ---------- */

async fn read_file(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    authed(&state, &headers)?;
    let pool = state.pool()?;

    let (bytes, mime_type) = db::skill::read_file(pool, &id, &path)
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(([(header::CONTENT_TYPE, mime_type)], bytes).into_response())
}
