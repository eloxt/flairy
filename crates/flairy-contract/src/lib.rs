//! Single source of truth for cross-process contracts: socket.io event names,
//! session-sync payloads, and the unified chat message format. Server and
//! Rust client both depend on this crate; `packages/shared/src/*.ts` mirrors
//! it for the TS clients — change one side, sync the other.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// socket.io event names (mirrors packages/shared/src/events.ts)
// ---------------------------------------------------------------------------
pub mod events {
    pub const CONFIG_SNAPSHOT: &str = "config:snapshot";
    /// Broadcast to all clients after an admin mutates any config catalog.
    pub const CONFIG_UPDATED: &str = "config:updated";
    pub const SESSION_UPSERT: &str = "session:upsert";
    pub const SESSION_PATCH: &str = "session:patch";
    pub const SESSION_DELETE: &str = "session:delete";
    pub const SESSION_PULL: &str = "session:pull";
    pub const SESSION_REMOTE: &str = "session:remote";
    pub const SESSION_REMOTE_DELETE: &str = "session:remote-delete";
    pub const MEMORY_UPSERT: &str = "memory:upsert";
    pub const MEMORY_PULL: &str = "memory:pull";
    pub const MEMORY_REMOTE: &str = "memory:remote";
}

// ---------------------------------------------------------------------------
// Unified chat message format — the canonical shape of `SyncMessage.raw`.
// Every client (Rust/GPUI, Electron) reads and writes this; provider-specific
// formats never cross the wire.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: Vec<ChatBlock>,
    /// Epoch millis.
    pub timestamp: u64,
}

impl ChatMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: vec![ChatBlock::Text { text: text.into() }],
            timestamp: now_ms(),
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Session sync payloads (mirrors packages/shared/src/session.ts + events.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
    ToolResult,
}

/// A message as synced over the wire. `raw` carries the full [`ChatMessage`]
/// (the unified format above; opaque to the server).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub timestamp: i64,
    pub raw: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWithMessages {
    pub session: Session,
    pub messages: Vec<SyncMessage>,
}

/// Client -> server: persist/replace a full session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpsertPayload {
    pub session: Session,
    pub messages: Vec<SyncMessage>,
}

/// Client -> server: append messages to an existing session mid-conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatchPayload {
    pub session_id: String,
    pub append_messages: Vec<SyncMessage>,
    pub updated_at: i64,
    /// When set, also update the session title (client-side title generation).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Client -> server: delete a session (and its messages) everywhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletePayload {
    pub session_id: String,
}

/// Server -> client: another device deleted a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemoteDeletePayload {
    pub session_id: String,
}

/// Client -> server: pull sessions changed since a watermark (all if omitted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPullPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

/// Server -> client: another device changed a session.
pub type SessionRemotePayload = SessionWithMessages;
