import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ConfigSnapshot } from '@flairy/shared'
import { encodeSearchResults, type SearchResultInput } from '@shared/web-search'

/** Resolved, ready-to-use Exa config pulled from the active service row. */
export interface ExaRuntimeConfig {
  apiKey: string
  baseUrl: string
  numResults: number
}

const DEFAULT_BASE_URL = 'https://api.exa.ai'
const DEFAULT_NUM_RESULTS = 10

/**
 * Resolve the active Exa web-search service from the server-pushed config, or
 * null when none is configured/enabled. Read fresh at execute time (never
 * captured) so a rotated key or a toggled-off service takes effect immediately —
 * the same discipline as the LLM `getApiKey` resolver in agent-service.ts.
 */
export function resolveExaService(config: ConfigSnapshot | null): ExaRuntimeConfig | null {
  const svc = config?.services?.find((s) => s.kind === 'exa' && s.enabled)
  if (!svc) return null
  const apiKey = svc.secret?.trim()
  if (!apiKey) return null
  const settings = (svc.settings ?? {}) as { numResults?: unknown; baseUrl?: unknown }
  const numResults =
    typeof settings.numResults === 'number' && settings.numResults > 0
      ? Math.min(Math.floor(settings.numResults), 25)
      : DEFAULT_NUM_RESULTS
  const baseUrl =
    typeof settings.baseUrl === 'string' && settings.baseUrl.trim()
      ? settings.baseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_BASE_URL
  return { apiKey, baseUrl, numResults }
}

/** A single result as returned by the Exa `/search` API (fields we use). */
interface ExaResult {
  title?: string | null
  url?: string | null
  text?: string | null
  highlights?: string[] | null
  favicon?: string | null
  publishedDate?: string | null
}

/** Best short snippet for a result: prefer Exa highlights, fall back to text. */
function snippetOf(r: ExaResult): string {
  const fromHighlights = (r.highlights ?? []).join(' … ').replace(/\s+/g, ' ').trim()
  if (fromHighlights) return fromHighlights
  const text = (r.text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 280 ? `${text.slice(0, 280)}…` : text
}

/**
 * web_search — let the agent search the live web via Exa and cite sources.
 *
 * Replaces the old Exa MCP server (which returned opaque markdown): by calling
 * the API directly we own the result shape, so we can return BOTH a readable
 * numbered list (for the model to reason over + cite) AND a machine-readable
 * sentinel block (for the renderer to turn into citation chips + a Sources
 * footer). Numbering restarts at 1 each call (per-search), matching the citation
 * instruction injected into the system prompt.
 *
 * Runs in the main process, so it calls the HTTPS API directly with the
 * server-delivered key; the key never reaches the renderer. Registered as a
 * read-only tool (no approval prompt) since it only reads the public web.
 */
export function createWebSearchTool(resolve: () => ExaRuntimeConfig | null): AgentTool<any> {
  return {
    name: 'web_search',
    label: 'web_search',
    description: `Search the web for any topic and get clean, ready-to-use content. Each result is numbered [1], [2], etc.
      When citing information from search results in your response, use these numbers as inline citations like [1], [2], or [1,2] for multiple sources.
      This helps users identify the source of information.

      Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
      Returns: Clean text content from top search results.

      Query tips:
      describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
      Use category:people / category:company to search through Linkedin profiles / companies respectively.
      If highlights are insufficient, follow up with web_fetch on the best URLs.`,
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          description:
            "Natural language search query. Should be a semantically rich description of the ideal page, not just keywords. Optionally include category:<type> (company, people) to focus results — e.g. 'category:people John Doe software engineer'."
        }),
        numResults: Type.Optional(
          Type.Number({
            description: 'Number of search results to return (default: 10).'
          })
        )
      },
      { additionalProperties: false }
    ),
    executionMode: 'parallel',
    execute: async (_id, { query, numResults }: any) => {
      const q = typeof query === 'string' ? query.trim() : ''
      if (!q) throw new Error('web_search requires a non-empty "query"')

      const cfg = resolve()
      if (!cfg) {
        throw new Error('Web search is not configured. Ask an administrator to enable it.')
      }

      const count =
        typeof numResults === 'number' && numResults > 0
          ? Math.min(Math.floor(numResults), 25)
          : cfg.numResults

      let res: Response
      try {
        res = await fetch(`${cfg.baseUrl}/search`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey
          },
          body: JSON.stringify({
            query: q,
            numResults: count,
            type: 'auto',
            contents: {
              text: { maxCharacters: 800 },
              highlights: { numSentences: 2, highlightsPerUrl: 2 }
            }
          })
        })
      } catch (err) {
        throw new Error(`Web search request failed: ${(err as Error).message}`)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Web search failed (${res.status}): ${body.slice(0, 200)}`)
      }

      const data = (await res.json()) as { results?: ExaResult[] }
      const found = (data.results ?? []).filter((r) => r.url)

      if (found.length === 0) {
        return {
          content: [{ type: 'text', text: `No web results found for "${q}".` }],
          details: { count: 0 }
        }
      }

      // Compact, model-facing JSON — the renderer parses the SAME text and derives
      // domain/favicon from each url, so neither rides in the payload (no
      // duplicated readable list, half the context cost of the old format).
      const results: SearchResultInput[] = found.map((r, idx) => {
        const url = String(r.url)
        return {
          id: idx + 1,
          title: (r.title ?? url).replace(/\s+/g, ' ').trim(),
          url,
          snippet: snippetOf(r)
        }
      })

      return {
        content: [{ type: 'text', text: encodeSearchResults(results) }],
        details: { count: results.length }
      }
    }
  }
}
