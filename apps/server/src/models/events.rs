//! socket.io event name constants.
//!
//! Mirrors `SocketEvent` in `packages/shared/src/events.ts`. Never hardcode
//! these strings elsewhere — reference these constants.

pub const CONFIG_SNAPSHOT: &str = "config:snapshot";
/// Broadcast to all clients after an admin mutates any config catalog.
pub const CONFIG_UPDATED: &str = "config:updated";
pub const SESSION_UPSERT: &str = "session:upsert";
pub const SESSION_PATCH: &str = "session:patch";
pub const SESSION_PULL: &str = "session:pull";
pub const SESSION_REMOTE: &str = "session:remote";
