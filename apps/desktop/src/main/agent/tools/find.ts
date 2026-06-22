import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { pathExists, resolveToCwd } from './paths'
import { resolveBinary } from './binaries'
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from './truncate'

/**
 * find — ported from pi-coding-agent (tools/find.ts), backed by the bundled `fd`
 * binary (see ./binaries) so it works out of the box for non-technical users.
 * FLAIRY_FD_PATH overrides the binary.
 *
 * FLAIRY DEVIATIONS FROM pi: pi downloads `fd` via its tools-manager
 * (ensureTool); Flairy ships it. The TUI render layer and the pluggable
 * FindOperations/SSH abstraction are dropped. The fd execution is otherwise a
 * faithful copy: respects .gitignore (--no-require-git), caps via --max-results,
 * no sorting, paths relativized against the (absolute) search root.
 */

const DEFAULT_LIMIT = 1000

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

export function createFindTool(cwd: string): AgentTool<any> {
  return {
    name: 'find',
    label: 'find',
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
      }),
      path: Type.Optional(Type.String({ description: 'Directory to search in (default: current directory)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of results (default: 1000)' }))
    }),
    executionMode: 'parallel',
    execute: (_toolCallId, { pattern, path: searchDir, limit }: any, signal) => {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Operation aborted'))
          return
        }

        let settled = false
        let stopChild: (() => void) | undefined
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          stopChild = undefined
          fn()
        }
        const onAbort = (): void => {
          stopChild?.()
          settle(() => reject(new Error('Operation aborted')))
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        void (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || '.', cwd)
            const effectiveLimit = limit ?? DEFAULT_LIMIT

            if (!(await pathExists(searchPath))) {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)))
              return
            }
            if (signal?.aborted) {
              settle(() => reject(new Error('Operation aborted')))
              return
            }

            // Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore
            // semantics whether or not the search path is inside a git repository, without
            // leaking sibling-directory rules the way --ignore-file (a global source) would.
            const args: string[] = [
              '--glob',
              '--color=never',
              '--hidden',
              '--no-require-git',
              '--max-results',
              String(effectiveLimit)
            ]

            // fd --glob matches against the basename unless --full-path is set; in --full-path
            // mode it matches against the absolute candidate path, so a path-containing
            // pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
            let effectivePattern = pattern
            if (pattern.includes('/')) {
              args.push('--full-path')
              if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') {
                effectivePattern = `**/${pattern}`
              }
            }
            args.push('--', effectivePattern, searchPath)

            const child = spawn(resolveBinary('fd'), args, { stdio: ['ignore', 'pipe', 'pipe'] })
            const rl = createInterface({ input: child.stdout })
            let stderr = ''
            const lines: string[] = []

            stopChild = (): void => {
              if (!child.killed) child.kill()
            }
            const cleanup = (): void => {
              rl.close()
            }

            child.stderr?.on('data', (chunk) => {
              stderr += chunk.toString()
            })
            rl.on('line', (line) => {
              lines.push(line)
            })

            child.on('error', (error) => {
              cleanup()
              const msg =
                (error as NodeJS.ErrnoException).code === 'ENOENT'
                  ? `Bundled fd binary not found. Set FLAIRY_FD_PATH to override.`
                  : `Failed to run fd: ${error.message}`
              settle(() => reject(new Error(msg)))
            })

            child.on('close', (code) => {
              cleanup()
              if (signal?.aborted) {
                settle(() => reject(new Error('Operation aborted')))
                return
              }
              const output = lines.join('\n')
              if (code !== 0) {
                const errorMsg = stderr.trim() || `fd exited with code ${code}`
                if (!output) {
                  settle(() => reject(new Error(errorMsg)))
                  return
                }
              }
              if (!output) {
                settle(() => resolve({ content: [{ type: 'text', text: 'No files found matching pattern' }], details: {} }))
                return
              }

              const relativized: string[] = []
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, '').trim()
                if (!line) continue
                const hadTrailingSlash = line.endsWith('/') || line.endsWith('\\')
                let relativePath = line
                if (line.startsWith(searchPath)) {
                  relativePath = line.slice(searchPath.length + 1)
                } else {
                  relativePath = path.relative(searchPath, line)
                }
                if (hadTrailingSlash && !relativePath.endsWith('/')) relativePath += '/'
                relativized.push(toPosixPath(relativePath))
              }

              const resultLimitReached = relativized.length >= effectiveLimit
              const rawOutput = relativized.join('\n')
              const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })
              let resultOutput = truncation.content
              const details: Record<string, unknown> = {}
              const notices: string[] = []
              if (resultLimitReached) {
                notices.push(
                  `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`
                )
                details.resultLimitReached = effectiveLimit
              }
              if (truncation.truncated) {
                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
                details.truncation = truncation
              }
              if (notices.length > 0) {
                resultOutput += `\n\n[${notices.join('. ')}]`
              }
              settle(() => resolve({ content: [{ type: 'text', text: resultOutput }], details }))
            })
          } catch (e) {
            if (signal?.aborted) {
              settle(() => reject(new Error('Operation aborted')))
              return
            }
            settle(() => reject(e instanceof Error ? e : new Error(String(e))))
          }
        })()
      })
    }
  }
}
