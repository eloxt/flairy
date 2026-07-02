import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ExaRuntimeConfig } from './web-search'

/** Cap on returned page text, to bound the context cost of a single fetch. */
const MAX_CHARACTERS = 8000

/** A single result as returned by the Exa `/contents` API (fields we use). */
interface ExaContent {
  url?: string | null
  title?: string | null
  text?: string | null
}

/**
 * web_fetch — retrieve the full, clean text of one web page via Exa `/contents`.
 *
 * The companion to `web_search`: where search returns short highlights across
 * many pages, this reads ONE known URL in depth (after a search, or when the
 * user hands over a link). It returns plain readable text — no citation `[n]`
 * machinery (that stays exclusive to web_search). Numbering/sources are not
 * involved, so the renderer shows the result as ordinary tool text.
 *
 * Runs in the main process, so it calls the HTTPS API directly with the
 * server-delivered key; the key never reaches the renderer. Config is read fresh
 * at execute time (never captured) so a rotated key or a toggled-off service
 * takes effect immediately. Registered as a read-only tool (no approval prompt)
 * since it only reads the public web.
 */
export function createWebFetchTool(resolve: () => ExaRuntimeConfig | null): AgentTool<any> {
  return {
    name: 'web_fetch',
    label: 'web_fetch',
    description: `Read a webpage's full content as clean markdown. Use after web_search_exa when highlights are insufficient or to read any URL.

Best for: Extracting full content from known URLs. Batch multiple URLs in one call.
Returns: Clean text content and metadata from the page(s).`,
    parameters: Type.Object(
      {
        url: Type.String({
          minLength: 1,
          description: 'The absolute http(s) URL of the page to fetch.'
        })
      },
      { additionalProperties: false }
    ),
    executionMode: 'parallel',
    execute: async (_id, { url }: any) => {
      const u = typeof url === 'string' ? url.trim() : ''
      if (!u) throw new Error('web_fetch requires a non-empty "url"')
      let parsed: URL
      try {
        parsed = new URL(u)
      } catch {
        throw new Error(`web_fetch requires a valid absolute URL, got "${u}"`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`web_fetch only supports http(s) URLs, got "${parsed.protocol}"`)
      }

      const cfg = resolve()
      if (!cfg) {
        throw new Error('Web fetch is not configured. Ask an administrator to enable it.')
      }

      let res: Response
      try {
        res = await fetch(`${cfg.baseUrl}/contents`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey
          },
          body: JSON.stringify({
            urls: [u],
            text: { maxCharacters: MAX_CHARACTERS },
            livecrawl: 'fallback'
          })
        })
      } catch (err) {
        throw new Error(`Web fetch request failed: ${(err as Error).message}`)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Web fetch failed (${res.status}): ${body.slice(0, 200)}`)
      }

      const data = (await res.json()) as { results?: ExaContent[] }
      const result = (data.results ?? [])[0]
      const text = (result?.text ?? '').trim()

      if (!text) {
        return {
          content: [{ type: 'text', text: `No readable content found for ${u}.` }],
          details: { url: u, ok: false }
        }
      }

      const title = (result?.title ?? u).replace(/\s+/g, ' ').trim()
      return {
        content: [{ type: 'text', text: `# ${title}\n${u}\n\n${text}` }],
        details: { url: u, chars: text.length }
      }
    }
  }
}
