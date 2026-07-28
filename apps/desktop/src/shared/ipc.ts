/**
 * Shared IPC contract between main and renderer.
 * Channel names + payload types live here so both sides stay in sync.
 *
 * Two traffic patterns:
 *   - Commands  : renderer -> main, request/response via ipcRenderer.invoke
 *   - Event flow: main -> renderer, fire-and-forget via webContents.send
 */

import type {
  ActiveLlm,
  AnnouncementConfig,
  McpServerConfig,
  Memory,
  RoleModels,
  ServiceConfig,
  SkillConfig,
  SkillSummary,
  SystemPromptConfig
} from '@flairy/shared'

export type { Memory } from '@flairy/shared'

/**
 * `process.platform` values, spelled out rather than borrowed from `NodeJS.Platform`.
 * This file is compiled by the renderer's tsconfig too, which deliberately excludes
 * Node's type declarations so renderer code can't reach for Node APIs.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd'

/** Channel name constants — never hardcode strings elsewhere. */
export const IPC = {
  // commands (invoke)
  AgentPrompt: 'agent:prompt',
  AgentSteer: 'agent:steer',
  AgentAbort: 'agent:abort',
  AgentApprovalResponse: 'agent:approval-response',
  AgentQuestionResponse: 'agent:question-response',
  AgentSetPermissionMode: 'agent:set-permission-mode',
  AgentCompressContext: 'agent:compress-context',
  AgentWatchSession: 'agent:watch-session',
  AgentUnwatchSession: 'agent:unwatch-session',
  SessionList: 'session:list',
  SessionLoad: 'session:load',
  SessionLoadLive: 'session:load-live',
  SearchMessages: 'search:messages',
  SessionCreate: 'session:create',
  SessionSetCwd: 'session:set-cwd',
  SessionListRecentDirs: 'session:list-recent-dirs',
  SessionRemoveRecentDir: 'session:remove-recent-dir',
  RecentDirContextMenu: 'recent-dir:context-menu',
  SessionChooseDir: 'session:choose-dir',
  SessionRename: 'session:rename',
  SessionDelete: 'session:delete',
  SessionContextMenu: 'session:context-menu',
  MemoryList: 'memory:list',
  MemoryDelete: 'memory:delete',
  MemoryClear: 'memory:clear',
  DialogPickDirectory: 'dialog:pick-directory',
  FsListFiles: 'fs:list-files',
  FsReadFile: 'fs:read-file',
  ImageViewerOpen: 'image-viewer:open',
  ImageViewerGet: 'image-viewer:get',
  ShellOpenExternal: 'shell:open-external',
  SecretsSet: 'secrets:set',
  SecretsHas: 'secrets:has',
  TelegramGetStatus: 'telegram:get-status',
  TelegramConnect: 'telegram:connect',
  TelegramDisconnect: 'telegram:disconnect',
  TelegramStartPairing: 'telegram:start-pairing',
  TelegramUnpair: 'telegram:unpair',
  TelegramPause: 'telegram:pause',
  TelegramResume: 'telegram:resume',
  GithubGetStatus: 'github:get-status',
  GithubAuthStart: 'github:auth-start',
  GithubAuthCancel: 'github:auth-cancel',
  GithubDisconnect: 'github:disconnect',
  GithubSetClientId: 'github:set-client-id',
  WorkerRunList: 'worker-run:list',
  WorkerRunAbort: 'worker-run:abort',
  WorkerRunOpenTranscript: 'worker-run:open-transcript',
  AcpBackendList: 'acp:backend-list',
  AcpBackendUpdate: 'acp:backend-update',
  AcpBackendProbe: 'acp:backend-probe',
  AuthLogin: 'auth:login',
  AuthRegister: 'auth:register',
  AuthLogout: 'auth:logout',
  AuthStatus: 'auth:status',
  ConfigGet: 'config:get',
  SocketStatusGet: 'socket:status',
  WindowOpenSettings: 'window:open-settings',
  WindowGrowWidth: 'window:grow-width',
  // Quick launcher (Spotlight-style) window.
  LauncherShow: 'launcher:show',
  LauncherHide: 'launcher:hide',
  LauncherResize: 'launcher:resize',
  LauncherOpenInMain: 'launcher:open-in-main',
  LauncherTakePendingSession: 'launcher:take-pending-session',
  SettingsGetLauncherShortcut: 'settings:get-launcher-shortcut',
  SettingsSetLauncherShortcut: 'settings:set-launcher-shortcut',
  AppGetVersion: 'app:get-version',
  UpdateGetState: 'update:get-state',
  UpdateOpenRelease: 'update:open-release',
  UpdateDownload: 'update:download',
  UpdateInstall: 'update:install',
  SettingsGetLanguage: 'settings:get-language',
  SettingsSetLanguage: 'settings:set-language',
  SettingsGetCloseToTray: 'settings:get-close-to-tray',
  SettingsSetCloseToTray: 'settings:set-close-to-tray',
  SettingsGetChatWidth: 'settings:get-chat-width',
  SettingsSetChatWidth: 'settings:set-chat-width',
  SettingsGetPreferredModel: 'settings:get-preferred-model',
  SettingsSetPreferredModel: 'settings:set-preferred-model',
  // Advanced settings (hidden behind the version-tap gate) + local config mode.
  AdvancedGetUnlocked: 'advanced:get-unlocked',
  AdvancedSetUnlocked: 'advanced:set-unlocked',
  ConfigGetMode: 'config:get-mode',
  ConfigSetMode: 'config:set-mode',
  LocalConfigGet: 'local-config:get',
  LocalConfigSave: 'local-config:save',
  // event streams (send)
  TelegramStatusChanged: 'telegram:status-changed',
  GithubStatusChanged: 'github:status-changed',
  WorkerRunChanged: 'worker-run:changed',
  UpdateStateChanged: 'update:state-changed',
  AgentEvent: 'agent:event',
  ApprovalRequest: 'agent:approval-request',
  QuestionRequest: 'agent:question-request',
  ConfigChanged: 'config:changed',
  SocketStatusChanged: 'socket:status-changed',
  AuthChanged: 'auth:changed',
  SessionTitleUpdated: 'session:title-updated',
  SessionsChanged: 'session:changed',
  MemoriesChanged: 'memory:changed',
  LanguageChanged: 'settings:language-changed',
  ChatWidthChanged: 'settings:chat-width-changed',
  PreferredModelChanged: 'settings:preferred-model-changed',
  AdvancedUnlockedChanged: 'advanced:unlocked-changed',
  ConfigModeChanged: 'config:mode-changed',
  AgentCompressStatus: 'agent:compress-status',
  LauncherShown: 'launcher:shown',
  LauncherOpenSession: 'launcher:open-session'
} as const

/** UI language. The single source of truth for both renderer and main catalogs. */
export type AppLanguage = 'en' | 'zh-CN'

/**
 * How wide the chat column renders. Maps to the `data-chat-width` attribute on
 * the document root, which selects the `--chat-width` CSS variable.
 */
export type ChatWidth = 'standard' | 'wide' | 'full'

/**
 * A newer release the main process found on GitHub. Surfaced as a header badge;
 * `url` is the release page opened (externally) when the app can't self-install.
 */
export interface UpdateInfo {
  /** Latest version, normalized without a leading "v" (e.g. "0.2.0"). */
  version: string
  /** GitHub release page URL to open in the browser. */
  url: string
  /** Optional release title/name for display. */
  notes?: string
}

/**
 * Where the app sits in the update lifecycle. Only a packaged Windows build
 * reaches `downloading`/`ready` — everywhere else the badge stops at
 * `available` and clicking it just opens the release page.
 */
export type UpdateStage = 'idle' | 'available' | 'downloading' | 'ready' | 'error'

/** Download telemetry, mirrored from electron-updater's progress events. */
export interface UpdateProgress {
  /** 0–100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** The whole update picture, recomputed in main and broadcast to every window. */
export interface UpdateState {
  stage: UpdateStage
  /** The newer release once one is known; null while idle. */
  info: UpdateInfo | null
  /** Set only while `stage === 'downloading'`. */
  progress: UpdateProgress | null
  /** Failure reason when `stage === 'error'` (already localized-agnostic, raw). */
  error?: string
  /**
   * True when this build can download and install the update itself — i.e. a
   * packaged Windows/NSIS build. False elsewhere, where the badge degrades to
   * opening the release page in the browser.
   */
  canInstall: boolean
}

/** A single attachment for multimodal prompts. */
export interface Attachment {
  type: 'image'
  data: string // base64
  mimeType: string
}

/**
 * A displayable image, handed to the standalone image-viewer window for
 * full-size zoom/pan. Either inline data (a user-attached picture; `data` is
 * raw base64 without the data: prefix) or a remote `url` (a web-search image —
 * the viewer window loads it itself, no round-trip through main).
 */
export interface ViewerImage {
  data?: string
  mimeType?: string
  url?: string
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

/** Manual context-compression trigger (the ModelPanel button). */
export interface CompressContextArgs {
  sessionId: string
}

/**
 * Pushed from main → renderer when a context-compression auxiliary call starts
 * or ends, so the message list can show a shimmer status row while it runs.
 */
export interface CompressStatusPayload {
  sessionId: string
  active: boolean
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
 * Tool-approval posture.
 *   - `ask`  : mutating/MCP tools prompt for confirmation.
 *   - `full` : "Full access" — every tool runs without prompting.
 * GLOBAL (not per-session): one value applies to every session. Held in renderer
 * state + an in-memory mirror in main; resets to the safe `ask` on restart.
 */
export type PermissionMode = 'ask' | 'full'

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
  workspacePath?: string | null
}

export interface RenameSessionArgs {
  sessionId: string
  title: string
}

export interface DeleteSessionArgs {
  sessionId: string
}

/** Item the user picked from a session row's native right-click menu. */
export type SessionMenuAction = 'rename' | 'delete' | 'select'

/** Item the user picked from a recent-directory's native right-click menu. */
export type RecentDirMenuAction = 'remove'

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  /** Null means a synced chat; a path means a local-only project session. */
  workspacePath: string | null
  kind: 'chat' | 'project'
  createdAt: number
  updatedAt: number
  /** True if this session was created from Telegram — tagged + read-only on desktop. */
  fromTelegram?: boolean
}

export interface ListWorkspaceFilesArgs {
  /** Absolute workspace path of a project session (validated against known sessions in main). */
  root: string
}

/** Git working-tree state for one file, used to tint rows in the workspace file tree. */
export interface WorkspaceGitStatusEntry {
  /** Root-relative posix path. */
  path: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
}

export interface ListWorkspaceFilesResult {
  /**
   * Root-relative posix file paths (files only — the tree infers directories
   * from path prefixes, so empty directories don't appear).
   */
  paths: string[]
  /** True when the enumeration cap was hit; `paths` is the first N entries. */
  truncated: boolean
  /** Null when the workspace isn't a git repo or git isn't installed. */
  gitStatus: WorkspaceGitStatusEntry[] | null
}

export interface ReadWorkspaceFileArgs {
  root: string
  /** Root-relative path of the file to read (posix separators). */
  relPath: string
}

/** Discriminated preview payload; failures come back as values, never as thrown IPC errors. */
export type ReadWorkspaceFileResult =
  | { kind: 'text'; content: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'tooLarge'; size: number }
  | { kind: 'error'; message: string }

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
  /** User-selectable main-model candidates, credentials masked like `llm.*`. */
  modelOptions: ActiveLlm[]
  /** MCP servers with secret transport values (headers/env) masked. */
  mcpServers: McpServerConfig[]
  /** Skill summaries carry no secrets and are passed through unchanged. */
  skills: SkillSummary[]
  /** System prompts carry no secrets and are passed through unchanged. */
  systemPrompts: SystemPromptConfig[]
  /** Announcements carry no secrets and are passed through unchanged. */
  announcements: AnnouncementConfig[]
  /** External services with their `secret` masked (e.g. Exa web search). */
  services: ServiceConfig[]
  /** Monotonic global config version. */
  version: number
}

/**
 * Where the client's active configuration comes from.
 * - `server` — the normal path: the admin server pushes config over socket.io.
 * - `local`  — "detached" mode: the socket is closed and the client runs fully
 *   offline off a config the user entered by hand in Advanced settings.
 *
 * Persisted in the main process (SQLite `settings` KV). Toggled from the hidden
 * Advanced settings tab. See {@link LocalConfigDraft}.
 */
export type ConfigMode = 'server' | 'local'

/**
 * The full, user-editable local configuration behind the Advanced settings tab.
 * Structurally the pieces of a `ConfigSnapshot` that a detached client needs,
 * plus FULL skills (bodies + files) rather than summaries, since there is no
 * server to fetch them from.
 *
 * SECURITY: on READ (`local-config:get`) every secret is masked exactly like
 * {@link RedactedConfigSnapshot} — `llm.*.provider.credential`, MCP transport
 * `env`/`headers` values, and service `secret`. On SAVE (`local-config:save`)
 * any secret still carrying the mask marker (`••••…`) is left unchanged; a new
 * plaintext value the user typed overwrites it. Plaintext secrets live only in
 * the main process (encrypted at rest), never round-tripped back to the renderer.
 */
export interface LocalConfigDraft {
  /** Per-role active models (main required to run; tool/visual optional). */
  llm: RoleModels
  /** MCP servers the detached client should connect to. */
  mcpServers: McpServerConfig[]
  /** System prompts (reserved names: main/chat/title_generation/…). */
  systemPrompts: SystemPromptConfig[]
  /** External services (e.g. Exa web search). */
  services: ServiceConfig[]
  /** Full skills, materialized to disk locally (inline file sources only). */
  skills: SkillConfig[]
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

/**
 * Token usage + already-computed dollar cost for one assistant turn. Mirrors the
 * subset of pi-ai's `Usage` we surface in the UI (cost tab). pi-ai computes the
 * cost from the model's configured rates, so the renderer just sums these.
 */
export interface MessageUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

/** Minimal subset of pi-agent-core events the UI cares about. */
export type AgentStreamEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; messageId: string }
  | { type: 'message_update'; messageId: string; delta: string; thinkingDelta?: string }
  | {
      type: 'message_end'
      messageId: string
      role: string
      text: string
      thinking?: string
      // Images attached to a `user` message (Telegram photos). Carried so a
      // remotely-authored user turn — which the desktop never optimistically
      // rendered — can show its thumbnails live, mirroring the replay path.
      images?: { data: string; mimeType: string }[]
      // Only assistant turns carry usage; the per-message timestamp pi stamps lets
      // the timeline tab show real times.
      usage?: MessageUsage
      timestamp?: number
    }
  | { type: 'tool_execution_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; partial: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }
  | { type: 'error'; message: string }
  // A model request failed transiently and the main process is auto-retrying
  // with backoff. `active: true` opens the renderer's "retrying" shimmer (and
  // trims the failed attempt's partial bubble); `active: false` closes it —
  // either the retry succeeded or the final error event follows.
  | { type: 'retry_status'; active: boolean; attempt: number; max: number }

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

/**
 * Live status of the Telegram integration, pushed to the renderer whenever it
 * changes. No token field anywhere renderer-facing.
 */
export interface TelegramStatus {
  /** Whether the bot is configured to accept inbound messages. */
  enabled: boolean
  /** Whether the bot is currently polling Telegram successfully. */
  connected: boolean
  /** @BotUsername reported by Telegram after a successful connect. */
  botUsername?: string
  /** Whether a chat has completed the /pair handshake. */
  paired: boolean
  /** Display label for the bound chat (e.g. group name or "DM"). */
  boundChatLabel?: string
  /** Active pairing code + expiry (only present while a pairing is in progress). */
  pairing?: { code: string; expiresAt: number }
  /** Last error message surface (e.g. "invalid token", "connected on another device"). */
  lastError?: string
  /** Epoch ms of the most-recently processed inbound message (for diagnosing bot-privacy issues). */
  lastInboundAt?: number
}

/** Args for the connectTelegram command. The token is the only renderer→main secret crossing. */
export interface TelegramConnectArgs {
  token: string
}

/**
 * A pending GitHub Device Flow verification: the renderer shows the code and
 * points the user at github.com/login/device. Main polls in the background and
 * pushes a GithubStatusChanged once the grant lands.
 */
export interface GithubDeviceCode {
  userCode: string
  verificationUri: string
  /** Seconds until this code expires. */
  expiresIn: number
}

/**
 * Live status of the GitHub connection, pushed via GithubStatusChanged. No
 * token anywhere renderer-facing — only whether one exists and whose it is.
 */
export interface GithubStatus {
  connected: boolean
  /** GitHub login of the connected account. */
  login?: string
  /** Whether an OAuth App client ID is configured (Device Flow needs one). */
  clientIdSet: boolean
  /** Present while a device authorization is awaiting the user on github.com. */
  pending?: GithubDeviceCode
  /** Last auth failure surfaced to the settings card. */
  lastError?: string
}

/**
 * One configuration option an ACP agent advertises for its sessions
 * (`configOptions` on session/new — model, effort, mode, …), reduced to a
 * renderer-safe shape. Selects carry flattened choices; booleans are switches.
 */
export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  /** Semantic hint from the agent: 'mode' | 'model' | 'thought_level' | … */
  category?: string
  type: 'select' | 'boolean'
  /** The agent's own default (current) value. */
  defaultValue: string | boolean
  /** Choices for select options. */
  choices?: { value: string; name: string; description?: string }[]
}

/**
 * Renderer view of one ACP worker backend (an external coding agent Flairy can
 * dispatch work to). Settings page material: which agents are enabled, the
 * config options probed from the agent itself (model/effort/…), the user's
 * chosen values, and an optional launch-command override.
 */
export interface AcpBackendView {
  id: string
  label: string
  enabled: boolean
  /** Whether the underlying agent CLI was found on this machine (or a command override is set). */
  installed: boolean
  /** The binary name the detection looked for (for the "install X first" hint). */
  detectBin: string
  /** Free-text model fallback, used only when the probe found no model option. */
  model?: string
  /** Example model id shown as the input placeholder. */
  modelPlaceholder: string
  /** User override of the launch command line (empty = default). */
  command?: string
  defaultCommand: string
  /** Config options reported by the agent (probed; undefined = never probed). */
  options?: AcpConfigOption[]
  /** User-chosen option values, keyed by option id (absent = agent default). */
  values: Record<string, string | boolean>
  /** When the options were last probed (epoch ms). */
  probedAt?: number
  /** Why the last probe failed, if it did. */
  probeError?: string
}

/** Patch for one backend; undefined = leave unchanged, null/'' = clear. */
export interface AcpBackendUpdateArgs {
  id: string
  enabled?: boolean
  model?: string | null
  command?: string | null
  /** Option values to merge; a null value clears that option back to default. */
  values?: Record<string, string | boolean | null>
}

/** Lifecycle of an ACP worker dispatch (dispatch_task / dispatch_review). */
export type WorkerRunStatus =
  | 'preparing'
  | 'running'
  | 'pushing'
  | 'pr_opened'
  /** The run's PR was merged by the user (set by the GitHub poller). */
  | 'merged'
  /** Review posted on the PR (terminal state for review runs). */
  | 'reviewed'
  | 'failed'
  | 'cancelled'
  | 'timeout'

/** What a worker run does: implement an issue, or review a pull request. */
export type WorkerRunKind = 'implement' | 'review'

/**
 * One worker dispatch: an external coding agent (driven over ACP) implementing
 * a GitHub issue in an isolated git worktree. Persisted in SQLite for the Runs
 * panel + startup reconciliation; `tail` is the live in-memory activity feed.
 */
export interface WorkerRun {
  id: string
  sessionId: string
  kind: WorkerRunKind
  issueNumber?: number
  backend: string
  branch?: string
  worktreePath?: string
  status: WorkerRunStatus
  prNumber?: number
  prUrl?: string
  /** Final worker summary, or the error text for failed runs. */
  summary?: string
  /** Rolling tail of live worker activity (present only while running). */
  tail?: string
  /** Whether a full on-disk transcript exists for this run (openable from the Runs panel). */
  hasTranscript?: boolean
  startedAt?: number
  endedAt?: number
  createdAt: number
  updatedAt: number
}

/** Main server socket connection state, renderer-safe and credential-free. */
export type SocketConnectionStatus = 'disconnected' | 'connecting' | 'connected'

/**
 * The quick-launcher global shortcut, as saved and as actually registered.
 * `accelerator` is an Electron accelerator string ('' = shortcut disabled).
 * `registered` is false when the OS refused the chord (already taken by another
 * app) — the choice is persisted anyway so the Settings UI can show a hint.
 */
export interface LauncherShortcutStatus {
  accelerator: string
  registered: boolean
}

/**
 * Sent to the launcher window on every summon. `reset: true` means start a
 * fresh conversation (first summon, or the previous one aged out of the keep
 * window); `false` means the previous quick chat is still fresh — keep it and
 * just put the caret back.
 */
export interface LauncherShownPayload {
  reset: boolean
}

/** Returned by startTelegramPairing: a one-time code the user sends via /pair. */
export interface TelegramPairing {
  code: string
  expiresAt: number
}

/** The surface exposed to the renderer via contextBridge as `window.api`. */
export interface FlairyApi {
  prompt(args: PromptArgs): Promise<void>
  steer(args: SteerArgs): Promise<void>
  abort(args: AbortArgs): Promise<void>
  /**
   * Register/unregister THIS window's interest in a session's agent event
   * stream. Main delivers agent events only to watching windows (falling back
   * to a broadcast for sessions nobody watches), so a streaming session no
   * longer structured-clones every token into windows that don't hold it.
   * Idempotent per window; watches are dropped automatically when the window
   * is destroyed. Call watch when a session runtime is created and unwatch
   * when it is pruned/deleted.
   */
  watchSession(sessionId: string): Promise<void>
  unwatchSession(sessionId: string): Promise<void>
  respondApproval(args: ApprovalResponseArgs): Promise<void>
  /** Submit the user's answers to an `ask` tool call (null when cancelled). */
  respondQuestion(args: QuestionResponseArgs): Promise<void>
  /** Set the GLOBAL tool-approval posture (persisted; applies to every session). */
  setPermissionMode(mode: PermissionMode): Promise<void>
  /**
   * Manually compress the open session's context now (folds older messages into
   * the rolling summary). Best-effort: resolves once the auxiliary call finishes
   * (or is skipped). No-op if there's nothing to compress or no compression
   * prompt is configured.
   */
  compressContext(args: CompressContextArgs): Promise<void>
  listSessions(): Promise<SessionMeta[]>
  loadSession(sessionId: string): Promise<{ meta: SessionMeta; messages: unknown[] }>
  /**
   * Open a session with its LIVE state: a running session's in-memory messages
   * (ahead of the last persist) plus whether a turn is currently in flight. Falls
   * back to the persisted snapshot for a session with no live agent service.
   */
  loadSessionLive(sessionId: string): Promise<{
    meta: SessionMeta
    messages: unknown[]
    running: boolean
    compressing: boolean
    /** Non-null while a model-request auto-retry is in flight (backoff window). */
    retrying: { attempt: number; max: number } | null
    /** Unanswered tool approvals for this session (re-seeded so the card reappears). */
    pendingApprovals: ApprovalRequestPayload[]
    /** Unanswered `ask` questions for this session (re-seeded so the card reappears). */
    pendingQuestions: QuestionRequestPayload[]
  }>
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
  /** Forget a recent directory. Returns the updated recents list, newest first. */
  removeRecentDirectory(path: string): Promise<string[]>
  /**
   * Pop the OS-native right-click menu for a recent-directory entry and resolve
   * with the chosen action, or null if dismissed. The renderer carries out the
   * action so the store stays the source of truth.
   */
  showRecentDirMenu(): Promise<RecentDirMenuAction | null>
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
  /** The user's remembered facts/preferences (active, newest first). */
  listMemories(): Promise<Memory[]>
  /** Forget a single memory (soft-delete + sync). Returns the updated list. */
  deleteMemory(id: string): Promise<Memory[]>
  /** Forget everything the assistant remembers (soft-delete all + sync). Returns []. */
  clearMemories(): Promise<Memory[]>
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
  /**
   * Enumerate all files under a project session's workspace (gitignore-aware,
   * capped). `root` must be a known session's workspacePath. Feeds the Files tab.
   */
  listWorkspaceFiles(args: ListWorkspaceFilesArgs): Promise<ListWorkspaceFilesResult>
  /** Read one workspace file for preview: text content, or a binary/tooLarge/error marker. */
  readWorkspaceFile(args: ReadWorkspaceFileArgs): Promise<ReadWorkspaceFileResult>
  setSecret(args: SetSecretArgs): Promise<void>
  hasSecret(provider: SetSecretArgs['provider']): Promise<boolean>
  /** Current Telegram integration status (bot, pairing, binding). */
  getTelegramStatus(): Promise<TelegramStatus>
  /** Store the token, start polling, and return the new status. */
  connectTelegram(args: TelegramConnectArgs): Promise<TelegramStatus>
  /** Stop polling, wipe the stored token, and return the new status. */
  disconnectTelegram(): Promise<TelegramStatus>
  /** Generate a one-time pairing code and return it. */
  startTelegramPairing(): Promise<TelegramPairing>
  /** Clear the bound chat (unpair) and return the new status. */
  unpairTelegram(): Promise<TelegramStatus>
  /** Kill switch: abort all Telegram turns + stop accepting inbound, keep binding. */
  pauseTelegram(): Promise<TelegramStatus>
  /** Undo Pause: re-enable the binding and restart polling from the stored token. */
  resumeTelegram(): Promise<TelegramStatus>
  /** Subscribe to Telegram status changes pushed from main. Returns an unsubscribe fn. */
  onTelegramStatusChanged(cb: (s: TelegramStatus) => void): () => void
  /** Current GitHub connection status (never the token). */
  getGithubStatus(): Promise<GithubStatus>
  /**
   * Begin the Device Flow: resolves with the user code + verification URL to
   * display. Main keeps polling GitHub; the eventual grant (or failure) arrives
   * via onGithubStatusChanged.
   */
  startGithubAuth(): Promise<GithubDeviceCode>
  /** Abandon a pending device authorization. */
  cancelGithubAuth(): Promise<GithubStatus>
  /** Wipe the stored token and return the new status. */
  disconnectGithub(): Promise<GithubStatus>
  /** Save the OAuth App client ID (public value) used for Device Flow. */
  setGithubClientId(clientId: string): Promise<GithubStatus>
  /** Subscribe to GitHub status changes pushed from main. Returns an unsubscribe fn. */
  onGithubStatusChanged(cb: (s: GithubStatus) => void): () => void
  /** Worker runs for a session (live tail merged in), newest first. */
  listWorkerRuns(sessionId: string): Promise<WorkerRun[]>
  /** Abort a running worker dispatch. */
  abortWorkerRun(runId: string): Promise<void>
  /** Open a run's full on-disk transcript in the system's default app. */
  openWorkerRunTranscript(runId: string): Promise<void>
  /** Subscribe to worker-run updates pushed from main. Returns an unsubscribe fn. */
  onWorkerRunChanged(cb: (run: WorkerRun) => void): () => void
  /** All known ACP worker backends with their settings (for the ACP settings page). */
  listAcpBackends(): Promise<AcpBackendView[]>
  /** Patch one backend's enabled/model/command/values; returns the refreshed list. */
  updateAcpBackend(args: AcpBackendUpdateArgs): Promise<AcpBackendView[]>
  /**
   * Launch the agent briefly to discover its config options (model, effort, …).
   * Slow on first run (npx self-install). Returns the refreshed list — with
   * `options` populated on success or `probeError` set on failure.
   */
  probeAcpBackend(id: string): Promise<AcpBackendView[]>
  login(args: LoginArgs): Promise<AuthStatus>
  register(args: RegisterArgs): Promise<AuthStatus>
  logout(): Promise<void>
  authStatus(): Promise<AuthStatus>
  /** Latest server-pushed config (secrets masked), or null before first snapshot. */
  getConfig(): Promise<RedactedConfigSnapshot | null>
  /** Current main server socket connection state. */
  getSocketStatus(): Promise<SocketConnectionStatus>
  /** Open (or focus) the standalone Settings window. */
  openSettings(): Promise<void>
  /** Toggle the quick-launcher window (dev/tray fallback for the global shortcut). */
  showLauncher(): Promise<void>
  /** Hide the quick-launcher window (Esc). */
  hideLauncher(): Promise<void>
  /** Resize the quick-launcher window to `height` px (clamped; grows downward). */
  resizeLauncher(height: number): Promise<void>
  /**
   * Hand the launcher's conversation off to the main window: shows/recreates the
   * main window, tells it to open `sessionId`, and hides the launcher. Tolerates
   * an empty/unknown id (just brings the main window forward).
   */
  openLauncherSessionInMain(sessionId: string): Promise<void>
  /**
   * Called by a freshly-(re)created main window: fetch (and consume) a session
   * handed off while no main window was alive. Null if there is none.
   */
  takePendingLauncherSession(): Promise<SessionMeta | null>
  /** The saved quick-launcher shortcut and whether it's actually registered. */
  getLauncherShortcut(): Promise<LauncherShortcutStatus>
  /** Persist + re-register the quick-launcher shortcut ('' disables it). */
  setLauncherShortcut(accelerator: string): Promise<LauncherShortcutStatus>
  /**
   * Widen the main window by `delta` px (clamped to the display work area, never
   * shrinks). The renderer calls this before opening the details panel when the
   * panel would otherwise push the chat column below its comfortable minimum.
   */
  growWindowWidth(delta: number): Promise<void>
  /** Open an http(s) URL in the user's default browser (e.g. a citation source). */
  openExternal(url: string): Promise<void>
  /** Open a borderless window showing `image` full size with zoom/pan. */
  openImageViewer(image: ViewerImage): Promise<void>
  /**
   * Called by the image-viewer window itself: fetch (and consume) the image main
   * stashed for the given id when the window was opened. Returns null if missing.
   */
  getViewerImage(id: string): Promise<ViewerImage | null>
  /** This app's version (from package.json), resolved synchronously by main. */
  getAppVersion(): string
  /** The current update lifecycle state (stage + known release + progress). */
  getUpdateState(): Promise<UpdateState>
  /** Open the latest release page in the OS browser. */
  openReleasePage(): Promise<void>
  /**
   * Start downloading the available update in the background. No-op unless
   * `canInstall` — on macOS/Linux use `openReleasePage()` instead.
   */
  downloadUpdate(): Promise<void>
  /** Quit and run the downloaded installer. Only valid once stage is `ready`. */
  installUpdate(): Promise<void>
  /** The OS platform, so the renderer can adapt chrome (e.g. macOS traffic lights). */
  platform: Platform
  /**
   * The language to render with on first paint, resolved synchronously by main
   * (saved setting, else system locale). Sync so i18n initializes before paint.
   */
  getInitialLanguage(): AppLanguage
  /** Persist a new language choice; main broadcasts the change to all windows. */
  setLanguage(lng: AppLanguage): Promise<void>
  /** Whether closing the main window hides it to the tray instead of closing. */
  getCloseToTray(): Promise<boolean>
  /** Persist the close-to-tray preference (default on). */
  setCloseToTray(value: boolean): Promise<void>
  /** The saved chat column width preference (default "standard"). */
  getChatWidth(): Promise<ChatWidth>
  /** Persist a new chat width; main broadcasts the change to all windows. */
  setChatWidth(width: ChatWidth): Promise<void>
  /** The user's main-model pick (a model id from `modelOptions`), or null when following the admin. */
  getPreferredMainModel(): Promise<string | null>
  /** Persist a main-model pick (null = follow the admin); applies live and broadcasts. */
  setPreferredMainModel(id: string | null): Promise<void>
  /** Whether the hidden Advanced settings tab has been unlocked (tap version 10×). */
  getAdvancedUnlocked(): Promise<boolean>
  /** Persist the Advanced-settings unlock flag; main broadcasts to all windows. */
  setAdvancedUnlocked(value: boolean): Promise<void>
  /** Whether config comes from the server or a local (detached) config. */
  getConfigMode(): Promise<ConfigMode>
  /** Switch config source. `local` closes the socket; `server` reconnects. */
  setConfigMode(mode: ConfigMode): Promise<void>
  /** The saved local config with secrets masked, or null if none saved yet. */
  getLocalConfig(): Promise<LocalConfigDraft | null>
  /** Persist an edited local config (masked secrets are kept); applies it live in local mode. */
  saveLocalConfig(draft: LocalConfigDraft): Promise<void>
  onAgentEvent(cb: (env: AgentEventEnvelope) => void): () => void
  onApprovalRequest(cb: (req: ApprovalRequestPayload) => void): () => void
  /** Fires when the agent asks the user one or more multiple-choice questions. */
  onQuestionRequest(cb: (req: QuestionRequestPayload) => void): () => void
  /** Fires whenever the server delivers new config (snapshot or delta). */
  onConfigChanged(cb: (config: RedactedConfigSnapshot) => void): () => void
  /** Fires whenever the main server socket connects, reconnects, or disconnects. */
  onSocketStatusChanged(cb: (status: SocketConnectionStatus) => void): () => void
  /** Fires when a session's title changes (auto-generated locally or synced from another device). */
  onSessionTitleUpdated(cb: (payload: SessionTitleUpdatedPayload) => void): () => void
  /** Fires when the local session list changes wholesale (e.g. pulled from the server on login). */
  onSessionsChanged(cb: () => void): () => void
  /** Fires when the user's memories change (written by the agent, synced, or edited). */
  onMemoriesChanged(cb: () => void): () => void
  /** Fires when the signed-in session changes (login/register/logout), across windows. */
  onAuthChanged(cb: () => void): () => void
  /** Fires when the language changes (from any window); the renderer re-translates live. */
  onLanguageChanged(cb: (lng: AppLanguage) => void): () => void
  /** Fires when the chat width preference changes (from any window). */
  onChatWidthChanged(cb: (width: ChatWidth) => void): () => void
  /** Fires when the main-model pick changes (from any window). */
  onPreferredMainModelChanged(cb: (id: string | null) => void): () => void
  /** Fires when the Advanced-settings unlock flag changes (from any window). */
  onAdvancedUnlockedChanged(cb: (unlocked: boolean) => void): () => void
  /** Fires when the config source (server ↔ local) changes (from any window). */
  onConfigModeChanged(cb: (mode: ConfigMode) => void): () => void
  /** Fires whenever the update lifecycle advances (found / progress / ready / failed). */
  onUpdateState(cb: (state: UpdateState) => void): () => void
  /** Fires when a session's context-compression run starts/ends (drives the message-list shimmer). */
  onCompressStatus(cb: (payload: CompressStatusPayload) => void): () => void
  /** Fires in the launcher window each time it is summoned (fresh chat vs continue). */
  onLauncherShown(cb: (payload: LauncherShownPayload) => void): () => void
  /** Fires in the main window when the launcher hands a conversation off to it. */
  onLauncherOpenSession(cb: (meta: SessionMeta) => void): () => void
}
