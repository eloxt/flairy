import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { imagesOf, IMAGES_PER_RESULT, type ExaImageFields, type ExaRuntimeConfig } from './web-search'
import { encodeFetchResult, type SearchResultInput } from '@shared/web-search'

/** Cap on returned page text, to bound the context cost of a single fetch. */
const MAX_CHARACTERS = 8000

/** A single result as returned by the Exa `/contents` API (fields we use). */
interface ExaContent extends ExaImageFields {
  url?: string | null
  title?: string | null
  text?: string | null
  publishedDate?: string | null
}

/**
 * web_fetch — retrieve the full, clean text of one web page via Exa `/contents`.
 *
 * The companion to `web_search`: where search returns short highlights across
 * many pages, this reads ONE known URL in depth (after a search, or when the
 * user hands over a link). The fetched page gets a citation id from the SAME
 * turn-unique namespace as search results (`allocateIds` is the same allocator
 * agent-service hands to web_search), carried in a first-line JSON header — so
 * the common "search → fetch the best hit → answer from the full text" flow can
 * cite the page it actually drew on, not just the search snippets.
 *
 * Runs in the main process, so it calls the HTTPS API directly with the
 * server-delivered key; the key never reaches the renderer. Config is read fresh
 * at execute time (never captured) so a rotated key or a toggled-off service
 * takes effect immediately. Registered as a read-only tool (no approval prompt)
 * since it only reads the public web.
 */
export function createWebFetchTool(
  resolve: () => ExaRuntimeConfig | null,
  allocateIds?: (count: number) => number,
  allocateImageIds?: (count: number) => number
): AgentTool<any> {
  return {
    name: 'web_fetch',
    label: 'web_fetch',
    description: `Read a webpage's full content as clean markdown. Use after web_search when highlights are insufficient or to read any URL.
The result's first line assigns the page a citation id — cite information you use from it inline as [<id>], same as search-result citations.

Best for: Extracting full content from known URLs.
Returns: Clean text content and metadata from the page.`,
    parameters: Type.Object(
      {
        url: Type.String({
          minLength: 1,
          description: 'The absolute http(s) URL of the page to fetch.'
        }),
        withImages: Type.Optional(
          Type.Boolean({
            description:
              'Set true ONLY when the answer would genuinely benefit from showing this page\'s images inline (charts, diagrams, product shots, artwork). The result then carries an "images" list; embed a valuable one in your answer as ![<alt>](#i<id>) using the exact image id. Default: false.'
          })
        )
      },
      { additionalProperties: false }
    ),
    executionMode: 'parallel',
    execute: async (_id, { url, withImages }: any) => {
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
            // On demand only (token cost): the page's images with alt text the
            // model can pick from and embed inline. Ask for one more than we
            // keep so an og:image duplicate doesn't eat the whole budget.
            ...(withImages === true
              ? { extras: { richImageLinks: IMAGES_PER_RESULT + 1 } }
              : {})
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
      const date =
        typeof result?.publishedDate === 'string' && result.publishedDate.trim()
          ? result.publishedDate.trim().slice(0, 10)
          : undefined
      // Same og-image preview + embeddable-images treatment as a search result:
      // `image` backs the citation hover card; `images` (withImages only) get
      // ids from the shared turn-unique image namespace.
      const ogImage =
        typeof result?.image === 'string' && /^https?:\/\//i.test(result.image.trim())
          ? result.image.trim()
          : undefined
      const pageImages = withImages === true && result ? imagesOf(result) : []
      let imageId = allocateImageIds ? allocateImageIds(pageImages.length) : 0
      const images = pageImages.map((img) => ({
        id: ++imageId,
        url: img.url,
        ...(img.alt ? { alt: img.alt } : {})
      }))
      // Reserve one id from the shared citation namespace and ship the page as a
      // citable source: header line for model + renderer, content below it.
      const source: SearchResultInput = {
        id: (allocateIds ? allocateIds(1) : 0) + 1,
        title,
        url: u,
        snippet: text.replace(/\s+/g, ' ').slice(0, 200),
        ...(date ? { date } : {}),
        ...(ogImage ? { image: ogImage } : {}),
        ...(images.length > 0 ? { images } : {})
      }
      return {
        content: [
          { type: 'text', text: encodeFetchResult(source, `# ${title}\n${u}\n\n${text}`) }
        ],
        details: { url: u, chars: text.length }
      }
    }
  }
}
