//! Session + message contract for multi-device sync.
//!
//! Types live in the shared `flairy-contract` crate (the server-side source of
//! truth); `packages/shared/src/session.ts` mirrors it for TypeScript clients.

#[allow(unused_imports)]
pub use flairy_contract::{
    MessageRole, Session, SessionDeletePayload, SessionPatchPayload, SessionPullPayload,
    SessionRemoteDeletePayload, SessionRemotePayload, SessionUpsertPayload, SessionWithMessages,
    SyncMessage,
};
