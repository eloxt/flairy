import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveToCwd } from './paths'
import { withFileMutationQueue } from './file-mutation-queue'
import { generateUnifiedPatch } from './edit-diff'

/**
 * The diff attached to a write's result is display-only, but it rides the
 * persisted message blob and the device-sync payload — cap what qualifies so a
 * multi-MB generated file doesn't balloon both. Binary originals are skipped
 * too (a UTF-8 decode of arbitrary bytes diffs as garbage).
 */
const MAX_DIFF_SOURCE_BYTES = 512 * 1024

/**
 * write — ported from pi-coding-agent (tools/write.ts). Creates parent
 * directories, overwrites existing files, and serializes concurrent writes to
 * the same file via the mutation queue. Paths are confined to cwd. Requires
 * user approval (see approvals.ts).
 */
export function createWriteTool(cwd: string): AgentTool<any> {
  return {
    name: 'write',
    label: 'write',
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write (relative to the working directory)' }),
      content: Type.String({ description: 'Content to write to the file' })
    }),
    executionMode: 'sequential',
    execute: async (_id, { path, content }: any, signal) => {
      const absolutePath = resolveToCwd(path, cwd)
      const dir = dirname(absolutePath)
      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error('Operation aborted')
        }
        throwIfAborted()
        // Snapshot the existing content (if any) before overwriting so the
        // result can carry a unified patch for the renderer's diff view. A
        // missing file is a brand-new file — diff against empty content. A
        // binary or oversized original disables the diff (null), not the write.
        let oldContent: string | null = ''
        try {
          const buf = await readFile(absolutePath)
          oldContent =
            buf.length > MAX_DIFF_SOURCE_BYTES || buf.includes(0) ? null : buf.toString('utf-8')
        } catch {
          /* new file — no prior content */
        }
        throwIfAborted()
        await mkdir(dir, { recursive: true })
        throwIfAborted()
        await writeFile(absolutePath, content, 'utf-8')
        throwIfAborted()
        // No patch for undiffable originals, oversized new content, or a no-op
        // rewrite (identical content would yield a header-only patch that the
        // renderer would show as an empty diff pane).
        const patch =
          oldContent !== null && oldContent !== content && content.length <= MAX_DIFF_SOURCE_BYTES
            ? generateUnifiedPatch(path, oldContent, content)
            : undefined
        return {
          content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }],
          details: patch ? { patch } : {}
        }
      })
    }
  }
}
