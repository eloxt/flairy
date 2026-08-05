//! Session + message contract for multi-device sync.
//!
//! Types live in the shared `flairy-contract` crate (single source of truth
//! for the Rust server + Rust client; `packages/shared/src/session.ts`
//! mirrors it for TS clients).

#[allow(unused_imports)]
pub use flairy_contract::{
    MessageRole, Session, SessionDeletePayload, SessionPatchPayload, SessionPullPayload,
    SessionRemoteDeletePayload, SessionRemotePayload, SessionUpsertPayload, SessionWithMessages,
    SyncMessage,
};
