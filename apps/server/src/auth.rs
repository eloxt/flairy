//! JWT issuance/validation and password hashing helpers.

use bcrypt::{hash, verify, DEFAULT_COST};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};

use crate::error::{AppError, AppResult};
use crate::models::auth::Claims;

/// Token lifetime in days.
const TOKEN_TTL_DAYS: i64 = 30;

/// Issue an HS256 JWT for the given user id and role, signed with `secret`.
pub fn issue_token(user_id: &str, role: &str, secret: &str) -> AppResult<String> {
    let exp = (Utc::now() + Duration::days(TOKEN_TTL_DAYS)).timestamp();
    let claims = Claims {
        sub: user_id.to_string(),
        role: role.to_string(),
        exp,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| AppError::Token)
}

/// Validate an HS256 JWT and return its claims.
pub fn validate_token(token: &str, secret: &str) -> AppResult<Claims> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::Unauthorized)?;
    Ok(data.claims)
}

/// Hash a plaintext password with bcrypt.
pub fn hash_password(password: &str) -> AppResult<String> {
    hash(password, DEFAULT_COST).map_err(|_| AppError::PasswordHash)
}

/// Verify a plaintext password against a stored bcrypt hash.
pub fn verify_password(password: &str, hashed: &str) -> AppResult<bool> {
    verify(password, hashed).map_err(|_| AppError::PasswordHash)
}
