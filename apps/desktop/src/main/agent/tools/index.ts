import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'
import { createBashTool } from './bash'
import { createGrepTool } from './grep'
import { createFindTool } from './find'
import { createLsTool } from './ls'

export { createReadTool, createWriteTool, createEditTool, createBashTool, createGrepTool, createFindTool, createLsTool }

/**
 * Tools that cannot mutate state and so run without an approval prompt.
 *
 * The approval gate (agent-service.ts) treats this as an ALLOWLIST: every tool
 * NOT listed here is gated. That inversion is deliberate — any unknown tool,
 * including every server-pushed MCP tool, is therefore gated by default. Editing
 * this set is security-sensitive: only genuinely non-mutating tools belong here.
 * (`bash` is intentionally absent: it can run read-only commands, but its
 * arguments are arbitrary, so it must always be confirmed.)
 */
export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

/**
 * Local agent tools, ported from pi-coding-agent's coding toolset and adapted
 * for Flairy (TUI renderer layer stripped, paths confined to cwd, grep→bundled
 * ripgrep, find→bundled fd; see ./binaries). They run in the MAIN process (Node), so they have
 * fs/child_process access.
 *
 * pi-agent-core has NO built-in permission system: the only safety here is
 * (a) confining paths under `cwd` (see ./paths) and (b) the beforeToolCall
 * approval gate in agent-service.ts (see ../approvals). For production, run
 * tools inside a real sandbox (Docker) rather than trusting these checks alone.
 */
export function createTools(cwd: string): AgentTool<any>[] {
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd)
  ]
}
