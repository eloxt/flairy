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

/** One web-search result as the renderer consumes it (a citation `[n]` target). */
export interface SearchSource {
  /** 1-based index within THIS search (numbering restarts per search). */
  i: number
  title: string
  url: string
  /** Host without a leading `www.`, derived from the url for the chip/card label. */
  domain: string
  /** Short excerpt (Exa highlight or text snippet) shown in the hover card. */
  snippet: string
  /** Favicon URL; usually undefined (the renderer derives one from the domain). */
  favicon?: string
}

/** The compact per-result shape the tool serializes (renderer derives the rest). */
export interface SearchResultInput {
  id: number
  title: string
  url: string
  snippet: string
}

/** Marker on the JSON payload, used to recognize our tool's output cheaply. */
const MARKER = 'flairy_web_search'

/** Serialize results into the JSON text the tool returns. */
export function encodeSearchResults(results: SearchResultInput[]): string {
  return JSON.stringify({
    type: MARKER,
    instructions: 'Cite results you use inline as [id], e.g. [1] or [1,2] for several.',
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
      .map((r) => ({
        i: Number(r.id),
        title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : r.url,
        url: r.url,
        domain: hostOf(r.url),
        snippet: typeof r.snippet === 'string' ? r.snippet : ''
      }))
  } catch {
    return null
  }
}

/**
 * A clean, human-readable rendering of the sources for the collapsed tool row
 * (so the raw JSON is never shown). Generated from the parsed sources, not the
 * model-facing payload.
 */
export function formatSourcesForDisplay(sources: SearchSource[]): string {
  return sources.map((s) => `[${s.i}] ${s.title}\n${s.url}`).join('\n\n')
}
