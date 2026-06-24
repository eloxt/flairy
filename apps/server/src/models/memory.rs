//! Long-term agent memory contract for multi-device sync.
//!
//! Mirrors `packages/shared/src/memory.ts` and the memory payloads in
//! `packages/shared/src/events.ts`. Field names emit as camelCase. Timestamps
//! are epoch milliseconds.

use serde::{Deserialize, Serialize};

/// A user-scoped memory (preference/fact the assistant learned). Deletes are
/// soft: `deleted_at` is set rather than the row removed, so the deletion syncs
/// to a user's other devices like any other change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

/// Client -> server: persist/replace a batch of memories (keyed by id).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUpsertPayload {
    pub memories: Vec<Memory>,
}

/// Client -> server: pull memories changed since a watermark (all if omitted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPullPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

/// Server -> client: memories changed on the user's other devices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRemotePayload {
    pub memories: Vec<Memory>,
}
