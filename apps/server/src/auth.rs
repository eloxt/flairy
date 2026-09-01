//! JWT issuance/validation and password hashing helpers.

use bcrypt::{hash, verify, DEFAULT_COST};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::auth::Claims;

/// Token lifetime in days.
const TOKEN_TTL_DAYS: i64 = 90;
pub const REFRESH_TOKEN_TTL_DAYS: i64 = 365;

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

/// Generate a high-entropy opaque refresh token. It is never stored in plaintext server-side.
pub fn issue_refresh_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn hash_refresh_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// Hash a plaintext password with bcrypt.
pub fn hash_password(password: &str) -> AppResult<String> {
    hash(password, DEFAULT_COST).map_err(|_| AppError::PasswordHash)
}

/// Verify a plaintext password against a stored bcrypt hash.
pub fn verify_password(password: &str, hashed: &str) -> AppResult<bool> {
    verify(password, hashed).map_err(|_| AppError::PasswordHash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards a failure mode that compiles cleanly and only shows up at runtime:
    /// jsonwebtoken 11 panics on the first sign/verify unless a crypto-provider
    /// feature is selected (see the dependency comment in Cargo.toml). Without a
    /// test, dropping that feature would break login and the socket.io handshake
    /// with nothing failing at build time.
    #[test]
    fn jwt_round_trip_and_rejections() {
        let secret = "test-secret";
        let issued_at = Utc::now().timestamp();
        let tok = issue_token("user-1", "admin", secret).expect("issue");
        let claims = validate_token(&tok, secret).expect("validate");
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.role, "admin");
        let lifetime = claims.exp - issued_at;
        assert!(
            (Duration::days(90).num_seconds()..=Duration::days(90).num_seconds() + 1)
                .contains(&lifetime)
        );
        assert!(validate_token(&tok, "wrong-secret").is_err());
        assert!(validate_token("not.a.token", secret).is_err());
    }

    #[test]
    fn password_hash_round_trip() {
        let h = hash_password("s3cret").expect("hash");
        assert!(h.starts_with("$2"));
        assert!(verify_password("s3cret", &h).expect("verify"));
        assert!(!verify_password("nope", &h).expect("verify"));
    }

    #[test]
    fn refresh_tokens_are_random_and_hash_deterministically() {
        let first = issue_refresh_token();
        let second = issue_refresh_token();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        assert_eq!(hash_refresh_token(&first), hash_refresh_token(&first));
        assert_ne!(hash_refresh_token(&first), hash_refresh_token(&second));
        assert_ne!(hash_refresh_token(&first), first.as_bytes());
    }

    /// Passwords already stored in the database were hashed by an older bcrypt.
    /// This fixture was produced by bcrypt 0.15 (the version in use before the
    /// 0.19 upgrade), so a regression here means existing users cannot log in.
    #[test]
    fn verifies_hash_produced_by_older_bcrypt() {
        let legacy = "$2b$12$2McrHI4fqlHAaIWq9j8PM.gT0/CAl8CVZoarVJbz7fVjqAk6p4h96";
        assert!(verify_password("correct horse battery staple", legacy).expect("verify"));
    }
}
