//! User-management routes (admin-gated).
//!
//! Unlike the config catalogs (llm/mcp/skill), users are NOT part of the config
//! snapshot and are never broadcast to clients — the snapshot fans out to every
//! connected desktop, so leaking the user list there would be a privacy hole.
//! These endpoints simply read/write the `users` table for the admin UI.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};

use super::authed_admin;
use crate::auth;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::user::{is_valid_role, CreateUserRequest, UpdateUserRequest, UserSummary};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/users", get(list).post(create))
        .route("/api/users/{id}", axum::routing::put(update).delete(delete))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<UserSummary>>> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;
    Ok(Json(db::users::list_users(pool).await?))
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<UserSummary>)> {
    authed_admin(&state, &headers)?;
    let pool = state.pool()?;

    let email = req.email.trim();
    let display_name = req.display_name.trim();
    if email.is_empty() {
        return Err(AppError::BadRequest("email is required".into()));
    }
    if display_name.is_empty() {
        return Err(AppError::BadRequest("display name is required".into()));
    }
    if req.password.is_empty() {
        return Err(AppError::BadRequest("password is required".into()));
    }
    if !is_valid_role(&req.role) {
        return Err(AppError::BadRequest("role must be 'user' or 'admin'".into()));
    }
    if db::find_user_by_email(pool, email).await?.is_some() {
        return Err(AppError::BadRequest("email already registered".into()));
    }

    let hash = auth::hash_password(&req.password)?;
    let user =
        db::users::insert_user(pool, email, display_name, &hash, &req.role, req.activated).await?;
    Ok((StatusCode::CREATED, Json(user)))
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateUserRequest>,
) -> AppResult<Json<UserSummary>> {
    let claims = authed_admin(&state, &headers)?;
    let pool = state.pool()?;

    let existing = db::users::get_user(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;

    // Don't let an admin deactivate their own account and lock themselves out.
    if claims.sub == id && req.activated == Some(false) {
        return Err(AppError::BadRequest(
            "you cannot deactivate your own account".into(),
        ));
    }

    // Normalize the optional fields, rejecting blanks that would otherwise wipe data.
    let display_name = match req.display_name.as_deref().map(str::trim) {
        Some("") => return Err(AppError::BadRequest("display name cannot be empty".into())),
        other => other,
    };
    if let Some(role) = req.role.as_deref() {
        if !is_valid_role(role) {
            return Err(AppError::BadRequest("role must be 'user' or 'admin'".into()));
        }
        // Block demoting the last remaining admin — it would lock everyone out.
        if existing.role == "admin"
            && role != "admin"
            && db::users::count_admins(pool).await? <= 1
        {
            return Err(AppError::BadRequest(
                "cannot demote the last administrator".into(),
            ));
        }
    }

    let password_hash = match req.password.as_deref() {
        Some(p) if !p.is_empty() => Some(auth::hash_password(p)?),
        _ => None,
    };

    let user = db::users::update_user(
        pool,
        &id,
        display_name,
        req.role.as_deref(),
        password_hash.as_deref(),
        req.activated,
    )
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(user))
}

async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let claims = authed_admin(&state, &headers)?;
    let pool = state.pool()?;

    // Don't let an admin delete their own account out from under themselves.
    if claims.sub == id {
        return Err(AppError::BadRequest(
            "you cannot delete your own account".into(),
        ));
    }

    let existing = db::users::get_user(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    // Never delete the last administrator.
    if existing.role == "admin" && db::users::count_admins(pool).await? <= 1 {
        return Err(AppError::BadRequest(
            "cannot delete the last administrator".into(),
        ));
    }

    db::users::delete_user(pool, &id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(StatusCode::NO_CONTENT)
}
