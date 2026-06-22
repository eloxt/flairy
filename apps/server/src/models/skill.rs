//! Skill configuration module (rich Agent-Skills model, no versioning).
//!
//! Mirrors the skill types in `packages/shared/src/config.ts`. A skill is a
//! SKILL.md (YAML frontmatter + markdown body) plus supporting files. Field
//! names emit as camelCase; `createdAt`/`updatedAt` serialize as ISO strings
//! (chrono RFC3339).

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// File source discriminator. The same set Bifrost uses.
pub const SOURCE_TYPE_URL: &str = "url";
pub const SOURCE_TYPE_TEXT: &str = "text";
pub const SOURCE_TYPE_DATAURL: &str = "dataurl";
pub const SOURCE_TYPE_UPLOAD: &str = "upload";

/// A resolved file belonging to a skill (returned on read).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub id: String,
    pub skill_id: String,
    pub path: String,
    /// One of `url` | `text` | `dataurl` | `upload`.
    pub source_type: String,
    /// Inline text, hydrated from the blob for `text` sources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Remote URL for `url` sources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Reconstructed `data:...;base64,...` for `dataurl` sources.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataurl: Option<String>,
    pub mime_type: String,
    pub file_size_bytes: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// The full skill returned by `GET /api/skills/:id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    /// Spec metadata (string -> string map).
    pub metadata: BTreeMap<String, String>,
    /// Arbitrary extra YAML frontmatter (object).
    pub extra_frontmatter: serde_json::Value,
    /// Space-separated allowed tools (frontmatter form).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<String>,
    pub skill_md_body: String,
    pub enabled: bool,
    pub file_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub files: Vec<SkillFile>,
}

/// A list row: `SkillConfig` without `skill_md_body` and `files`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListItem {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub extra_frontmatter: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<String>,
    pub enabled: bool,
    pub file_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Lightweight summary shipped to clients in the config snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub file_count: i64,
    pub updated_at: DateTime<Utc>,
}

/// A file entry in a create/update payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFileEntry {
    pub path: String,
    /// One of `url` | `text` | `dataurl` | `upload`.
    pub source_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataurl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size_bytes: Option<i64>,
}

/// Create/update payload from the admin UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    #[serde(default = "empty_object")]
    pub extra_frontmatter: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<String>,
    #[serde(default)]
    pub skill_md_body: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub files: Vec<SkillFileEntry>,
}

/// Response from `POST /api/skills/files/upload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFileResponse {
    pub upload_id: String,
    pub blob_id: String,
    pub filename: String,
    pub mime_type: String,
    pub file_size_bytes: i64,
}

fn default_true() -> bool {
    true
}

fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}
