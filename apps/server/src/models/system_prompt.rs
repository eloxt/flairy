//! System-prompt configuration module.
//!
//! Mirrors `SystemPromptConfig` / `SystemPromptInput` in
//! `packages/shared/src/config.ts`. A flat list: each row is a prompt body.
//! Bodies are small, so the full row ships inline in the client snapshot (no
//! REST re-fetch like skills).

use serde::{Deserialize, Serialize};

/// A stored system prompt (catalog row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptConfig {
    pub id: String,
    /// User-friendly name shown in the admin.
    pub name: String,
    /// The prompt text delivered to clients.
    pub body: String,
    pub enabled: bool,
}

/// Create/update payload from the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptInput {
    pub name: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}
