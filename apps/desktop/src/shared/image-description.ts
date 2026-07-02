/**
 * Contract for the `visual`-role image-description injection, shared between the
 * main process (which produces it) and the renderer (which strips it).
 *
 * When the main model does not accept image input, the main process runs the
 * server-assigned `visual` model over a message's image attachments and appends
 * the extracted description as an EXTRA TEXT PART on the same user message,
 * wrapped in this sentinel block. The image parts stay on the message untouched:
 * pi strips them from the LLM request for a text-only model (leaving the
 * description as the model's view of the images), while the renderer keeps
 * rendering the original thumbnails — and must strip this block from the
 * bubble's text so the user never sees the injected description. Riding on the
 * message (not a side channel) means it survives persistence, replay, and
 * multi-device sync unchanged.
 */

const OPEN = '<flairy:image-descriptions>'
const CLOSE = '</flairy:image-descriptions>'

/**
 * Wrap an extracted description into the sentinel text part appended to the
 * user message. The preamble tells the main model what the block is, since it
 * only sees pi's "(image omitted)" note in place of the actual images.
 */
export function encodeImageDescriptions(description: string): string {
  return (
    `${OPEN}\n` +
    `The user attached image(s) that you cannot view directly. ` +
    `A vision model extracted the following description of them:\n` +
    `${description}\n${CLOSE}`
  )
}

/**
 * Remove any sentinel block(s) from a user message's flattened text, so the
 * renderer's bubble shows only what the user actually typed. Cheap substring
 * guard first — almost every message has no block. Never throws; an unclosed
 * block (should not happen) is left in place rather than over-deleting.
 */
export function stripImageDescriptions(text: string): string {
  if (!text.includes(OPEN)) return text
  let out = text
  for (;;) {
    const start = out.indexOf(OPEN)
    if (start === -1) break
    const end = out.indexOf(CLOSE, start)
    if (end === -1) break
    out = out.slice(0, start) + out.slice(end + CLOSE.length)
  }
  return out.trimEnd()
}
