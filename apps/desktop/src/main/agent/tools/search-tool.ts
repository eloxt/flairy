import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** Most tools a single search may enable — keeps one vague query from re-enabling the whole catalog. */
const MAX_MATCHES = 8
/** Description clip in the result text — same "first line, enough to route on" budget as the selector. */
const DESC_CLIP = 150

/**
 * Host callbacks injected by agent-service. The tool itself is stateless: the
 * catalog, the enabled set, and the enable side effect all live in the service
 * so this stays consistent with the accumulate-only selection union.
 */
export interface SearchToolHost {
  /** The unfiltered catalog (buildAllTools) — everything the session COULD have. */
  getCatalog(): AgentTool<any>[]
  /** Names currently enabled (buildTools output). */
  getEnabledNames(): Set<string>
  /**
   * Grow the selection union with these catalog names. Returns the names that
   * were actually newly enabled (empty when selection is inactive — i.e. the
   * full catalog is already available).
   */
  enable(names: string[]): string[]
}

/** First description line, clipped — mirrors the selector's catalog format. */
function clipDesc(tool: AgentTool<any>): string {
  return (tool.description ?? '').split('\n')[0].slice(0, DESC_CLIP)
}

/**
 * Keyword match against name + description. Exact (or case-insensitive) name
 * hits rank far above description hits so "github_create_issue" as a query
 * enables exactly that tool first.
 */
function scoreTool(tool: AgentTool<any>, queryLower: string, tokens: string[]): number {
  const name = tool.name.toLowerCase()
  const desc = (tool.description ?? '').toLowerCase()
  let score = 0
  if (name === queryLower) score += 100
  for (const t of tokens) {
    if (name === t) score += 40
    else if (name.includes(t)) score += 10
    if (desc.includes(t)) score += 2
  }
  return score
}

/**
 * search_tool — the escape hatch for automatic tool selection. Selection runs
 * BEFORE a turn and only sees the user's message, so it can miss tools whose
 * need is discovered mid-turn (typically: a SKILL.md read via progressive
 * disclosure tells the agent to call tools that were never selected). This tool
 * lets the agent search the full catalog by keyword and enable the matches;
 * agent-service refreshes the running loop's toolset via
 * prepareNextTurnWithContext, so the tools are callable from the very next step.
 *
 * Approval-exempt (see beforeToolCall): it only changes which tool DEFINITIONS
 * the model sees. Every enabled tool still goes through its own approval gate
 * when actually called, so no privilege is gained by enabling.
 */
export function createSearchToolTool(host: SearchToolHost): AgentTool<any> {
  return {
    name: 'search_tool',
    label: 'search_tool',
    description:
      'Find and enable additional tools. Only a subset of the available tools is active in this session; ' +
      'if a capability you need appears to be missing — for example, a skill\'s instructions reference a tool ' +
      'you do not have — call this with a few keywords describing the capability (e.g. "github create repository issue"). ' +
      'Exact tool names also work. Matching tools are enabled immediately and can be called starting from your next step. ' +
      'Do NOT use this to look for capabilities no tool provides — if a search returns nothing, proceed without it.',
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            'Keywords describing the needed capability, or exact tool names. Space-separated; matched against tool names and descriptions.'
        })
      },
      { additionalProperties: false }
    ),
    execute: async (_id, { query }: any) => {
      const q = String(query ?? '').trim()
      if (!q) throw new Error('search_tool requires a non-empty "query".')
      const queryLower = q.toLowerCase()
      const tokens = queryLower.split(/[^a-z0-9]+/).filter(Boolean)

      const catalog = host.getCatalog()
      const ranked = catalog
        .map((tool) => ({ tool, score: scoreTool(tool, queryLower, tokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_MATCHES)
      if (ranked.length === 0) {
        throw new Error(
          `No tools match "${q}". Try different keywords, or proceed without this capability if no tool provides it.`
        )
      }

      const enabledBefore = host.getEnabledNames()
      const missing = ranked.filter((r) => !enabledBefore.has(r.tool.name)).map((r) => r.tool.name)
      const added = new Set(host.enable(missing))

      const lines = ranked.map(({ tool }) => {
        const status = added.has(tool.name) ? 'now enabled' : 'already enabled'
        return `- ${tool.name} (${status}): ${clipDesc(tool)}`
      })
      const header = added.size
        ? `Enabled ${added.size} tool(s) — callable from your next step.`
        : 'All matching tools were already enabled.'
      return {
        content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
        details: { query: q, matched: ranked.map((r) => r.tool.name), enabled: [...added] }
      }
    }
  }
}
