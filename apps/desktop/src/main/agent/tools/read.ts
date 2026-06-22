import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveToCwd } from './paths'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate'

/**
 * read — ported from pi-coding-agent (tools/read.ts). Text reads support
 * offset/limit and head-truncation with actionable continuation hints.
 *
 * FLAIRY DEVIATIONS:
 * - Paths are confined to cwd (see resolveToCwd).
 * - Images are returned inline as base64 without pi's photon/WASM auto-resize;
 *   files over MAX_INLINE_IMAGE_BYTES are reported as a note instead.
 */

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024

export function createReadTool(cwd: string): AgentTool<any> {
  return {
    name: 'read',
    label: 'read',
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read (relative to the working directory)' }),
      offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' }))
    }),
    executionMode: 'parallel',
    execute: async (_id, { path, offset, limit }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      const absolutePath = resolveToCwd(path, cwd)
      await access(absolutePath, constants.R_OK)

      const mimeType = IMAGE_MIME[extname(absolutePath).toLowerCase()]
      if (mimeType) {
        const buffer = await readFile(absolutePath)
        if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
          return {
            content: [
              {
                type: 'text',
                text: `Read image file [${mimeType}] (${formatSize(buffer.length)})\n[Image omitted: exceeds the ${formatSize(MAX_INLINE_IMAGE_BYTES)} inline limit.]`
              }
            ],
            details: {}
          }
        }
        return {
          content: [
            { type: 'text', text: `Read image file [${mimeType}]` },
            { type: 'image', data: buffer.toString('base64'), mimeType }
          ],
          details: {}
        }
      }

      const buffer = await readFile(absolutePath)
      const textContent = buffer.toString('utf-8')
      const allLines = textContent.split('\n')
      const totalFileLines = allLines.length

      // Convert from 1-indexed input to 0-indexed array access.
      const startLine = offset ? Math.max(0, offset - 1) : 0
      const startLineDisplay = startLine + 1
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`)
      }

      let selectedContent: string
      let userLimitedLines: number | undefined
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length)
        selectedContent = allLines.slice(startLine, endLine).join('\n')
        userLimitedLines = endLine - startLine
      } else {
        selectedContent = allLines.slice(startLine).join('\n')
      }

      const truncation = truncateHead(selectedContent)
      let outputText: string
      let details: Record<string, unknown> = {}
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], 'utf-8'))
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit. Use the bash tool to inspect it, e.g. sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
        details = { truncation }
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1
        const nextOffset = endLineDisplay + 1
        outputText = truncation.content
        if (truncation.truncatedBy === 'lines') {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
        }
        details = { truncation }
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines)
        const nextOffset = startLine + userLimitedLines + 1
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
      } else {
        outputText = truncation.content
      }

      return { content: [{ type: 'text', text: outputText }], details }
    }
  }
}
