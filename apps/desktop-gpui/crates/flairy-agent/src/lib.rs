//! flairy-agent — Rust port of the pi-agent-core essentials on top of the
//! flairy-ai abstraction: agent loop, local tools, approval gate.

mod agent;
pub mod tool;

pub use agent::{Agent, AgentEvent};
pub use flairy_ai::{ApiRegistry, ContentBlock, Message, Model, Role, StopReason, Usage};
pub use tool::{ApprovalDecision, ApprovalGate, AutoApprove, Tool, ToolOutput};
