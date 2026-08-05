//! Long-term agent memory contract for multi-device sync.
//!
//! Types live in the shared `flairy-contract` crate (single source of truth
//! for the Rust server + Rust client; `packages/shared/src/memory.ts` mirrors
//! it for TS clients). Timestamps are epoch milliseconds.

#[allow(unused_imports)]
pub use flairy_contract::{Memory, MemoryPullPayload, MemoryRemotePayload, MemoryUpsertPayload};
