//! System-announcement configuration module.
//!
//! Mirrors `AnnouncementConfig` / `AnnouncementInput` in
//! `packages/shared/src/config.ts`. A flat list: each row is a banner shown atop
//! the client's empty chat screen. Bodies are small, so the full row ships inline
//! in the client snapshot (like `system_prompts`, no REST re-fetch).

use serde::{Deserialize, Serialize};

/// Visual tone of an announcement. Closed set mirrored by the DB `kind` CHECK and
/// `AnnouncementKind` on the TS side.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnouncementKind {
    Info,
    Success,
    Warning,
    Error,
}

impl AnnouncementKind {
    /// Map the DB text column to the enum (defaults to `Info` on anything unknown,
    /// which the CHECK constraint should already prevent).
    pub fn from_db(s: &str) -> Self {
        match s {
            "success" => AnnouncementKind::Success,
            "warning" => AnnouncementKind::Warning,
            "error" => AnnouncementKind::Error,
            _ => AnnouncementKind::Info,
        }
    }

    /// The text stored in the DB `kind` column.
    pub fn as_str(self) -> &'static str {
        match self {
            AnnouncementKind::Info => "info",
            AnnouncementKind::Success => "success",
            AnnouncementKind::Warning => "warning",
            AnnouncementKind::Error => "error",
        }
    }
}

/// A stored announcement (catalog row).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementConfig {
    pub id: String,
    /// Visual tone shown on the client banner.
    pub kind: AnnouncementKind,
    /// Headline shown in bold.
    pub title: String,
    /// Body text shown beneath the title.
    pub content: String,
    pub enabled: bool,
}

/// Create/update payload from the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementInput {
    pub kind: AnnouncementKind,
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}
