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
interface ExaResult extends ExaImageFields {
  title?: string | null
  url?: string | null
  text?: string | null
  highlights?: string[] | null
  favicon?: string | null
  publishedDate?: string | null
}

/** Best preview image for a result: the page's own og:image, else the first in-page image link. */
function imageOf(r: ExaResult): string | undefined {
  const candidates = [
    r.image,
    ...(r.extras?.imageLinks ?? []),
    ...(r.extras?.richImageLinks ?? []).map((l) => l?.url)
  ]
  for (const c of candidates) {
    const url = typeof c === 'string' ? c.trim() : ''
    if (/^https?:\/\//i.test(url)) return url
  }
  return undefined
}

/** Cap the model-facing alt text — it only needs to convey what the image shows. */
const IMAGE_ALT_MAX = 80
/** In-page images carried per result when `withImages` is set. */
export const IMAGES_PER_RESULT = 2

/** The image-bearing fields both Exa endpoints (/search, /contents) return. */
export interface ExaImageFields {
  image?: string | null
  extras?: {
    imageLinks?: string[] | null
    richImageLinks?: { url?: string | null; alt?: string | null }[] | null
  } | null
}

/**
 * Embeddable in-page images for a result (from `extras.richImageLinks`): http(s)
 * only, the page's og:image dropped (it already backs the citation hover card),
 * deduped, alt normalized. Ids are assigned by the caller once totals are known.
 * Shared with web_fetch, whose /contents results carry the same fields.
 */
export function imagesOf(r: ExaImageFields): { url: string; alt: string }[] {
  const og = typeof r.image === 'string' ? r.image.trim() : ''
  const out: { url: string; alt: string }[] = []
  for (const link of r.extras?.richImageLinks ?? []) {
    const url = typeof link?.url === 'string' ? link.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) continue
    if (url === og || out.some((i) => i.url === url)) continue
    const alt =
      typeof link?.alt === 'string'
        ? link.alt.replace(/\s+/g, ' ').trim().slice(0, IMAGE_ALT_MAX)
        : ''
    out.push({ url, alt })
    if (out.length >= IMAGES_PER_RESULT) break
  }
  return out
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
 * footer). Result ids are unique across the whole agent run (turn), not just
 * within one call: `allocateIds` hands each call a fresh, non-overlapping block
 * so a second search in the same turn numbers from where the first left off.
 * That keeps every `[n]` the model writes unambiguous when the renderer merges a
 * turn's searches, and matches the citation instruction in the system prompt.
 *
 * Runs in the main process, so it calls the HTTPS API directly with the
 * server-delivered key; the key never reaches the renderer. Registered as a
 * read-only tool (no approval prompt) since it only reads the public web.
 *
 * `allocateIds(count)` reserves `count` consecutive ids and returns the 0-based
 * start of the block; it advances a per-run counter the caller resets at each
 * new turn. The advance is synchronous, so concurrent `executionMode:'parallel'`
 * searches still get disjoint ranges. Omitted (e.g. in isolation/tests) →
 * numbering falls back to a local 1-based block. `allocateImageIds` is the same
 * discipline for the separate image-id namespace (the `#i<n>` embeds).
 */
export function createWebSearchTool(
  resolve: () => ExaRuntimeConfig | null,
  allocateIds?: (count: number) => number,
  allocateImageIds?: (count: number) => number
): AgentTool<any> {
  return {
    name: 'web_search',
    label: 'web_search',
    description: `Search the web for any topic and get clean, ready-to-use content. Each result carries a numeric "id"; ids are unique across ALL searches in the current turn (a later search continues counting, e.g. its results may be 11, 12, …).
When citing information from search results in your response, cite the EXACT "id" field of the result as an inline citation like [11], or [11,12] for multiple sources. Never renumber results from 1 yourself.
This helps users identify the source of information.

Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
Returns: Clean text content from top search results.

Query tips:
describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
Use the "category" parameter to focus on a content type (news, research paper, github, people…), and "daysBack" for time-sensitive queries where only recent pages are useful.
Each result may carry a "date" (publication date) — weigh it when the topic moves fast, and prefer newer sources for claims about the current state of things.
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
        ),
        withImages: Type.Optional(
          Type.Boolean({
            description:
              'Set true ONLY when the answer would genuinely benefit from showing images inline (charts, diagrams, product shots, artwork). Results then carry an "images" list; embed a valuable one in your answer as ![<alt>](#i<id>) using the exact image id. Default: false.'
          })
        ),
        category: Type.Optional(
          Type.Union(
            [
              Type.Literal('company'),
              Type.Literal('research paper'),
              Type.Literal('news'),
              Type.Literal('pdf'),
              Type.Literal('github'),
              Type.Literal('tweet'),
              Type.Literal('personal site'),
              Type.Literal('linkedin profile'),
              Type.Literal('financial report')
            ],
            {
              description:
                'Focus the search on one content type — e.g. "news" for current events, "research paper" for academic sources, "github" for code, "linkedin profile" for people. Omit for general search.'
            }
          )
        ),
        daysBack: Type.Optional(
          Type.Number({
            description:
              'Only return pages published within the last N days. Use for time-sensitive queries (news, releases, "latest X") where stale results would mislead. Omit for topics where age does not matter.'
          })
        )
      },
      { additionalProperties: false }
    ),
    executionMode: 'parallel',
    execute: async (_id, { query, numResults, withImages, category, daysBack }: any) => {
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
            ...(typeof category === 'string' && category ? { category } : {}),
            ...(typeof daysBack === 'number' && daysBack > 0
              ? {
                  startPublishedDate: new Date(
                    Date.now() - Math.min(Math.floor(daysBack), 3650) * 86_400_000
                  ).toISOString()
                }
              : {}),
            contents: {
              text: { maxCharacters: 800 },
              highlights: true,
              extras: {
                // One image URL per result, surfaced in the citation hover card.
                imageLinks: 1,
                // On demand only (token cost): in-page images with alt text the
                // model can pick from and embed inline. Ask for one more than we
                // keep so an og:image duplicate doesn't eat the whole budget.
                ...(withImages === true ? { richImageLinks: IMAGES_PER_RESULT + 1 } : {})
              }
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
      // Reserve a turn-unique id block so a later search in the same turn doesn't
      // reuse [1], [2], … (which the renderer would conflate when it merges a
      // turn's searches into one citation registry).
      const idStart = allocateIds ? allocateIds(found.length) : 0
      // Image ids live in their own turn-unique namespace (`#i<n>`), allocated in
      // one block per search — same disjoint-range discipline as citation ids.
      const perResultImages = found.map((r) => (withImages === true ? imagesOf(r) : []))
      const imageTotal = perResultImages.reduce((n, imgs) => n + imgs.length, 0)
      let imageId = allocateImageIds ? allocateImageIds(imageTotal) : 0
      const results: SearchResultInput[] = found.map((r, idx) => {
        const url = String(r.url)
        const images = perResultImages[idx].map((img) => ({
          id: ++imageId,
          url: img.url,
          ...(img.alt ? { alt: img.alt } : {})
        }))
        // Date only (no time-of-day): a freshness signal for model + UI at
        // minimal token cost.
        const date =
          typeof r.publishedDate === 'string' && r.publishedDate.trim()
            ? r.publishedDate.trim().slice(0, 10)
            : undefined
        return {
          id: idStart + idx + 1,
          title: (r.title ?? url).replace(/\s+/g, ' ').trim(),
          url,
          snippet: snippetOf(r),
          image: imageOf(r),
          ...(images.length > 0 ? { images } : {}),
          ...(date ? { date } : {})
        }
      })

      return {
        content: [{ type: 'text', text: encodeSearchResults(results) }],
        details: { count: results.length }
      }
    }
  }
}
