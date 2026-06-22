/**
 * Auth contract (client <-> server).
 *
 * REST login issues a JWT; the same JWT is presented in the socket.io handshake.
 * Mirror on the Rust side with serde structs using `#[serde(rename_all = "camelCase")]`.
 */

/** `'user'` (default, end users) or `'admin'` (technical administrators). */
export type UserRole = 'user' | 'admin'

export interface User {
  id: string
  email: string
  displayName: string
  role: UserRole
}

export interface LoginRequest {
  email: string
  password: string
}

/** Self-service registration. Always creates a non-admin `'user'`. */
export interface RegisterRequest {
  email: string
  password: string
  displayName: string
}

export interface LoginResponse {
  /** JWT bearer token. Stored client-side only (safeStorage), never in the renderer. */
  token: string
  user: User
}

/** Carried in the socket.io handshake `auth` field; server validates before connecting. */
export interface SocketAuth {
  token: string
}
