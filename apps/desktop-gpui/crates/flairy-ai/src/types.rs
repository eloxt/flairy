use serde::{Deserialize, Serialize};

// The unified cross-client message format is defined in flairy-contract;
// the agent kernel uses it directly so provider history == wire format.
pub use flairy_contract::{ChatBlock as ContentBlock, ChatMessage as Message, ChatRole as Role, now_ms};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Cancelled,
}

/// Tool spec as sent to the provider.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: serde_json::Value,
}

/// One completed assistant turn.
#[derive(Debug, Clone)]
pub struct AssistantTurn {
    pub blocks: Vec<ContentBlock>,
    pub stop_reason: StopReason,
    pub usage: Usage,
}

/// Streaming deltas surfaced while a turn is in flight.
pub enum LlmDelta {
    Text(String),
}
