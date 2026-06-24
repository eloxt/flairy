/**
 * Shared IPC contract between main and renderer.
 * Channel names + payload types live here so both sides stay in sync.
 *
 * Two traffic patterns:
 *   - Commands  : renderer -> main, request/response via ipcRenderer.invoke
 *   - Event flow: main -> renderer, fire-and-forget via webContents.send
 */

import type {
  McpServerConfig,
  RoleModels,
  SkillSummary,
  SystemPromptConfig
} from '@flairy/shared'

/** Channel name constants — never hardcode strings elsewhere. */
export const IPC = {
  // commands (invoke)
  AgentPrompt: 'agent:prompt',
  AgentSteer: 'agent:steer',
  AgentAbort: 'agent:abort',
  AgentApprovalResponse: 'agent:approval-response',
  AgentQuestionResponse: 'agent:question-response',
  AgentSetPermissionMode: 'agent:set-permission-mode',
  SessionList: 'session:list',
  SessionLoad: 'session:load',
  SearchMessages: 'search:messages',
  SessionCreate: 'session:create',
  SessionSetCwd: 'session:set-cwd',
  SessionListRecentDirs: 'session:list-recent-dirs',
  SessionChooseDir: 'session:choose-dir',
  SessionRename: 'session:rename',
  SessionDelete: 'session:delete',
  SessionContextMenu: 'session:context-menu',
  DialogPickDirectory: 'dialog:pick-directory',
  SecretsSet: 'secrets:set',
  SecretsHas: 'secrets:has',
  AuthLogin: 'auth:login',
  AuthRegister: 'auth:register',
  AuthLogout: 'auth:logout',
  AuthStatus: 'auth:status',
  ConfigGet: 'config:get',
  WindowOpenSettings: 'window:open-settings',
  AppGetVersion: 'app:get-version',
  SettingsGetLanguage: 'settings:get-language',
  SettingsSetLanguage: 'settings:set-language',
  // event streams (send)
  AgentEvent: 'agent:event',
  ApprovalRequest: 'agent:approval-request',
  QuestionRequest: 'agent:question-request',
  ConfigChanged: 'config:changed',
  AuthChanged: 'auth:changed',
  SessionTitleUpdated: 'session:title-updated',
  SessionsChanged: 'session:changed',
  LanguageChanged: 'settings:language-changed'
} as const

/** UI language. The single source of truth for both renderer and main catalogs. */
export type AppLanguage = 'en' | 'zh-CN'

/** A single attachment for multimodal prompts. */
export interface Attachment {
  type: 'image'
  data: string // base64
  mimeType: string
}

/* ---------- command payloads ---------- */

export interface PromptArgs {
  sessionId: string
  text: string
  attachments?: Attachment[]
}

export interface SteerArgs {
  sessionId: string
  text: string
}

export interface AbortArgs {
  sessionId: string
}

/**
 * How long an approval is remembered.
 *   - `once`    : applies to this single tool call; the next call re-prompts.
 *   - `session` : "Allow for this session" — the tool runs without prompting for
 *                 the rest of the session (held in memory only, never persisted).
 * Irrelevant when `approved` is false.
 */
export type ApprovalScope = 'once' | 'session'

export interface ApprovalResponseArgs {
  approvalId: string
  approved: boolean
  scope: ApprovalScope
}

/**
 * Tool-approval posture for a session.
 *   - `ask`  : current behavior — mutating/MCP tools prompt for confirmation.
 *   - `full` : "Full access" — every tool runs without prompting.
 * Per-session and in-memory only; resets to `ask` on restart.
 */
export type PermissionMode = 'ask' | 'full'

export interface SetPermissionModeArgs {
  sessionId: string
  mode: PermissionMode
}

export interface SetCwdArgs {
  sessionId: string
}

export interface ChooseDirArgs {
  /** null on the home screen (no session yet). */
  sessionId: string | null
  path: string
}

export interface CreateSessionArgs {
  title?: string
  cwd: string
}

export interface RenameSessionArgs {
  sessionId: string
  title: string
}

export interface DeleteSessionArgs {
  sessionId: string
}

/** Item the user picked from a session row's native right-click menu. */
export type SessionMenuAction = 'rename' | 'delete'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
}

export interface SearchMessagesArgs {
  query: string
  limit?: number
}

/**
 * One full-text search hit. `msgIndex` is the position in the session's persisted
 * messages[] array (the jump target), or -1 for a session-title match. `snippet`
 * wraps matched spans in control chars ( … ) for the renderer to highlight.
 */
export interface SearchHit {
  sessionId: string
  sessionTitle: string
  msgIndex: number
  role: 'user' | 'assistant' | 'title'
  snippet: string
  updatedAt: number
}

export interface SetSecretArgs {
  provider: 'anthropic' | 'openai' | 'google'
  apiKey: string
}

export interface LoginArgs {
  email: string
  password: string
}

export interface RegisterArgs {
  email: string
  password: string
  displayName: string
}

/**
 * Result of a login command. The JWT stays in the main process (safeStorage);
 * only the public user profile + an authenticated flag cross the bridge.
 */
export interface AuthUser {
  id: string
  email: string
  displayName: string
}

export interface AuthStatus {
  authenticated: boolean
  user?: AuthUser
}

/**
 * The server-pushed configuration as the RENDERER is allowed to see it.
 *
 * Structurally identical to `ConfigSnapshot` from `@flairy/shared`, but every
 * secret has been masked in the main process before it crosses the bridge:
 *   - `llm.provider.credential` — the LLM API key/token
 *   - any `header` / `env` values inside an MCP server's `transport`
 *
 * Credentials must NEVER reach the renderer in plaintext (see CLAUDE.md), so the
 * renderer only ever receives this redacted shape. Used for the debug/settings
 * view; it carries enough to inspect what the server delivered without leaking
 * anything sensitive.
 */
export interface RedactedConfigSnapshot {
  /** Per-role models (`main`/`tool`), each with `provider.credential` masked or null. */
  llm: RoleModels
  /** MCP servers with secret transport values (headers/env) masked. */
  mcpServers: McpServerConfig[]
  /** Skill summaries carry no secrets and are passed through unchanged. */
  skills: SkillSummary[]
  /** System prompts carry no secrets and are passed through unchanged. */
  systemPrompts: SystemPromptConfig[]
  /** Monotonic global config version. */
  version: number
}

/* ---------- event stream payloads ---------- */

/**
 * Wrapper around a pi-agent-core subscribe() event, tagged with the
 * session it belongs to so the renderer can route to the right chat.
 * `event` is left as `unknown` here; the renderer narrows on event.type.
 */
export interface AgentEventEnvelope {
  sessionId: string
  event: AgentStreamEvent
}

/** Minimal subset of pi-agent-core events the UI cares about. */
export type AgentStreamEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; messageId: string }
  | { type: 'message_update'; messageId: string; delta: string; thinkingDelta?: string }
  | { type: 'message_end'; messageId: string; role: string; text: string; thinking?: string }
  | { type: 'tool_execution_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; partial: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'error'; message: string }

export interface ApprovalRequestPayload {
  approvalId: string
  sessionId: string
  toolName: string
  args: unknown
  reason: string
}

/** One question in an `ask` tool call. */
export interface AskQuestion {
  /** Stable id within the call, used to key the answer back. */
  id: string
  /** Plain-language question text shown to the user. */
  question: string
  /** Short chip/label (optional), mirrors AskUserQuestion's `header`. */
  header?: string
  /** Selectable options. */
  options: { label: string; description?: string }[]
  /** Allow ticking more than one option. */
  multiSelect?: boolean
}

export interface QuestionRequestPayload {
  /** Round-trip id for the whole call. */
  questionId: string
  sessionId: string
  questions: AskQuestion[]
  /** Notification body, e.g. "Flairy needs your input". */
  reason: string
}

/** Per-question answer: chosen option labels and/or the free-text "other". */
export interface QuestionAnswer {
  id: string
  /** Option labels the user ticked. */
  selected: string[]
  /** Free-text "other", if provided. */
  custom?: string
}

export interface QuestionResponseArgs {
  questionId: string
  /** null when cancelled (session abort/close). */
  answers: QuestionAnswer[] | null
}

/** main -> renderer: a session's title changed (auto-generated or synced). */
export interface SessionTitleUpdatedPayload {
  sessionId: string
  title: string
}

/** The surface exposed to the renderer via contextBridge as `window.api`. */
export interface FlairyApi {
  prompt(args: PromptArgs): Promise<void>
  steer(args: SteerArgs): Promise<void>
  abort(args: AbortArgs): Promise<void>
  respondApproval(args: ApprovalResponseArgs): Promise<void>
  /** Submit the user's answers to an `ask` tool call (null when cancelled). */
  respondQuestion(args: QuestionResponseArgs): Promise<void>
  /** Set the tool-approval posture for a session (in-memory, per-session). */
  setPermissionMode(args: SetPermissionModeArgs): Promise<void>
  listSessions(): Promise<SessionMeta[]>
  loadSession(sessionId: string): Promise<{ meta: SessionMeta; messages: unknown[] }>
  /** Full-text search over message content + session titles. */
  searchMessages(args: SearchMessagesArgs): Promise<SearchHit[]>
  createSession(args: CreateSessionArgs): Promise<SessionMeta>
  /**
   * Open a native directory picker and set it as the session's working
   * directory (persisted). Returns the updated meta, or null if cancelled.
   */
  setWorkingDirectory(args: SetCwdArgs): Promise<SessionMeta | null>
  /** Previously-used working directories, newest first (max 10). */
  listRecentDirectories(): Promise<string[]>
  /**
   * Set an already-known path as the working directory (recents click — no
   * native dialog). Bumps recents. Returns the updated meta when `sessionId` is
   * given, else null (home screen: the caller sets pendingCwd from the path).
   */
  chooseDirectory(args: ChooseDirArgs): Promise<SessionMeta | null>
  /** Rename a session. Returns the updated meta, or null if it no longer exists. */
  renameSession(args: RenameSessionArgs): Promise<SessionMeta | null>
  /** Delete a session and its messages locally. Returns true if a row was removed. */
  deleteSession(args: DeleteSessionArgs): Promise<boolean>
  /**
   * Pop up the native (OS) right-click menu for a session row. Resolves with the
   * chosen action, or null if the menu was dismissed without a selection. The
   * renderer carries out the action so the store stays the source of truth.
   */
  showSessionMenu(): Promise<SessionMenuAction | null>
  /**
   * Open a native directory picker WITHOUT a session (home screen). Returns the
   * chosen path, or null if cancelled. The caller stashes it for the session
   * that gets lazily created on the first message.
   */
  pickDirectory(): Promise<string | null>
  setSecret(args: SetSecretArgs): Promise<void>
  hasSecret(provider: SetSecretArgs['provider']): Promise<boolean>
  login(args: LoginArgs): Promise<AuthStatus>
  register(args: RegisterArgs): Promise<AuthStatus>
  logout(): Promise<void>
  authStatus(): Promise<AuthStatus>
  /** Latest server-pushed config (secrets masked), or null before first snapshot. */
  getConfig(): Promise<RedactedConfigSnapshot | null>
  /** Open (or focus) the standalone Settings window. */
  openSettings(): Promise<void>
  /** This app's version (from package.json), resolved synchronously by main. */
  getAppVersion(): string
  /** The OS platform, so the renderer can adapt chrome (e.g. macOS traffic lights). */
  platform: NodeJS.Platform
  /**
   * The language to render with on first paint, resolved synchronously by main
   * (saved setting, else system locale). Sync so i18n initializes before paint.
   */
  getInitialLanguage(): AppLanguage
  /** Persist a new language choice; main broadcasts the change to all windows. */
  setLanguage(lng: AppLanguage): Promise<void>
  onAgentEvent(cb: (env: AgentEventEnvelope) => void): () => void
  onApprovalRequest(cb: (req: ApprovalRequestPayload) => void): () => void
  /** Fires when the agent asks the user one or more multiple-choice questions. */
  onQuestionRequest(cb: (req: QuestionRequestPayload) => void): () => void
  /** Fires whenever the server delivers new config (snapshot or delta). */
  onConfigChanged(cb: (config: RedactedConfigSnapshot) => void): () => void
  /** Fires when a session's title changes (auto-generated locally or synced from another device). */
  onSessionTitleUpdated(cb: (payload: SessionTitleUpdatedPayload) => void): () => void
  /** Fires when the local session list changes wholesale (e.g. pulled from the server on login). */
  onSessionsChanged(cb: () => void): () => void
  /** Fires when the signed-in session changes (login/register/logout), across windows. */
  onAuthChanged(cb: () => void): () => void
  /** Fires when the language changes (from any window); the renderer re-translates live. */
  onLanguageChanged(cb: (lng: AppLanguage) => void): () => void
}
