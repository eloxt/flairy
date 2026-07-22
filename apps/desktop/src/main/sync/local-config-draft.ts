import { randomUUID } from 'node:crypto'
import type {
  ActiveLlm,
  ConfigSnapshot,
  McpServerConfig,
  McpTransport,
  RoleModels,
  ServiceConfig,
  SkillConfig,
  SkillSummary
} from '@flairy/shared'
import type { LocalConfigDraft } from '@shared/ipc'
import { redactConfig } from './config-redact'
import { SERVER_URL } from './server-client'
import { fetchFullSkills } from '../agent/skill-materializer'
import { loadLocalConfig, saveLocalConfig, type LocalConfigBundle } from '../store/local-config'

/**
 * Bridges the renderer's {@link LocalConfigDraft} (Advanced settings editor) and
 * the encrypted {@link LocalConfigBundle} on disk.
 *
 * READ: redacts every secret (via {@link redactConfig}) so the renderer never
 * sees a plaintext key — same discipline as the server config.
 *
 * SAVE: any secret the editor sends back still masked (starts with {@link MASK_PREFIX})
 * is preserved from the stored value; only a freshly-typed plaintext value
 * overwrites it. An empty string clears the secret. Skill summaries are derived
 * from the full skills, and `updatedAt` is bumped so the materializer re-writes.
 */

/** The leading run of bullets `redactConfig` uses to mask a secret. */
const MASK_PREFIX = '••••'

/** True when a field value is a redaction mask (means "keep the stored value"). */
function isMasked(value: string): boolean {
  return value.startsWith(MASK_PREFIX)
}

/** Load the saved local config as a renderer-safe draft (secrets masked). */
export function readLocalConfigDraft(): LocalConfigDraft | null {
  const bundle = loadLocalConfig()
  if (!bundle) return null
  return toDraft(redactConfig(bundle.config), bundle.skills)
}

/**
 * Seed a draft from the current SERVER config (secrets masked) so the editor
 * opens pre-filled with the latest pushed configuration instead of blank. NOT
 * persisted — it only becomes the local config once the user saves. Full skills
 * are fetched over REST (best-effort; empty when offline). Returns null when the
 * server has delivered no config yet.
 */
export async function seedDraftFromServer(
  serverConfig: ConfigSnapshot | null,
  token: string | undefined
): Promise<LocalConfigDraft | null> {
  if (!serverConfig) return null
  const skills = await fetchFullSkills(serverConfig.skills, token, SERVER_URL)
  return toDraft(redactConfig(serverConfig), skills)
}

/** Assemble a draft from a redacted snapshot plus the full skills. */
function toDraft(
  redacted: ReturnType<typeof redactConfig>,
  skills: SkillConfig[]
): LocalConfigDraft | null {
  if (!redacted) return null
  return {
    llm: redacted.llm,
    mcpServers: redacted.mcpServers,
    systemPrompts: redacted.systemPrompts,
    services: redacted.services,
    skills
  }
}

/**
 * Merge an edited draft with the stored bundle (preserving masked secrets),
 * persist it, and return the fresh bundle for the caller to apply live.
 *
 * A masked secret resolves against the previously-saved LOCAL value first, then
 * the current SERVER config (so a draft seeded from the server keeps working keys
 * even before the user has ever saved a local config), then empty.
 */
export function writeLocalConfigDraft(
  draft: LocalConfigDraft,
  serverConfig: ConfigSnapshot | null
): LocalConfigBundle {
  const prev = loadLocalConfig()
  const skills = draft.skills.map(normalizeSkill)
  const config: ConfigSnapshot = {
    llm: mergeLlm(draft.llm, prev?.config.llm, serverConfig?.llm),
    mcpServers: mergeMcpServers(
      draft.mcpServers,
      prev?.config.mcpServers ?? [],
      serverConfig?.mcpServers ?? []
    ),
    skills: skills.map(toSummary),
    systemPrompts: draft.systemPrompts,
    announcements: [],
    services: mergeServices(
      draft.services,
      prev?.config.services ?? [],
      serverConfig?.services ?? []
    ),
    version: (prev?.config.version ?? 0) + 1
  }
  const bundle: LocalConfigBundle = { config, skills }
  saveLocalConfig(bundle)
  return bundle
}

/* ---------- secret merging (masked → local, else server, else '') ---------- */

/** Resolve a possibly-masked secret against ordered plaintext fallbacks. */
function resolveSecret(value: string, ...fallbacks: (string | undefined)[]): string {
  if (!isMasked(value)) return value
  for (const f of fallbacks) if (f) return f
  return ''
}

function mergeLlm(
  incoming: RoleModels,
  local: RoleModels | undefined,
  server: RoleModels | undefined
): RoleModels {
  return {
    main: mergeActiveLlm(incoming.main, local?.main ?? null, server?.main ?? null),
    tool: mergeActiveLlm(incoming.tool, local?.tool ?? null, server?.tool ?? null),
    visual: mergeActiveLlm(incoming.visual, local?.visual ?? null, server?.visual ?? null)
  }
}

function mergeActiveLlm(
  incoming: ActiveLlm | null,
  local: ActiveLlm | null,
  server: ActiveLlm | null
): ActiveLlm | null {
  if (!incoming) return null
  const credential = resolveSecret(
    incoming.provider.credential,
    local?.provider.credential,
    server?.provider.credential
  )
  return { ...incoming, provider: { ...incoming.provider, credential } }
}

function mergeMcpServers(
  incoming: McpServerConfig[],
  local: McpServerConfig[],
  server: McpServerConfig[]
): McpServerConfig[] {
  const localById = new Map(local.map((s) => [s.id, s]))
  const serverById = new Map(server.map((s) => [s.id, s]))
  return incoming.map((srv) => ({
    ...srv,
    transport: mergeTransport(srv.transport, localById.get(srv.id)?.transport, serverById.get(srv.id)?.transport)
  }))
}

function mergeTransport(
  incoming: McpTransport,
  local: McpTransport | undefined,
  server: McpTransport | undefined
): McpTransport {
  if (incoming.kind === 'stdio') {
    const localEnv = local && local.kind === 'stdio' ? local.env : undefined
    const serverEnv = server && server.kind === 'stdio' ? server.env : undefined
    return { ...incoming, env: mergeSecretMap(incoming.env, localEnv, serverEnv) }
  }
  const localHeaders = local && local.kind === incoming.kind ? local.headers : undefined
  const serverHeaders = server && server.kind === incoming.kind ? server.headers : undefined
  return { ...incoming, headers: mergeSecretMap(incoming.headers, localHeaders, serverHeaders) }
}

/** Keep each masked value from local/server (by key); pass fresh values through. */
function mergeSecretMap(
  incoming: Record<string, string> | undefined,
  local: Record<string, string> | undefined,
  server: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!incoming) return incoming
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    out[key] = resolveSecret(value, local?.[key], server?.[key])
  }
  return out
}

function mergeServices(
  incoming: ServiceConfig[],
  local: ServiceConfig[],
  server: ServiceConfig[]
): ServiceConfig[] {
  const localById = new Map(local.map((s) => [s.id, s]))
  const serverById = new Map(server.map((s) => [s.id, s]))
  return incoming.map((service) => ({
    ...service,
    secret: resolveSecret(service.secret, localById.get(service.id)?.secret, serverById.get(service.id)?.secret)
  }))
}

/* ---------- skill helpers ---------- */

/** Ensure a skill has an id and a fresh `updatedAt`/`fileCount` so it re-materializes. */
function normalizeSkill(skill: SkillConfig): SkillConfig {
  const now = new Date().toISOString()
  return {
    ...skill,
    id: skill.id || randomUUID(),
    createdAt: skill.createdAt || now,
    updatedAt: now,
    fileCount: skill.files.length
  }
}

function toSummary(skill: SkillConfig): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    fileCount: skill.files.length,
    updatedAt: skill.updatedAt
  }
}
