import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveToCwd } from './paths'
import { withFileMutationQueue } from './file-mutation-queue'

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
        await mkdir(dir, { recursive: true })
        throwIfAborted()
        await writeFile(absolutePath, content, 'utf-8')
        throwIfAborted()
        return {
          content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }],
          details: {}
        }
      })
    }
  }
}
