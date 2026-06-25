import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createReadTool } from './read'
import { createWriteTool } from './write'
import { createEditTool } from './edit'
import { createBashTool } from './bash'
import { createGrepTool } from './grep'
import { createFindTool } from './find'
import { createLsTool } from './ls'
import { skillsRoot } from '../skill-materializer'

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
 *
 * `web_search` is included: it only reads the public web through the
 * server-configured provider (no local state, no fs/shell), so prompting for it
 * would just nag the user for something inherently safe — matching the
 * always-on, zero-config product model.
 */
export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'web_search'])

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
  // The materialized skills directory lives outside the session cwd (under
  // userData). Expose it to the read-only tools as an extra allowed root so the
  // agent can open SKILL.md (and a skill's scripts/assets) for progressive
  // disclosure, regardless of which working directory the session uses. Mutating
  // tools (write/edit/bash) stay confined to cwd.
  const extraReadRoots = [skillsRoot()]
  return [
    createReadTool(cwd, extraReadRoots),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGrepTool(cwd, extraReadRoots),
    createFindTool(cwd, extraReadRoots),
    createLsTool(cwd, extraReadRoots)
  ]
}
