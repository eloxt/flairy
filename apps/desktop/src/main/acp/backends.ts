import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpBackendUpdateArgs, AcpBackendView, AcpConfigOption } from '@shared/ipc'
import { getSetting, setSetting } from '../store/db'

/**
 * Registry of ACP worker backends: external coding agents Flairy can drive over
 * the Agent Client Protocol (JSON-RPC over the child process's stdio). Builtins
 * carry the spawn recipe + how a model choice is injected (env var vs CLI arg —
 * that part can't live in user JSON); the user's ACP settings page contributes
 * per-backend `enabled` / `model` / `command` overrides, stored in the settings
 * KV as JSON keyed by backend id.
 */
export interface WorkerBackend {
  id: string
  label: string
  command: string
  args: string[]
  env?: Record<string, string>
}

interface BuiltinBackend {
  id: string
  label: string
  command: string
  args: string[]
  /** How a chosen model is fed to this agent (env var and/or CLI args). */
  applyModel?: (model: string) => { env?: Record<string, string>; args?: string[] }
  /** Enabled out of the box? Only claude-code, to match the documented MVP path. */
  defaultEnabled: boolean
  modelPlaceholder: string
  /**
   * The underlying agent CLI whose presence on this machine signals "the user
   * has this agent installed" (adapters self-install via npx, so the adapter
   * itself proves nothing — but login/config comes with the agent CLI).
   */
  detectBin: string
}

/**
 * Adapters from the @agentclientprotocol org (the zed-industries packages were
 * renamed/deprecated mid-2026). All self-install via `npx -y` on first run
 * (document a global install as the fast path). Each uses the machine's own
 * agent login/config for LLM access — Flairy never passes credentials to
 * workers. Model injection differs per agent: Claude Code reads
 * ANTHROPIC_MODEL, codex-acp merges CODEX_CONFIG JSON into the session config,
 * gemini-cli takes `-m`.
 */
const BUILTINS: BuiltinBackend[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    applyModel: (m) => ({ env: { ANTHROPIC_MODEL: m } }),
    defaultEnabled: true,
    modelPlaceholder: 'claude-sonnet-5',
    detectBin: 'claude'
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    applyModel: (m) => ({ env: { CODEX_CONFIG: JSON.stringify({ model: m }) } }),
    defaultEnabled: false,
    modelPlaceholder: 'gpt-5.2-codex',
    detectBin: 'codex'
  },
  {
    // Gemini CLI was sunset June 2026 in favor of Antigravity CLI (`agy`),
    // which has no official ACP mode yet (google-antigravity/antigravity-cli#31)
    // — `agy-acp` is the community adapter bridging it, built on the same
    // official ACP SDK. Model choice comes via probed config options only.
    id: 'antigravity',
    label: 'Antigravity',
    command: 'npx',
    args: ['-y', 'agy-acp'],
    defaultEnabled: false,
    modelPlaceholder: 'gemini-3-pro',
    detectBin: 'agy'
  }
]

/**
 * Directories searched when detecting agent CLIs. GUI-launched Electron apps
 * don't get the login-shell PATH, so the env PATH is augmented with the usual
 * install locations (mirrors augmentedPath) plus per-agent conventions like
 * Claude Code's native-install dir.
 */
function detectionDirs(): string[] {
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extras = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), 'n', 'bin'),
    join(homedir(), '.claude', 'local'),
    join(homedir(), '.bun', 'bin')
  ]
  return [...new Set([...fromPath, ...extras])]
}

function binaryExists(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return detectionDirs().some((dir) => exts.some((ext) => existsSync(join(dir, bin + ext))))
}

/**
 * Whether the user has this agent set up on the machine. A command override
 * counts as installed — the user has explicitly pointed us at something.
 */
function isInstalled(b: BuiltinBackend, s: Record<string, BackendSetting>): boolean {
  return Boolean(s[b.id]?.command) || binaryExists(b.detectBin)
}

const SETTING_KEY = 'acp_backends'

interface BackendSetting {
  enabled?: boolean
  model?: string
  /** Full command-line override (whitespace-split; no shell interpretation). */
  command?: string
  /** Chosen ACP config-option values, keyed by option id (absent = agent default). */
  values?: Record<string, string | boolean>
}

/** Cached result of the last config-option probe for one backend. */
interface ProbeCache {
  at: number
  options?: AcpConfigOption[]
  error?: string
}

const PROBE_KEY_PREFIX = 'acp_probe_'

export function readProbeCache(id: string): ProbeCache | undefined {
  const raw = getSetting(PROBE_KEY_PREFIX + id)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as ProbeCache
  } catch {
    return undefined
  }
}

export function writeProbeCache(id: string, cache: ProbeCache): void {
  setSetting(PROBE_KEY_PREFIX + id, JSON.stringify(cache))
}

function readSettings(): Record<string, BackendSetting> {
  const raw = getSetting(SETTING_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    // Legacy shape (pre-settings-page) was an array; discard it.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, BackendSetting>
  } catch {
    return {}
  }
}

function writeSettings(s: Record<string, BackendSetting>): void {
  setSetting(SETTING_KEY, JSON.stringify(s))
}

function isEnabled(b: BuiltinBackend, s: Record<string, BackendSetting>): boolean {
  return s[b.id]?.enabled ?? b.defaultEnabled
}

/** Renderer-facing view of every known backend (for the ACP settings page). */
export function listBackendViews(): AcpBackendView[] {
  const s = readSettings()
  return BUILTINS.map((b) => {
    const probe = readProbeCache(b.id)
    return {
      id: b.id,
      label: b.label,
      enabled: isEnabled(b, s),
      installed: isInstalled(b, s),
      detectBin: b.detectBin,
      model: s[b.id]?.model || undefined,
      modelPlaceholder: b.modelPlaceholder,
      command: s[b.id]?.command || undefined,
      defaultCommand: [b.command, ...b.args].join(' '),
      options: probe?.options,
      values: s[b.id]?.values ?? {},
      probedAt: probe?.at,
      probeError: probe?.error
    }
  })
}

/** Patch one backend's settings; returns the refreshed views. */
export function updateBackend(args: AcpBackendUpdateArgs): AcpBackendView[] {
  if (!BUILTINS.some((b) => b.id === args.id)) {
    throw new Error(`Unknown ACP backend '${args.id}'`)
  }
  const s = readSettings()
  const cur = s[args.id] ?? {}
  if (args.enabled !== undefined) cur.enabled = args.enabled
  if (args.model !== undefined) cur.model = args.model?.trim() || undefined
  if (args.command !== undefined) cur.command = args.command?.trim() || undefined
  if (args.values !== undefined) {
    const values = { ...(cur.values ?? {}) }
    for (const [key, value] of Object.entries(args.values)) {
      if (value === null) delete values[key]
      else values[key] = value
    }
    cur.values = Object.keys(values).length ? values : undefined
  }
  s[args.id] = cur
  writeSettings(s)
  return listBackendViews()
}

/** The user's chosen config-option values for a backend (applied at session start). */
export function getBackendConfigValues(id: string): Record<string, string | boolean> {
  return readSettings()[id]?.values ?? {}
}

/** Resolve a builtin + its user settings into a spawnable backend spec. */
function resolve(b: BuiltinBackend, s: Record<string, BackendSetting>): WorkerBackend {
  const setting = s[b.id]
  let command = b.command
  let args = [...b.args]
  if (setting?.command) {
    const parts = setting.command.split(/\s+/).filter(Boolean)
    command = parts[0] ?? b.command
    args = parts.slice(1)
  }
  let env: Record<string, string> | undefined
  const model = setting?.model?.trim()
  if (model && b.applyModel) {
    const inject = b.applyModel(model)
    if (inject.env) env = inject.env
    if (inject.args) args = [...args, ...inject.args]
  }
  return { id: b.id, label: b.label, command, args, env }
}

/**
 * Spawn spec for the config-option probe: honors the user's command override
 * but skips model injection (the probe wants the agent's own defaults).
 */
export function getProbeSpawnSpec(id: string): WorkerBackend {
  const b = BUILTINS.find((x) => x.id === id)
  if (!b) throw new Error(`Unknown ACP backend '${id}'`)
  const s = readSettings()
  const setting = s[id]
  let command = b.command
  let args = [...b.args]
  if (setting?.command) {
    const parts = setting.command.split(/\s+/).filter(Boolean)
    command = parts[0] ?? b.command
    args = parts.slice(1)
  }
  return { id: b.id, label: b.label, command, args }
}

/** The enabled backends, resolved and in builtin order (first = dispatch default). */
export function listEnabledBackends(): WorkerBackend[] {
  const s = readSettings()
  return BUILTINS.filter((b) => isEnabled(b, s)).map((b) => resolve(b, s))
}

export function getBackend(id?: string): WorkerBackend {
  const enabled = listEnabledBackends()
  if (!id) {
    if (enabled.length === 0) {
      throw new Error(
        'No coding agent is enabled. Ask the user to enable one in Settings → ACP.'
      )
    }
    return enabled[0]
  }
  const found = enabled.find((b) => b.id === id)
  if (!found) {
    const known = BUILTINS.some((b) => b.id === id)
    throw new Error(
      known
        ? `Backend '${id}' is disabled. Ask the user to enable it in Settings → ACP, or use one of: ${enabled.map((b) => b.id).join(', ') || '(none enabled)'}`
        : `Unknown worker backend '${id}'. Available: ${enabled.map((b) => b.id).join(', ')}`
    )
  }
  return found
}

/**
 * GUI-launched Electron apps don't inherit the shell PATH (Finder/Dock on
 * macOS), so `npx`/`node` often won't resolve. Build an augmented PATH with the
 * usual install locations appended; used for the worker child processes.
 */
export function augmentedPath(): string {
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), 'n', 'bin')
  ].filter((p) => existsSync(p))
  const current = process.env.PATH ?? ''
  return [current, ...extra].filter(Boolean).join(delimiter)
}
