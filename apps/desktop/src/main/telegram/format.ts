/**
 * Telegram message formatting helpers (main-process only).
 *
 * The agent emits Markdown; Telegram accepts a small HTML subset with strict
 * entity balancing (an unbalanced tag means HTTP 400). We convert conservatively
 * and the caller falls back to plain text on a send error (see TelegramManager).
 */

/** Telegram's hard per-message character cap. */
export const TELEGRAM_MAX_CHARS = 4096

/** Escape the three characters Telegram's HTML parser treats specially. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Convert a Markdown string into the Telegram HTML subset (<b>, <i>, <code>,
 * <pre>, <a>). Conservative by design: code spans are pulled out and protected,
 * everything else is HTML-escaped, then a few inline constructs are re-wrapped.
 * Anything it cannot map is left as escaped text. The caller should still be
 * ready to retry as plain text, since the model can emit nesting this simple
 * pass will not balance.
 */
export function toTelegramHtml(markdown: string): string {
  // Pull fenced code blocks out first (protected by a space-free sentinel) so
  // their contents are untouched by the inline passes; re-insert them as <pre>.
  const codeBlocks: string[] = []
  let working = markdown.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, body: string) => {
    const idx = codeBlocks.push(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`) - 1
    return `@@C${idx}@@`
  })

  // Protect inline code spans the same way.
  const inlineCode: string[] = []
  working = working.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    const idx = inlineCode.push(`<code>${escapeHtml(body)}</code>`) - 1
    return `@@I${idx}@@`
  })

  // Escape the remaining prose, then apply inline emphasis + links. The markers
  // and sentinels are ASCII and survive escaping unchanged.
  working = escapeHtml(working)
  working = working.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, url: string) => `<a href="${url}">${text}</a>`
  )
  working = working.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  working = working.replace(/__([^_\n]+)__/g, '<b>$1</b>')
  working = working.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
  working = working.replace(/(^|[^_])_([^_\n]+)_/g, '$1<i>$2</i>')

  // Re-insert the protected spans.
  working = working.replace(/@@I(\d+)@@/g, (_m, i: string) => inlineCode[Number(i)] ?? '')
  working = working.replace(/@@C(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)] ?? '')
  return working
}

/**
 * Split a (possibly long) message into chunks no larger than `max`, preferring to
 * break on blank-line then newline boundaries so we do not slice through a word
 * or an HTML tag. A <pre> block left open at a chunk boundary is closed and
 * reopened so each chunk stays valid HTML.
 */
export function splitForTelegram(text: string, max: number = TELEGRAM_MAX_CHARS): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  let reopenPre = false
  while (rest.length > 0) {
    let head: string
    if (rest.length <= max) {
      head = rest
      rest = ''
    } else {
      // Prefer the last paragraph break, then the last newline, then a hard cut.
      const window = rest.slice(0, max)
      let cut = window.lastIndexOf('\n\n')
      if (cut < max * 0.5) cut = window.lastIndexOf('\n')
      if (cut < max * 0.5) cut = max
      head = rest.slice(0, cut)
      rest = rest.slice(cut)
    }
    if (reopenPre) head = `<pre>${head}`
    // If this chunk opened more <pre> than it closed, balance it and reopen next.
    const opens = (head.match(/<pre>/g) ?? []).length
    const closes = (head.match(/<\/pre>/g) ?? []).length
    reopenPre = opens > closes
    if (reopenPre) head = `${head}</pre>`
    chunks.push(head)
  }
  return chunks
}
