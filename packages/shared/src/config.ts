/**
 * Central configuration the SERVER owns and pushes to clients.
 *
 * Config is GLOBAL: admins manage one central catalog in the server web UI and
 * every client receives the same active configuration via `config:snapshot` /
 * `config:updated`. The server does NOT proxy LLM traffic — it only ships the
 * config, and the client calls the provider directly using the supplied credential.
 *
 * Mirrors the Rust serde structs under `apps/server/src/models/{llm,mcp,skill,config}.rs`.
 * Each module is its own table on the server; new modules are added the same way.
 */

/**
 * Reasoning / "thinking" effort delivered per model and applied by the client's
 * agent loop (pi-agent-core `AgentState.thinkingLevel`). pi maps this uniform
 * level onto each vendor's native control (Anthropic `effort`, OpenAI
 * `reasoning_effort`, …). `off` disables extended thinking; `xhigh` is only
 * honored by select model families and degrades gracefully elsewhere. Omitted
 * on a model means "let the client/provider default decide". Mirrors
 * `ThinkingLevel` in `apps/server/src/models/llm.rs`.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * An input modality a model accepts. Mirrors pi-ai's `Model.input` element type
 * and `Modality` in `apps/server/src/models/llm.rs`. The client forwards the set
 * to pi as `Model.input`, which gates whether image attachments reach the
 * provider or are replaced with an "(image omitted…)" placeholder. pi's
 * text-generation model carries only an input modality (output modality exists
 * solely on its image-generation models), so only `input` is configured here.
 */
export type Modality = 'text' | 'image'

/**
 * A provider connection (catalog row). Holds the API protocol + the credential
 * and optional gateway used to reach it. Many models can hang off one provider
 * and share its credential. Client injects `credential` via `new Agent({ getApiKey })`.
 */
export interface LlmProviderConfig {
  id: string
  /** Admin-facing label, e.g. "Production Anthropic". */
  name: string
  /** The HTTP API protocol the client uses to reach this provider. */
  api: ProviderApi
  /**
   * Credential used to call the provider directly. Prefer a short-lived / scoped
   * token over a long-lived master key — it is delivered to every client.
   */
  credential: string
  /** Optional gateway / proxy base URL override, shared by all its models. */
  baseUrl?: string
}

/** Create/update payload for a provider (no server-owned fields). */
export interface LlmProviderInput {
  name: string
  api: ProviderApi
  credential: string
  baseUrl?: string
}

/**
 * How the client talks to a provider's HTTP API — a pi-ai `Api`. Lives on the
 * provider connection (every model under it speaks the same protocol); it drives
 * the request format, auth scheme, and endpoint compatibility. The universal
 * `openai-completions` covers most third-party / OpenAI-compatible gateways.
 * Mirrors the `llm_provider_api_check` constraint in the DB.
 */
export type ProviderApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/**
 * Per-token price of a model (USD). Informational only — the client uses it to
 * estimate usage cost; it never gates a request. Mirrors `ModelCost` in
 * `apps/server/src/models/llm.rs`.
 */
export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * A model entry under a provider. The catalog holds many; which one is used for
 * which scenario is decided by role assignments (see {@link LlmRole}), not a flag
 * on the model itself.
 *
 * The client builds the model entirely from this config (it does not consult
 * pi-ai's built-in registry), so any custom / third-party / OpenAI-compatible
 * model works. `contextWindow` / `maxTokens` / `cost` are optional; when omitted
 * the client uses its own defaults (and treats cost as zero).
 */
export interface LlmModelConfig {
  id: string
  /** The owning provider connection. */
  providerId: string
  /** Admin-facing label. */
  name: string
  /** Provider model id, e.g. "claude-sonnet-4-20250514". */
  model: string
  /**
   * Input modalities the model accepts (non-empty; defaults to `['text']`).
   * Forwarded to pi as `Model.input` to gate image attachments. See {@link Modality}.
   */
  input: Modality[]
  /**
   * Reasoning effort the client applies when running this model. Omitted →
   * provider/client default (no explicit level forced). See {@link ThinkingLevel}.
   */
  thinkingLevel?: ThinkingLevel
  /** Context window in tokens. Omitted → client default. */
  contextWindow?: number
  /** Max output tokens per turn. Omitted → client default. */
  maxTokens?: number
  /** Per-token price. Omitted → treated as zero. */
  cost?: ModelCost
}

/** Create/update payload for a model (no server-owned fields). */
export interface LlmModelInput {
  providerId: string
  name: string
  model: string
  input: Modality[]
  thinkingLevel?: ThinkingLevel
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCost
}

/**
 * A scenario slot a model can be assigned to.
 * - `main` — the primary agent loop (required for the client to run).
 * - `tool` — an auxiliary / cheaper model (delivered, not yet consumed).
 *
 * Roles are a fixed enum here; adding one is a small, localized change (this
 * union + the Rust enum + the `CHECK` constraint + {@link RoleModels} + consumers),
 * never a DB migration. Mirrors `LlmRole` in `apps/server/src/models/llm.rs`.
 */
export type LlmRole = 'main' | 'tool'

/**
 * The active model (resolved with its provider) for each role, delivered to
 * clients in the config snapshot. A role is `null` when no model is assigned to
 * it. `main === null` means the client has no model to run. Mirrors `RoleModels`
 * in `apps/server/src/models/llm.rs`.
 */
export interface RoleModels {
  main: ActiveLlm | null
  tool: ActiveLlm | null
}

/** A single role→model binding in the admin read model. */
export interface LlmRoleAssignment {
  role: LlmRole
  modelId: string
}

/**
 * The active LLM delivered to clients: the active model joined with its provider
 * (which supplies the credential, API protocol, and base URL). Nested so the client can
 * read the model id from `model` and the connection details from `provider`.
 */
export interface ActiveLlm {
  provider: LlmProviderConfig
  model: LlmModelConfig
}

/** How the client should connect to an MCP server. */
export type McpTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'sse'; url: string; headers?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> }

export interface McpServerConfig {
  id: string
  /** User-friendly name. No jargon is ever surfaced to end users. */
  name: string
  transport: McpTransport
  enabled: boolean
}

/** Create/update payload for an MCP server. */
export interface McpServerInput {
  name: string
  transport: McpTransport
  enabled: boolean
}

/**
 * Where a skill file's bytes come from. Mirrors the Rust `SourceType` enum.
 * - `text`    — inline UTF-8 content (hydrated into `content` on read)
 * - `url`     — fetched from `sourceUrl`
 * - `dataurl` — inline data URL (built into `dataurl` on read)
 * - `upload`  — bytes stored server-side as a deduped blob
 */
export type SkillFileSourceType = 'url' | 'text' | 'dataurl' | 'upload'

/**
 * A supporting file attached to a skill. On read, the server hydrates `content`
 * for `text` sources and `dataurl` for `dataurl` sources; `url`/`upload` sources
 * are fetched on demand via `GET /api/skills/:id/files/*path`.
 * Mirrors `SkillFile` in `apps/server/src/models/skill.rs`.
 */
export interface SkillFile {
  id: string
  skillId: string
  path: string
  sourceType: SkillFileSourceType
  /** Hydrated for `text` sources on read. */
  content?: string
  /** Set for `url` sources. */
  sourceUrl?: string
  /** Built for `dataurl` sources on read. */
  dataurl?: string
  mimeType: string
  fileSizeBytes: number
  createdAt: string
  updatedAt: string
}

/**
 * A rich "Agent Skill": YAML frontmatter (name/description/metadata/...) plus a
 * markdown body (`skillMdBody`) and supporting files. Full skills and their files
 * are delivered via REST (`GET /api/skills/:id`), NOT in the config snapshot —
 * the snapshot carries only `SkillSummary` (skills can be large). No versioning.
 * Mirrors `SkillConfig` in `apps/server/src/models/skill.rs`.
 */
export interface SkillConfig {
  id: string
  /** Agent-skills name (unique, immutable after create). */
  name: string
  description: string
  license?: string
  compatibility?: string
  /** Arbitrary string→string frontmatter map. */
  metadata: Record<string, string>
  /** Any extra frontmatter keys not modeled above. */
  extraFrontmatter: Record<string, unknown>
  /** Space-separated allowed tools (frontmatter form). */
  allowedTools?: string
  /** Markdown body of SKILL.md (replaces the old `systemPrompt`). */
  skillMdBody: string
  enabled: boolean
  fileCount: number
  createdAt: string
  updatedAt: string
  files: SkillFile[]
}

/**
 * Lightweight skill row for list views (`GET /api/skills`). The full
 * `SkillConfig` without its heavy `skillMdBody` and `files` (keeps `fileCount`).
 * Mirrors `SkillListItem` in `apps/server/src/models/skill.rs`.
 */
export type SkillListItem = Omit<SkillConfig, 'skillMdBody' | 'files'>

/**
 * A file entry in a create/update payload. The server resolves the bytes from
 * the given `sourceType`. Mirrors `SkillFileEntry` in
 * `apps/server/src/models/skill.rs`.
 */
export interface SkillFileEntry {
  path: string
  sourceType: SkillFileSourceType
  /** For `text` sources. */
  content?: string
  /** For `url` sources. */
  sourceUrl?: string
  /** For `dataurl` sources. */
  dataurl?: string
  mimeType: string
  fileSizeBytes?: number
}

/** Create/update payload for a skill. Mirrors `SkillInput` in `models/skill.rs`. */
export interface SkillInput {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  extraFrontmatter?: Record<string, unknown>
  allowedTools?: string
  skillMdBody: string
  enabled: boolean
  files: SkillFileEntry[]
}

/**
 * A system prompt delivered in full to clients via `config:snapshot` (bodies are
 * small, so unlike skills the whole row ships inline). Mirrors
 * `SystemPromptConfig` in `models/system_prompt.rs`.
 */
export interface SystemPromptConfig {
  id: string
  name: string
  body: string
  enabled: boolean
}

/** Create/update payload for a system prompt. Mirrors `SystemPromptInput`. */
export interface SystemPromptInput {
  name: string
  body: string
  enabled: boolean
}

/**
 * Visual tone of a system announcement, driving the client banner's color/icon.
 * A closed set mirrored by the server's `kind` CHECK constraint and the
 * `AnnouncementKind` Rust enum in `apps/server/src/models/announcement.rs`.
 */
export type AnnouncementKind = 'info' | 'success' | 'warning' | 'error'

/**
 * A system announcement delivered in full to clients via `config:snapshot`
 * (content is small, so the whole row ships inline like {@link SystemPromptConfig}).
 * The desktop renders enabled announcements as banners atop the empty chat
 * screen; users can dismiss each one locally (persisted in localStorage, never
 * stored server-side). Mirrors `AnnouncementConfig` in `models/announcement.rs`.
 */
export interface AnnouncementConfig {
  id: string
  /** Visual tone of the banner. */
  kind: AnnouncementKind
  /** Headline shown in bold. */
  title: string
  /** Body text shown beneath the title. */
  content: string
  /** Disabled announcements are delivered but not shown by the client. */
  enabled: boolean
}

/** Create/update payload for an announcement. Mirrors `AnnouncementInput`. */
export interface AnnouncementInput {
  kind: AnnouncementKind
  title: string
  content: string
  enabled: boolean
}

/**
 * Reserved {@link SystemPromptConfig.name} the client uses as the agent's own
 * system prompt (matched case-insensitively, trimmed). Other prompts are ignored.
 */
export const MAIN_PROMPT_NAME = 'main'

/**
 * Reserved {@link SystemPromptConfig.name} the client treats specially: its body
 * is used as the system prompt for automatic session-title generation (matched
 * case-insensitively, trimmed) rather than folded into the agent's own prompt.
 */
export const TITLE_GENERATION_PROMPT_NAME = 'title_generation'

/**
 * Minimal skill descriptor shipped to clients in `config:snapshot` /
 * `config:updated`. Skills can be large (body + up to 50 MB files), so the
 * snapshot stays small — the desktop fetches the full skill and its files via
 * REST and caches by `updatedAt`. Mirrors `SkillSummary` in `models/skill.rs`.
 */
export interface SkillSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  fileCount: number
  /** Cache-busting key for client-side materialization. */
  updatedAt: string
}

/**
 * Full configuration delivered to clients via `config:snapshot`.
 * `llm` carries the model assigned to each role (`main` is required to run;
 * `tool` may be null). `skills` carries only lightweight summaries — the desktop
 * fetches each full skill and its files via REST (`GET /api/skills/:id`) on demand.
 */
export interface ConfigSnapshot {
  llm: RoleModels
  mcpServers: McpServerConfig[]
  skills: SkillSummary[]
  /** System prompts (full body; small enough to ship inline). */
  systemPrompts: SystemPromptConfig[]
  /** System announcements (full rows; shown atop the empty chat screen). */
  announcements: AnnouncementConfig[]
  /** Monotonic global version, bumped on every change; clients use it to dedupe/diff. */
  version: number
}

/**
 * The ADMIN read model returned by `GET /api/config`. Carries the whole LLM
 * catalog split across provider connections and their models so the admin UI can
 * manage both levels. `skills` are `SkillListItem` rows (no body/files) — the
 * admin fetches full skills via REST.
 */
export interface AdminConfigSnapshot {
  /** All provider connections. */
  llmProviders: LlmProviderConfig[]
  /** All models across every provider. */
  llmModels: LlmModelConfig[]
  /** Current role→model bindings (at most one per role). */
  llmRoleAssignments: LlmRoleAssignment[]
  mcpServers: McpServerConfig[]
  skills: SkillListItem[]
  /** System prompts (full rows; same shape as the client view). */
  systemPrompts: SystemPromptConfig[]
  /** System announcements (full rows; same shape as the client view). */
  announcements: AnnouncementConfig[]
  version: number
}

/**
 * Incremental configuration delta via `config:updated`. Omitted fields are
 * unchanged. `llm` is always sent in full (the whole role map, no per-role delta).
 */
export interface ConfigUpdate {
  llm: RoleModels
  mcpServers?: McpServerConfig[]
  skills?: SkillSummary[]
  systemPrompts?: SystemPromptConfig[]
  announcements?: AnnouncementConfig[]
  version: number
}
