//! Long-term agent memory contract for multi-device sync.
//!
//! Types live in the shared `flairy-contract` crate (the server-side source of
//! truth); `packages/shared/src/memory.ts` mirrors it for TypeScript clients.
//! Timestamps are epoch milliseconds.

#[allow(unused_imports)]
pub use flairy_contract::{Memory, MemoryPullPayload, MemoryRemotePayload, MemoryUpsertPayload};
