//! Auth contract (client <-> server).
//!
//! Mirrors `packages/shared/src/auth.ts`. REST login issues a JWT; the same JWT
//! is presented in the socket.io handshake. Field names emit as camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// `"user"` (default) or `"admin"`. Gates admin-only surfaces.
    pub role: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    /// JWT bearer token.
    pub token: String,
    pub user: User,
}

/// Carried in the socket.io handshake `auth` field.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketAuth {
    pub token: String,
}

/// Optional registration request (server extension, not in the TS contract).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    pub display_name: String,
}

/// JWT claims. `sub` = user id, `role` = user role, `exp` = unix expiry seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    /// `"user"` or `"admin"`. `default` so tokens issued before roles existed
    /// still decode (treated as a non-admin user).
    #[serde(default)]
    pub role: String,
    pub exp: i64,
}

impl Claims {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}
