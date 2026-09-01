//! Auth routes: login + self-service registration.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};

use crate::auth;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::auth::{LoginRequest, LoginResponse, RefreshTokenRequest, RegisterRequest};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<LoginResponse>> {
    let pool = state.pool()?;
    let found = db::find_user_by_email(pool, &req.email).await?;
    let (user, hash, activated) = found.ok_or(AppError::InvalidCredentials)?;

    if !auth::verify_password(&req.password, &hash)? {
        return Err(AppError::InvalidCredentials);
    }

    // Gate sign-in on activation. Checked after the password so we never reveal
    // whether an email exists to someone who doesn't hold its password.
    if !activated {
        return Err(AppError::NotActivated);
    }

    let token = auth::issue_token(&user.id, &user.role, &state.jwt_secret)?;
    let refresh_token = db::refresh_tokens::issue(pool, &user.id).await?;
    Ok(Json(LoginResponse {
        token,
        refresh_token,
        user,
    }))
}

async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(StatusCode, Json<LoginResponse>)> {
    let pool = state.pool()?;

    if db::find_user_by_email(pool, &req.email).await?.is_some() {
        return Err(AppError::BadRequest("email already registered".into()));
    }

    let hash = auth::hash_password(&req.password)?;
    // Self-service registration always creates a non-admin user; admins are
    // provisioned out-of-band via the `create-admin` CLI.
    let user = db::create_user(pool, &req.email, &req.display_name, &hash, "user").await?;
    let token = auth::issue_token(&user.id, &user.role, &state.jwt_secret)?;
    let refresh_token = db::refresh_tokens::issue(pool, &user.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(LoginResponse {
            token,
            refresh_token,
            user,
        }),
    ))
}

async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshTokenRequest>,
) -> AppResult<Json<LoginResponse>> {
    let pool = state.pool()?;
    let (refresh_token, user) = db::refresh_tokens::rotate(pool, &req.refresh_token).await?;
    let token = auth::issue_token(&user.id, &user.role, &state.jwt_secret)?;
    Ok(Json(LoginResponse {
        token,
        refresh_token,
        user,
    }))
}

async fn logout(
    State(state): State<AppState>,
    Json(req): Json<RefreshTokenRequest>,
) -> AppResult<StatusCode> {
    db::refresh_tokens::revoke(state.pool()?, &req.refresh_token).await?;
    Ok(StatusCode::NO_CONTENT)
}
