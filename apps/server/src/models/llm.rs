//! LLM configuration module.
//!
//! Mirrors the LLM types in `packages/shared/src/config.ts`. The catalog is two
//! levels: a [`LlmProviderConfig`] (vendor connection + credential) owns many
//! [`LlmModelConfig`] rows. Which model is used for which scenario is decided by
//! role assignments ([`LlmRole`]); the model joined with its provider
//! ([`ActiveLlm`]) for each role ([`RoleModels`]) is what clients receive in the
//! snapshot.

use serde::{Deserialize, Serialize};

/// The HTTP API protocol the client uses to reach a provider — a pi-ai `Api`.
/// Lives on the provider connection (every model under it speaks the same
/// protocol); it drives the request format, auth scheme, and endpoint compatibility.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderApi {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
    GoogleGenerativeAi,
}

impl ProviderApi {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderApi::OpenaiCompletions => "openai-completions",
            ProviderApi::OpenaiResponses => "openai-responses",
            ProviderApi::AnthropicMessages => "anthropic-messages",
            ProviderApi::GoogleGenerativeAi => "google-generative-ai",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "openai-completions" => Some(ProviderApi::OpenaiCompletions),
            "openai-responses" => Some(ProviderApi::OpenaiResponses),
            "anthropic-messages" => Some(ProviderApi::AnthropicMessages),
            "google-generative-ai" => Some(ProviderApi::GoogleGenerativeAi),
            _ => None,
        }
    }
}

/// Reasoning / "thinking" effort the client applies to a model. Mirrors
/// `ThinkingLevel` in `packages/shared/src/config.ts` and pi-agent-core's
/// `AgentState.thinkingLevel`. Stored as TEXT (nullable) on `llm_models`; a
/// `None` means no explicit level is forced and the client/provider default wins.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            ThinkingLevel::Off => "off",
            ThinkingLevel::Minimal => "minimal",
            ThinkingLevel::Low => "low",
            ThinkingLevel::Medium => "medium",
            ThinkingLevel::High => "high",
            ThinkingLevel::Xhigh => "xhigh",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "off" => Some(ThinkingLevel::Off),
            "minimal" => Some(ThinkingLevel::Minimal),
            "low" => Some(ThinkingLevel::Low),
            "medium" => Some(ThinkingLevel::Medium),
            "high" => Some(ThinkingLevel::High),
            "xhigh" => Some(ThinkingLevel::Xhigh),
            _ => None,
        }
    }
}

/// An input modality a model accepts. Mirrors pi-ai's `Model.input` element type
/// (`"text" | "image"`) and `Modality` in `packages/shared/src/config.ts`. Stored
/// as a non-empty TEXT[] on `llm_models`; the client forwards it to pi, which
/// gates whether images are sent or stripped with an "(image omitted…)" note.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Text,
    Image,
}

impl Modality {
    pub fn as_str(self) -> &'static str {
        match self {
            Modality::Text => "text",
            Modality::Image => "image",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Modality::Text),
            "image" => Some(Modality::Image),
            _ => None,
        }
    }
}

/// Default input modalities (text-only) for rows/payloads that omit them — keeps
/// the field non-empty and matches the DB column default.
fn default_input_modalities() -> Vec<Modality> {
    vec![Modality::Text]
}

/// A scenario slot a model can be assigned to.
/// - `Main` — the primary agent loop (required for the client to run).
/// - `Tool` — an auxiliary / cheaper model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LlmRole {
    Main,
    Tool,
}

impl LlmRole {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            LlmRole::Main => "main",
            LlmRole::Tool => "tool",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "main" => Some(LlmRole::Main),
            "tool" => Some(LlmRole::Tool),
            _ => None,
        }
    }
}

/// A provider connection (catalog row). Holds the API protocol + credential
/// shared by all its models.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderConfig {
    pub id: String,
    /// Admin-facing label.
    pub name: String,
    /// The HTTP API protocol the client uses to reach this provider.
    pub api: ProviderApi,
    /// Credential used to call the provider directly.
    pub credential: String,
    /// Optional gateway / proxy base URL override, shared by all its models.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Create/update payload for a provider (no server-owned fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderInput {
    pub name: String,
    pub api: ProviderApi,
    pub credential: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Per-token price of a model (USD). Informational only — the client uses it to
/// estimate usage cost; it never gates a request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// A model entry under a provider (catalog row). Which one is used for which
/// scenario is decided by role assignments, not a flag on the model itself.
///
/// The client builds the model entirely from this config (it does not consult
/// pi-ai's built-in registry), so any custom / third-party / OpenAI-compatible
/// model works. `context_window` / `max_tokens` / `cost` are optional; when
/// `None` the client uses its own defaults (and treats cost as zero).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelConfig {
    pub id: String,
    /// The owning provider connection.
    pub provider_id: String,
    /// Admin-facing label.
    pub name: String,
    /// Provider model id, e.g. "claude-sonnet-4-20250514".
    pub model: String,
    /// Input modalities the model accepts (non-empty; defaults to `[Text]`).
    /// Forwarded to pi as `Model.input` to gate image attachments.
    #[serde(default = "default_input_modalities")]
    pub input: Vec<Modality>,
    /// Reasoning effort the client applies when running this model. `None` →
    /// no explicit level forced (client/provider default decides).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    /// Context window in tokens. `None` → client default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i32>,
    /// Max output tokens per turn. `None` → client default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    /// Per-token price. `None` → treated as zero by the client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
}

/// Create/update payload for a model (no server-owned fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelInput {
    pub provider_id: String,
    pub name: String,
    pub model: String,
    #[serde(default = "default_input_modalities")]
    pub input: Vec<Modality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
}

/// The active LLM delivered to clients: the active model joined with its provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLlm {
    pub provider: LlmProviderConfig,
    pub model: LlmModelConfig,
}

/// The active model (resolved with its provider) for each role, delivered to
/// clients in the config snapshot. A role is `None` when no model is assigned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleModels {
    pub main: Option<ActiveLlm>,
    pub tool: Option<ActiveLlm>,
}

/// A single role→model binding in the admin read model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRoleAssignment {
    pub role: LlmRole,
    pub model_id: String,
}
