import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveToCwd } from './paths'
import { resolveBinary } from './binaries'
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine
} from './truncate'

/**
 * grep — ported from pi-coding-agent (tools/grep.ts). Searches file contents
 * via ripgrep's --json stream, respecting .gitignore.
 *
 * FLAIRY DEVIATION: pi auto-downloads a pinned `rg` binary via its tools-manager.
 * Flairy ships its own `rg` binary per platform (see ./binaries) so it works out
 * of the box for non-technical users. FLAIRY_RG_PATH overrides it. If `rg` is
 * missing the tool throws a clear error.
 */

const DEFAULT_LIMIT = 100

export function createGrepTool(cwd: string): AgentTool<any> {
  return {
    name: 'grep',
    label: 'grep',
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: Type.Object({
      pattern: Type.String({ description: 'Search pattern (regex or literal string)' }),
      path: Type.Optional(
        Type.String({ description: 'Directory or file to search (default: current directory)' })
      ),
      glob: Type.Optional(
        Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })
      ),
      ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
      literal: Type.Optional(
        Type.Boolean({ description: 'Treat pattern as literal string instead of regex (default: false)' })
      ),
      context: Type.Optional(
        Type.Number({ description: 'Number of lines to show before and after each match (default: 0)' })
      ),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of matches to return (default: 100)' }))
    }),
    executionMode: 'parallel',
    execute: (_id, params: any, signal) => {
      const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Operation aborted'))
          return
        }
        let settled = false
        const settle = (fn: () => void): void => {
          if (!settled) {
            settled = true
            fn()
          }
        }

        void (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || '.', cwd)
            let isDirectory: boolean
            try {
              isDirectory = (await fsStat(searchPath)).isDirectory()
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)))
              return
            }

            const contextValue = context && context > 0 ? context : 0
            const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT)
            const formatPath = (filePath: string): string => {
              if (isDirectory) {
                const rel = path.relative(searchPath, filePath)
                if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/')
              }
              return path.basename(filePath)
            }

            const fileCache = new Map<string, string[]>()
            const getFileLines = async (filePath: string): Promise<string[]> => {
              let lines = fileCache.get(filePath)
              if (!lines) {
                try {
                  const content = await fsReadFile(filePath, 'utf-8')
                  lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
                } catch {
                  lines = []
                }
                fileCache.set(filePath, lines)
              }
              return lines
            }

            const rgArgs: string[] = ['--json', '--line-number', '--color=never', '--hidden']
            if (ignoreCase) rgArgs.push('--ignore-case')
            if (literal) rgArgs.push('--fixed-strings')
            if (glob) rgArgs.push('--glob', glob)
            rgArgs.push('--', pattern, searchPath)

            const child = spawn(resolveBinary('rg'), rgArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
            const rl = createInterface({ input: child.stdout })
            let stderr = ''
            let matchCount = 0
            let matchLimitReached = false
            let linesTruncated = false
            let aborted = false
            let killedDueToLimit = false
            const outputLines: string[] = []

            const cleanup = (): void => {
              rl.close()
              signal?.removeEventListener('abort', onAbort)
            }
            const stopChild = (dueToLimit = false): void => {
              if (!child.killed) {
                killedDueToLimit = dueToLimit
                child.kill()
              }
            }
            const onAbort = (): void => {
              aborted = true
              stopChild()
            }
            signal?.addEventListener('abort', onAbort, { once: true })
            child.stderr?.on('data', (chunk) => {
              stderr += chunk.toString()
            })

            const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
              const relativePath = formatPath(filePath)
              const lines = await getFileLines(filePath)
              if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`]
              const block: string[] = []
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber
              const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber
              for (let current = start; current <= end; current++) {
                const sanitized = (lines[current - 1] ?? '').replace(/\r/g, '')
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized)
                if (wasTruncated) linesTruncated = true
                if (current === lineNumber) block.push(`${relativePath}:${current}: ${truncatedText}`)
                else block.push(`${relativePath}-${current}- ${truncatedText}`)
              }
              return block
            }

            const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = []
            rl.on('line', (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) return
              let event: any
              try {
                event = JSON.parse(line)
              } catch {
                return
              }
              if (event.type === 'match') {
                matchCount++
                const filePath = event.data?.path?.text
                const lineNumber = event.data?.line_number
                const lineText = event.data?.lines?.text
                if (filePath && typeof lineNumber === 'number') matches.push({ filePath, lineNumber, lineText })
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true
                  stopChild(true)
                }
              }
            })

            child.on('error', (error) => {
              cleanup()
              const msg =
                (error as NodeJS.ErrnoException).code === 'ENOENT'
                  ? `Bundled ripgrep (rg) binary not found. Set FLAIRY_RG_PATH to override.`
                  : `Failed to run ripgrep: ${error.message}`
              settle(() => reject(new Error(msg)))
            })
            child.on('close', async (code) => {
              cleanup()
              if (aborted) {
                settle(() => reject(new Error('Operation aborted')))
                return
              }
              if (!killedDueToLimit && code !== 0 && code !== 1) {
                settle(() => reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`)))
                return
              }
              if (matchCount === 0) {
                settle(() => resolve({ content: [{ type: 'text', text: 'No matches found' }], details: {} }))
                return
              }

              for (const match of matches) {
                if (contextValue === 0 && match.lineText !== undefined) {
                  const relativePath = formatPath(match.filePath)
                  const sanitized = match.lineText.replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '')
                  const { text: truncatedText, wasTruncated } = truncateLine(sanitized)
                  if (wasTruncated) linesTruncated = true
                  outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`)
                } else {
                  outputLines.push(...(await formatBlock(match.filePath, match.lineNumber)))
                }
              }

              const truncation = truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
              let out = truncation.content
              const details: Record<string, unknown> = {}
              const notices: string[] = []
              if (matchLimitReached) {
                notices.push(
                  `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
                )
                details.matchLimitReached = effectiveLimit
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
                details.truncation = truncation
              }
              if (linesTruncated) {
                notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use the read tool to see full lines`)
                details.linesTruncated = true
              }
              if (notices.length > 0) out += `\n\n[${notices.join('. ')}]`
              settle(() => resolve({ content: [{ type: 'text', text: out }], details }))
            })
          } catch (err) {
            settle(() => reject(err as Error))
          }
        })()
      })
    }
  }
}
