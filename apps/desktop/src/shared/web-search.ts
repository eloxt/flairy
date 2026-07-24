/**
 * Contract for the built-in `web_search` tool, shared between the main
 * process (which produces results) and the renderer (which renders citations).
 *
 * The tool returns a SINGLE JSON object as its text content — the model reads it
 * directly to reason + cite, and the renderer parses the same text into
 * {@link SearchSource}s. One representation, no duplication. It rides in the tool
 * result's text (not `details`, which pi drops before the renderer and never
 * persists), so citations survive a session reload.
 */

/**
 * An in-page image the model may embed inline as `![alt](#i<id>)`. Ids live in
 * their own turn-unique namespace (separate from citation ids); the renderer's
 * `img` override resolves `#i<id>` against the message's source registry and
 * refuses to load anything else — the registry doubles as the URL allowlist.
 */
export interface SearchImage {
  id: number
  url: string
  alt?: string
}

/** One web-search result as the renderer consumes it (a citation `[n]` target). */
export interface SearchSource {
  /** Citation number, unique across the turn (a later search keeps counting up). */
  i: number
  title: string
  url: string
  /** Host without a leading `www.`, derived from the url for the chip/card label. */
  domain: string
  /** Short excerpt (Exa highlight or text snippet) shown in the hover card. */
  snippet: string
  /** Favicon URL; usually undefined (the renderer derives one from the domain). */
  favicon?: string
  /** Preview image of the page (Exa og:image / imageLinks), shown in the hover card. */
  image?: string
  /** In-page images the model may embed inline (present only for `withImages` searches). */
  images?: SearchImage[]
  /** Publication date (YYYY-MM-DD) when Exa knows it — freshness signal for model and UI. */
  date?: string
}

/** The compact per-result shape the tool serializes (renderer derives the rest). */
export interface SearchResultInput {
  id: number
  title: string
  url: string
  snippet: string
  image?: string
  images?: SearchImage[]
  date?: string
}

/** Marker on the JSON payload, used to recognize our tool's output cheaply. */
const MARKER = 'flairy_web_search'
/** Marker on a web_fetch result's first-line JSON header (page becomes citable). */
const FETCH_MARKER = 'flairy_web_fetch'

/** Serialize results into the JSON text the tool returns. */
export function encodeSearchResults(results: SearchResultInput[]): string {
  const hasImages = results.some((r) => r.images && r.images.length > 0)
  return JSON.stringify({
    type: MARKER,
    instructions:
      'Cite results you use inline by their exact "id" field, e.g. [1] or [1,2] for several. Ids are unique across all searches this turn — a later search continues counting, so never renumber from 1.' +
      (hasImages
        ? ' Some results carry an "images" list. If an image genuinely helps the answer (a chart, diagram, product shot), embed it inline where relevant as ![<alt>](#i<id>) using that image\'s exact "id" — e.g. ![evals chart](#i3). Only reference provided image ids; other image URLs will not render.'
        : ''),
    results
  })
}

/** Host without a leading `www.`; falls back to the raw url if unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Sanitize one serialized result into the renderer-facing {@link SearchSource}. */
function toSource(r: SearchResultInput): SearchSource {
  return {
    i: Number(r.id),
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : r.url,
    url: r.url,
    domain: hostOf(r.url),
    snippet: typeof r.snippet === 'string' ? r.snippet : '',
    image: typeof r.image === 'string' && r.image.trim() ? r.image.trim() : undefined,
    images: Array.isArray(r.images)
      ? r.images.filter(
          (img): img is SearchImage =>
            !!img &&
            Number.isInteger((img as SearchImage).id) &&
            typeof (img as SearchImage).url === 'string' &&
            /^https?:\/\//i.test((img as SearchImage).url)
        )
      : undefined,
    date: typeof r.date === 'string' && r.date.trim() ? r.date.trim() : undefined
  }
}

/**
 * Parse a tool-result text into {@link SearchSource}s, or null if it isn't our
 * web-search JSON. Identified by the `type` marker — robust to the tool's name
 * (built-in or MCP) and never throws. `domain` is derived from each `url` here so
 * it needn't ride in the payload. A cheap substring guard avoids JSON.parse on
 * the (often large) output of unrelated tools.
 */
export function parseSearchResults(text: string | undefined): SearchSource[] | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes(MARKER)) return null
  try {
    const obj = JSON.parse(trimmed) as { type?: string; results?: unknown }
    if (obj.type !== MARKER || !Array.isArray(obj.results)) return null
    return obj.results
      .filter((r): r is SearchResultInput => !!r && typeof (r as SearchResultInput).url === 'string')
      .map(toSource)
  } catch {
    return null
  }
}

/**
 * Serialize a web_fetch result: a single-line JSON header (the page's citation
 * source + a cite-me instruction for the model) followed by the page content.
 * One text serves all three consumers, like the search payload: the model reads
 * the header inline, the renderer splits it off into the source registry, and
 * the whole thing persists/syncs with the message.
 */
export function encodeFetchResult(source: SearchResultInput, content: string): string {
  const header = JSON.stringify({
    type: FETCH_MARKER,
    instructions: `Cite information you use from this page inline as [${source.id}].`,
    source
  })
  return `${header}\n\n${content}`
}

/** Parse a web_fetch text into its source + the header-free page content. */
function parseFetchResult(
  text: string
): { sources: SearchSource[]; display: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.slice(0, 200).includes(FETCH_MARKER)) return null
  const nl = trimmed.indexOf('\n')
  const headerLine = nl === -1 ? trimmed : trimmed.slice(0, nl)
  try {
    const obj = JSON.parse(headerLine) as { type?: string; source?: SearchResultInput }
    if (obj.type !== FETCH_MARKER || typeof obj.source?.url !== 'string') return null
    return {
      sources: [toSource(obj.source)],
      display: nl === -1 ? '' : trimmed.slice(nl).trim()
    }
  } catch {
    return null
  }
}

/**
 * The renderer's single entry point for both web tools: recognize a tool-result
 * text as web_search or web_fetch output and return the citation sources plus a
 * clean display text (sources list / header-free page content). Null for every
 * other tool's output.
 */
export function parseWebToolResult(
  text: string | undefined
): { sources: SearchSource[]; display: string } | null {
  if (!text) return null
  const fetched = parseFetchResult(text)
  if (fetched) return fetched
  const sources = parseSearchResults(text)
  if (sources) return { sources, display: formatSourcesForDisplay(sources) }
  return null
}

/**
 * A clean, human-readable rendering of the sources for the collapsed tool row
 * (so the raw JSON is never shown). Generated from the parsed sources, not the
 * model-facing payload.
 */
export function formatSourcesForDisplay(sources: SearchSource[]): string {
  return sources.map((s) => `[${s.i}] ${s.title}\n${s.url}`).join('\n\n')
}
