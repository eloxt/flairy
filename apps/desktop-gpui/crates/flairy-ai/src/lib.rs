//! flairy-ai — Rust port of pi-ai's abstraction: a unified multi-provider LLM
//! layer. `Model` describes where/how to call; the `Api` trait is the protocol
//! implementation (raw HTTP or a vendor SDK underneath); `ApiRegistry`
//! dispatches by `model.api` (custom OpenAI-compatible endpoints register
//! their own or reuse the builtin); `stream_simple` is the single entrypoint,
//! with credentials injected via `get_api_key` (never baked into the Model).

pub mod apis;
mod model;
mod registry;
pub mod types;

pub use model::{API_ANTHROPIC, API_OPENAI, Model};
pub use registry::{Api, ApiRegistry, StreamOptions, stream_simple};
pub use types::{
    AssistantTurn, ContentBlock, LlmDelta, Message, Role, StopReason, ToolSpec, Usage, now_ms,
};
