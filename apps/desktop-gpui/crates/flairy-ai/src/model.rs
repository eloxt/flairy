/// Mirrors pi-ai's Model: `api` selects the protocol implementation from the
/// registry; `provider` is the credential lookup key passed to `get_api_key`
/// (deliberately decoupled from `api`, matching pi's buildModel behavior so
/// server-configured OpenAI-compatible endpoints dispatch correctly).
#[derive(Debug, Clone)]
pub struct Model {
    pub api: String,
    pub provider: String,
    /// Model id sent on the wire, e.g. "claude-sonnet-4-5".
    pub id: String,
    /// e.g. "https://api.anthropic.com" or "https://xxx/v1".
    pub base_url: String,
    pub max_tokens: u32,
}

pub const API_ANTHROPIC: &str = "anthropic-messages";
pub const API_OPENAI: &str = "openai-completions";
