//! REST API surface. One module per resource so future config modules slot in
//! as their own file + a `.merge(...)` line below.

mod auth;
mod config;
mod llm;
mod mcp;
mod skill;
mod system_prompt;

use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::Router;

use crate::auth as auth_util;
use crate::error::{AppError, AppResult};
use crate::models::auth::Claims;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .merge(auth::router())
        .merge(config::router())
        .merge(llm::router())
        .merge(mcp::router())
        .merge(skill::router())
        .merge(system_prompt::router())
        .with_state(state)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

/// Extract and validate the bearer token, returning the JWT claims.
pub(crate) fn authed_user(state: &AppState, headers: &HeaderMap) -> AppResult<Claims> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;

    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .ok_or(AppError::Unauthorized)?;

    auth_util::validate_token(token, &state.jwt_secret)
}

/// Validate the bearer token for any authenticated user (any role).
pub(crate) fn authed(state: &AppState, headers: &HeaderMap) -> AppResult<Claims> {
    authed_user(state, headers)
}

/// Like `authed_user`, but additionally requires the `admin` role (403 otherwise).
pub(crate) fn authed_admin(state: &AppState, headers: &HeaderMap) -> AppResult<Claims> {
    let claims = authed_user(state, headers)?;
    if !claims.is_admin() {
        return Err(AppError::Forbidden);
    }
    Ok(claims)
}
