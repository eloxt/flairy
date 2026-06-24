//! Admin user-management contract (admin UI <-> server).
//!
//! Distinct from [`crate::models::auth`], which carries the login/JWT contract.
//! These DTOs back the admin-only `/api/users` CRUD surface. Field names emit as
//! camelCase to match `packages/shared/src/auth.ts`. Password hashes never leave
//! the server: no DTO here exposes one.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A user row as shown in the admin user list / detail. Never includes the
/// password hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// `"user"` or `"admin"`.
    pub role: String,
    /// Whether the account may sign in to the client. Self-registered users start
    /// deactivated and must be activated by an administrator.
    pub activated: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Create-user payload from the admin UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
    /// `"user"` (default) or `"admin"`.
    #[serde(default = "default_role")]
    pub role: String,
    /// Admin-created users are active by default (the admin is vouching for them).
    #[serde(default = "default_true")]
    pub activated: bool,
}

/// Update-user payload. Every field is optional so the admin can patch just the
/// parts they changed (rename, change role, or reset password independently).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// When present and non-empty, resets the user's password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// Activate / deactivate the account. `None` leaves it unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activated: Option<bool>,
}

fn default_role() -> String {
    "user".to_string()
}

fn default_true() -> bool {
    true
}

/// The two valid roles. Centralized so route validation stays consistent.
pub fn is_valid_role(role: &str) -> bool {
    matches!(role, "user" | "admin")
}
