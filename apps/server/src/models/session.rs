//! Session + message contract for multi-device sync.
//!
//! Mirrors `packages/shared/src/session.ts` and the session payloads in
//! `packages/shared/src/events.ts`. Field names emit as camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
    ToolResult,
}

/// A message as synced over the wire. `raw` carries the full pi-agent-core
/// message JSON (opaque to the server).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMessage {
    pub id: String,
    pub role: MessageRole,
    pub text: String,
    pub timestamp: i64,
    /// Full-fidelity pi-agent-core message payload (opaque to the server).
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
    /// `None` leaves the stored title unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Client -> server: pull sessions changed since a watermark (all if omitted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPullPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

/// Server -> client: another device changed a session.
#[allow(dead_code)]
pub type SessionRemotePayload = SessionWithMessages;
