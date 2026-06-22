//! User accounts: lookup, registration, and admin bootstrap.

use chrono::Utc;
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::error::AppResult;
use crate::models::auth::User;

/// Row -> User (public projection).
fn map_user(row: &PgRow) -> User {
    User {
        id: row.get::<Uuid, _>("id").to_string(),
        email: row.get("email"),
        display_name: row.get("display_name"),
        role: row.get("role"),
    }
}

/// Look up a user by email, returning the public projection plus password hash.
pub async fn find_user_by_email(
    pool: &PgPool,
    email: &str,
) -> AppResult<Option<(User, String)>> {
    let row = sqlx::query(
        "SELECT id, email, display_name, role, password_hash FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        let hash: String = r.get("password_hash");
        (map_user(&r), hash)
    }))
}

/// Insert a new user with the given role; returns the public projection.
pub async fn create_user(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
    role: &str,
) -> AppResult<User> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    let row = sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, display_name, role",
    )
    .bind(id)
    .bind(email)
    .bind(display_name)
    .bind(password_hash)
    .bind(role)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(map_user(&row))
}

/// Create an admin user, or promote/reset an existing one by email. Idempotent —
/// used by the `create-admin` CLI to bootstrap the first administrator.
pub async fn upsert_admin(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
) -> AppResult<User> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    let row = sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4, 'admin', $5)
         ON CONFLICT (email) DO UPDATE
         SET role = 'admin',
             password_hash = EXCLUDED.password_hash,
             display_name = EXCLUDED.display_name
         RETURNING id, email, display_name, role",
    )
    .bind(id)
    .bind(email)
    .bind(display_name)
    .bind(password_hash)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(map_user(&row))
}
