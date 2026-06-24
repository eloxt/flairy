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

/**
 * A user row in the admin user-management surface. Mirrors the Rust
 * `models::user::UserSummary`. Never carries a password hash. Timestamps are
 * ISO-8601 strings (serde `DateTime<Utc>`).
 */
export interface UserSummary {
  id: string
  email: string
  displayName: string
  role: UserRole
  /**
   * Whether the account may sign in to the client. Self-registered users start
   * deactivated (`false`) and must be activated by an administrator.
   */
  activated: boolean
  createdAt: string
  updatedAt: string
}

/** Admin create-user payload. Mirrors Rust `CreateUserRequest`. */
export interface CreateUserRequest {
  email: string
  password: string
  displayName: string
  role: UserRole
  /** Admin-created users are active by default. */
  activated: boolean
}

/**
 * Admin update-user payload (partial). Mirrors Rust `UpdateUserRequest`: every
 * field is optional; omit one to leave it unchanged. A non-empty `password`
 * resets the user's password.
 */
export interface UpdateUserRequest {
  displayName?: string
  role?: UserRole
  password?: string
  /** Activate / deactivate the account. Omit to leave unchanged. */
  activated?: boolean
}
