//! Opaque refresh-token persistence and one-time rotation.

use chrono::{Duration, Utc};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::auth;
use crate::db::parse_uuid;
use crate::error::{AppError, AppResult};
use crate::models::auth::User;

pub async fn issue(pool: &PgPool, user_id: &str) -> AppResult<String> {
    let token = auth::issue_refresh_token();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(parse_uuid(user_id)?)
    .bind(auth::hash_refresh_token(&token))
    .bind(Utc::now() + Duration::days(auth::REFRESH_TOKEN_TTL_DAYS))
    .execute(pool)
    .await?;
    Ok(token)
}

/// Atomically consume the old token and issue a replacement for the same device.
pub async fn rotate(pool: &PgPool, token: &str) -> AppResult<(String, User)> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT rt.id, u.id AS user_id, u.email, u.display_name, u.role, u.activated
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1 AND rt.expires_at > now()
         FOR UPDATE OF rt",
    )
    .bind(auth::hash_refresh_token(token))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::Unauthorized)?;

    if !row.get::<bool, _>("activated") {
        return Err(AppError::Unauthorized);
    }

    let old_id: Uuid = row.get("id");
    let user_id: Uuid = row.get("user_id");
    let user = User {
        id: user_id.to_string(),
        email: row.get("email"),
        display_name: row.get("display_name"),
        role: row.get("role"),
    };
    let replacement = auth::issue_refresh_token();

    sqlx::query("DELETE FROM refresh_tokens WHERE id = $1")
        .bind(old_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(auth::hash_refresh_token(&replacement))
    .bind(Utc::now() + Duration::days(auth::REFRESH_TOKEN_TTL_DAYS))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok((replacement, user))
}

pub async fn revoke(pool: &PgPool, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM refresh_tokens WHERE token_hash = $1")
        .bind(auth::hash_refresh_token(token))
        .execute(pool)
        .await?;
    Ok(())
}
