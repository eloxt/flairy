//! Aggregate configuration snapshots.
//!
//! Two read models over the per-module catalogs (llm / mcp / skill):
//! - [`ConfigSnapshot`] — the CLIENT view delivered over socket.io
//!   (`config:snapshot` / `config:updated`): the per-role active LLMs plus the
//!   full mcp/skill lists and the global version.
//! - [`AdminConfigSnapshot`] — the ADMIN view returned by `GET /api/config`:
//!   the full LLM catalog (providers + models + role assignments) plus mcp/skill
//!   lists and the version.
//!
//! Mirrors `packages/shared/src/config.ts`.

use serde::{Deserialize, Serialize};

use crate::models::announcement::AnnouncementConfig;
use crate::models::llm::{
    LlmModelConfig, LlmProviderConfig, LlmRoleAssignment, LlmUserRoleAssignment, RoleModels,
};
use crate::models::mcp::{AdminMcpServer, McpServerConfig};
use crate::models::service::{AdminServiceConfig, ServiceConfig};
use crate::models::skill::{SkillListItem, SkillSummary};
use crate::models::system_prompt::SystemPromptConfig;

/// Full configuration delivered to clients via `config:snapshot`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    /// The model bound to each role (`main` required to run; `tool` may be null).
    pub llm: RoleModels,
    pub mcp_servers: Vec<McpServerConfig>,
    /// Lightweight skill summaries; clients fetch full skills via REST.
    pub skills: Vec<SkillSummary>,
    /// Role-tagged system prompts (full body; small enough to ship inline).
    pub system_prompts: Vec<SystemPromptConfig>,
    /// System announcements shown atop the client's empty chat screen (full rows).
    pub announcements: Vec<AnnouncementConfig>,
    /// External-service configs (full rows including secret, delivered like LLM credentials).
    pub services: Vec<ServiceConfig>,
    /// Monotonic global version, bumped on every change.
    pub version: i64,
}

impl ConfigSnapshot {
    /// A safe empty default used when there is no database.
    pub fn default_empty() -> Self {
        ConfigSnapshot {
            llm: RoleModels {
                main: None,
                tool: None,
            },
            mcp_servers: Vec::new(),
            skills: Vec::new(),
            system_prompts: Vec::new(),
            announcements: Vec::new(),
            services: Vec::new(),
            version: 0,
        }
    }
}

/// Incremental configuration delta via `config:updated`. We always send a full
/// refresh (all fields populated) so omitted-field merge on the client is a no-op.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdate {
    /// Always sent in full (the whole role map, no per-role delta).
    pub llm: RoleModels,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<SkillSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompts: Option<Vec<SystemPromptConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub announcements: Option<Vec<AnnouncementConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<ServiceConfig>>,
    pub version: i64,
}

impl From<&ConfigSnapshot> for ConfigUpdate {
    fn from(s: &ConfigSnapshot) -> Self {
        ConfigUpdate {
            llm: s.llm.clone(),
            mcp_servers: Some(s.mcp_servers.clone()),
            skills: Some(s.skills.clone()),
            system_prompts: Some(s.system_prompts.clone()),
            announcements: Some(s.announcements.clone()),
            services: Some(s.services.clone()),
            version: s.version,
        }
    }
}

/// The admin read model returned by `GET /api/config`. Carries the whole LLM
/// catalog split across provider connections and their models so the admin UI
/// can manage both levels.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminConfigSnapshot {
    pub llm_providers: Vec<LlmProviderConfig>,
    pub llm_models: Vec<LlmModelConfig>,
    /// Current global role→model bindings (at most one per role).
    pub llm_role_assignments: Vec<LlmRoleAssignment>,
    /// Per-user role→model overrides (at most one per user+role); a user's
    /// snapshot resolves these over the global bindings.
    pub llm_user_role_assignments: Vec<LlmUserRoleAssignment>,
    /// MCP rows carrying audience + assigned users (admin-only fields).
    pub mcp_servers: Vec<AdminMcpServer>,
    /// Admin list rows (no body/files; full skill fetched via REST). Carry
    /// audience + assigned users.
    pub skills: Vec<SkillListItem>,
    /// Role-tagged system prompts (full rows; same shape as the client view).
    pub system_prompts: Vec<SystemPromptConfig>,
    /// System announcements (full rows; same shape as the client view).
    pub announcements: Vec<AnnouncementConfig>,
    /// External-service configs carrying audience + assigned users (admin-only).
    pub services: Vec<AdminServiceConfig>,
    pub version: i64,
}
