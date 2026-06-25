//! External-service configuration module.
//!
//! Mirrors `ServiceConfig` / `ServiceInput` / `ServiceKind` in
//! `packages/shared/src/config.ts`. A flat list: each row is a third-party
//! service integration (first: Exa web search) whose secret and settings are
//! delivered to the desktop client in the config snapshot so the client can
//! call the service directly.

use serde::{Deserialize, Serialize};

/// Which third-party service this row configures. Closed set mirrored by the
/// DB `kind` column and `ServiceKind` on the TS side.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceKind {
    Exa,
}

impl ServiceKind {
    /// Map the DB text column to the enum (defaults to `Exa` on anything
    /// unknown — the CHECK constraint should already prevent that).
    pub fn from_db(s: &str) -> Self {
        match s {
            _ => ServiceKind::Exa,
        }
    }

    /// The text stored in the DB `kind` column.
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceKind::Exa => "exa",
        }
    }
}

/// A stored external-service entry (catalog row).
///
/// The `secret` field is delivered to clients in the config snapshot — same
/// approach as LLM credentials (plaintext at rest; see the LLM provider
/// security note). Prefer short-lived / rotatable scoped credentials over
/// long-lived master keys, and ensure the desktop main process holds them in
/// memory only (never reaches the renderer).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub id: String,
    /// Which third-party service this row configures.
    pub kind: ServiceKind,
    /// Human-readable label shown in the admin UI.
    pub name: String,
    pub enabled: bool,
    /// API key / bearer token for the service. Delivered to clients like LLM
    /// credentials — plaintext at rest; rotate regularly.
    pub secret: String,
    /// Arbitrary service-specific settings (e.g. number of results, base URL).
    pub settings: serde_json::Value,
}

/// Create/update payload from the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInput {
    pub kind: ServiceKind,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub secret: String,
    #[serde(default = "default_empty_object")]
    pub settings: serde_json::Value,
}

fn default_true() -> bool {
    true
}

fn default_empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}
