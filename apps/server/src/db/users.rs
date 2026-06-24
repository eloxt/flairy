//! User accounts: lookup, registration, and admin bootstrap.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgRow;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::db::parse_uuid;
use crate::error::AppResult;
use crate::models::auth::User;
use crate::models::user::UserSummary;

/// Row -> User (public projection).
fn map_user(row: &PgRow) -> User {
    User {
        id: row.get::<Uuid, _>("id").to_string(),
        email: row.get("email"),
        display_name: row.get("display_name"),
        role: row.get("role"),
    }
}

/// Row -> UserSummary (admin projection: includes timestamps, never the hash).
fn map_summary(row: &PgRow) -> UserSummary {
    UserSummary {
        id: row.get::<Uuid, _>("id").to_string(),
        email: row.get("email"),
        display_name: row.get("display_name"),
        role: row.get("role"),
        activated: row.get("activated"),
        created_at: row.get::<DateTime<Utc>, _>("created_at"),
        updated_at: row.get::<DateTime<Utc>, _>("updated_at"),
    }
}

/// Look up a user by email. Returns the public projection, the password hash,
/// and whether the account is activated (the login gate).
pub async fn find_user_by_email(
    pool: &PgPool,
    email: &str,
) -> AppResult<Option<(User, String, bool)>> {
    let row = sqlx::query(
        "SELECT id, email, display_name, role, password_hash, activated FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        let hash: String = r.get("password_hash");
        let activated: bool = r.get("activated");
        (map_user(&r), hash, activated)
    }))
}

/// Whether a user (by id) is currently activated. `false` if the user is missing.
/// Used by the socket handshake to keep a deactivated-but-still-tokened user out.
pub async fn is_activated(pool: &PgPool, id: &str) -> AppResult<bool> {
    let uid = parse_uuid(id)?;
    let row = sqlx::query("SELECT activated FROM users WHERE id = $1")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<bool, _>("activated")).unwrap_or(false))
}

/// Insert a new self-service user with the given role. Such users start
/// **deactivated** and require an administrator to activate them before they can
/// sign in. Returns the public projection.
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
        "INSERT INTO users (id, email, display_name, password_hash, role, activated, created_at)
         VALUES ($1, $2, $3, $4, $5, false, $6)
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

/* ---------- admin user management ---------- */

/// List every user, newest first. Admin projection (no password hashes).
pub async fn list_users(pool: &PgPool) -> AppResult<Vec<UserSummary>> {
    let rows = sqlx::query(
        "SELECT id, email, display_name, role, activated, created_at, updated_at
         FROM users ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(map_summary).collect())
}

/// Fetch a single user by id. `None` if not found.
pub async fn get_user(pool: &PgPool, id: &str) -> AppResult<Option<UserSummary>> {
    let uid = parse_uuid(id)?;
    let row = sqlx::query(
        "SELECT id, email, display_name, role, activated, created_at, updated_at
         FROM users WHERE id = $1",
    )
    .bind(uid)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(map_summary))
}

/// Create a user from the admin UI; returns the admin projection (with timestamps).
pub async fn insert_user(
    pool: &PgPool,
    email: &str,
    display_name: &str,
    password_hash: &str,
    role: &str,
    activated: bool,
) -> AppResult<UserSummary> {
    let id = Uuid::new_v4();
    let now = Utc::now();
    let row = sqlx::query(
        "INSERT INTO users (id, email, display_name, password_hash, role, activated, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id, email, display_name, role, activated, created_at, updated_at",
    )
    .bind(id)
    .bind(email)
    .bind(display_name)
    .bind(password_hash)
    .bind(role)
    .bind(activated)
    .bind(now)
    .fetch_one(pool)
    .await?;
    Ok(map_summary(&row))
}

/// Patch a user. Any `None` field is left unchanged (COALESCE). Returns `None`
/// if no user with `id` exists.
pub async fn update_user(
    pool: &PgPool,
    id: &str,
    display_name: Option<&str>,
    role: Option<&str>,
    password_hash: Option<&str>,
    activated: Option<bool>,
) -> AppResult<Option<UserSummary>> {
    let uid = parse_uuid(id)?;
    let row = sqlx::query(
        "UPDATE users SET
             display_name  = COALESCE($2, display_name),
             role          = COALESCE($3, role),
             password_hash = COALESCE($4, password_hash),
             activated     = COALESCE($5, activated),
             updated_at    = now()
         WHERE id = $1
         RETURNING id, email, display_name, role, activated, created_at, updated_at",
    )
    .bind(uid)
    .bind(display_name)
    .bind(role)
    .bind(password_hash)
    .bind(activated)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(map_summary))
}

/// Delete a user. Returns `None` if no row was deleted.
pub async fn delete_user(pool: &PgPool, id: &str) -> AppResult<Option<()>> {
    let uid = parse_uuid(id)?;
    let deleted = sqlx::query("DELETE FROM users WHERE id = $1 RETURNING id")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(deleted.map(|_| ()))
}

/// Count how many users currently hold the `admin` role. Used to prevent the
/// last administrator from being deleted or demoted (which would lock everyone
/// out of the admin UI).
pub async fn count_admins(pool: &PgPool) -> AppResult<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
        .fetch_one(pool)
        .await?;
    Ok(row.get::<i64, _>("n"))
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
        "INSERT INTO users (id, email, display_name, password_hash, role, activated, created_at)
         VALUES ($1, $2, $3, $4, 'admin', true, $5)
         ON CONFLICT (email) DO UPDATE
         SET role = 'admin',
             activated = true,
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
