import type { ActiveLlm, ConfigSnapshot, McpServerConfig, McpTransport } from '@flairy/shared'
import type { RedactedConfigSnapshot } from '@shared/ipc'

/**
 * Turn the main-process ConfigSnapshot (which holds live secrets) into the
 * renderer-safe RedactedConfigSnapshot. Runs in the main process only — the
 * renderer must never see a plaintext credential (see CLAUDE.md).
 */
export function redactConfig(config: ConfigSnapshot | null): RedactedConfigSnapshot | null {
  if (!config) return null
  return {
    llm: {
      main: redactLlm(config.llm.main),
      tool: redactLlm(config.llm.tool)
    },
    mcpServers: config.mcpServers.map(redactMcpServer),
    skills: config.skills,
    systemPrompts: config.systemPrompts,
    // Default to [] so a pre-announcements cached snapshot redacts cleanly.
    announcements: config.announcements ?? [],
    version: config.version
  }
}

/** Mask the provider credential on a single role's resolved model, or pass null. */
function redactLlm(llm: ActiveLlm | null): ActiveLlm | null {
  if (!llm) return null
  return {
    model: llm.model,
    provider: { ...llm.provider, credential: mask(llm.provider.credential) }
  }
}

/** Mask secret values inside an MCP server's transport (headers / env). */
function redactMcpServer(server: McpServerConfig): McpServerConfig {
  return { ...server, transport: redactTransport(server.transport) }
}

function redactTransport(transport: McpTransport): McpTransport {
  switch (transport.kind) {
    case 'stdio':
      return transport.env
        ? { ...transport, env: maskValues(transport.env) }
        : transport
    case 'sse':
    case 'http':
      return transport.headers
        ? { ...transport, headers: maskValues(transport.headers) }
        : transport
  }
}

function maskValues(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, mask(v)]))
}

/**
 * Mask a secret while keeping it recognizable for debugging: show the last 4
 * characters so an admin can confirm *which* key was delivered without exposing
 * it. Short/empty values are fully masked.
 */
function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `••••${value.slice(-4)}`
}
