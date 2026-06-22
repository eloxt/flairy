//! MCP server configuration module.
//!
//! Mirrors `McpServerConfig` / `McpServerInput` / `McpTransport` in
//! `packages/shared/src/config.ts`. The transport union is stored as JSONB and
//! discriminated by `kind`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// How the client should connect to an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpTransport {
    Stdio {
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
    },
    Sse {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<HashMap<String, String>>,
    },
    Http {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<HashMap<String, String>>,
    },
}

/// A stored MCP server (catalog row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    /// User-friendly name.
    pub name: String,
    pub transport: McpTransport,
    pub enabled: bool,
}

/// Create/update payload from the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub transport: McpTransport,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}
