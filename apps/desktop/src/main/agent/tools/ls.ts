import { readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import nodePath from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { pathExists, resolveToCwd } from './paths'
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate'

/**
 * ls — ported from pi-coding-agent (tools/ls.ts). Lists directory entries
 * sorted alphabetically with a '/' suffix for directories. Paths confined to cwd.
 */

const DEFAULT_LIMIT = 500

export function createLsTool(cwd: string): AgentTool<any> {
  return {
    name: 'ls',
    label: 'ls',
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Directory to list (default: current directory)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' }))
    }),
    executionMode: 'parallel',
    execute: async (_id, { path, limit }: any, signal) => {
      if (signal?.aborted) throw new Error('Operation aborted')
      const dirPath = resolveToCwd(path || '.', cwd)
      const effectiveLimit = limit ?? DEFAULT_LIMIT

      if (!(await pathExists(dirPath))) {
        throw new Error(`Path not found: ${dirPath}`)
      }
      const stat = await fsStat(dirPath)
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`)
      }

      let entries: string[]
      try {
        entries = await fsReaddir(dirPath)
      } catch (e: any) {
        throw new Error(`Cannot read directory: ${e.message}`)
      }

      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))

      const results: string[] = []
      let entryLimitReached = false
      for (const entry of entries) {
        if (results.length >= effectiveLimit) {
          entryLimitReached = true
          break
        }
        let suffix = ''
        try {
          if ((await fsStat(nodePath.join(dirPath, entry))).isDirectory()) suffix = '/'
        } catch {
          continue
        }
        results.push(entry + suffix)
      }

      if (results.length === 0) {
        return { content: [{ type: 'text', text: '(empty directory)' }], details: {} }
      }

      const truncation = truncateHead(results.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
      let output = truncation.content
      const details: Record<string, unknown> = {}
      const notices: string[] = []
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`)
        details.entryLimitReached = effectiveLimit
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
        details.truncation = truncation
      }
      if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`

      return { content: [{ type: 'text', text: output }], details }
    }
  }
}
