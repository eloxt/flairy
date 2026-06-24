/**
 * @flairy/shared — the client <-> server contract.
 *
 * Single source of truth for the TS side (apps/desktop + apps/admin). The Rust
 * server mirrors these with serde structs using `#[serde(rename_all = "camelCase")]`
 * so JSON field names match exactly. REST DTOs are additionally generated from the
 * server's OpenAPI; the socket.io events and config/session models live here and
 * MUST be kept in sync with the Rust structs — change one, change the other.
 */

export * from './auth.js'
export * from './config.js'
export * from './session.js'
export * from './memory.js'
export * from './events.js'
