import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { OutputAccumulator } from './output-accumulator'
import { getShellConfig, getShellEnv, killProcessTree, waitForChildProcess } from './shell'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from './truncate'

/**
 * bash — ported from pi-coding-agent (tools/bash.ts + core/bash-executor.ts).
 * Streams stdout/stderr through an OutputAccumulator (bounded memory, tail
 * truncation, temp-file overflow), supports an optional timeout, and kills the
 * whole process group on abort/timeout. Runs in cwd. Requires user approval.
 *
 * pi's TUI-only progress rendering is dropped; partial-output streaming via
 * onUpdate is preserved (harmless if the renderer doesn't consume it yet).
 */

const UPDATE_THROTTLE_MS = 100

export function createBashTool(cwd: string): AgentTool<any> {
  return {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, the full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: 'Bash command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }))
    }),
    executionMode: 'sequential',
    execute: async (_id, { command, timeout }: any, signal, onUpdate) => {
      try {
        await access(cwd, constants.F_OK)
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      }
      if (signal?.aborted) throw new Error('Command aborted')

      const output = new OutputAccumulator({ tempFilePrefix: 'flairy-bash' })
      let updateTimer: NodeJS.Timeout | undefined
      let updateDirty = false
      let lastUpdateAt = 0

      const emitUpdate = (): void => {
        if (!onUpdate || !updateDirty) return
        updateDirty = false
        lastUpdateAt = Date.now()
        const snapshot = output.snapshot({ persistIfTruncated: true })
        onUpdate({ content: [{ type: 'text', text: snapshot.content || '' }], details: {} })
      }
      const clearUpdateTimer = (): void => {
        if (updateTimer) {
          clearTimeout(updateTimer)
          updateTimer = undefined
        }
      }
      const scheduleUpdate = (): void => {
        if (!onUpdate) return
        updateDirty = true
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)
        if (delay <= 0) {
          clearUpdateTimer()
          emitUpdate()
          return
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined
          emitUpdate()
        }, delay)
      }

      const handleData = (data: Buffer): void => {
        output.append(data)
        scheduleUpdate()
      }

      const { shell, args, windowsVerbatimArguments } = getShellConfig(command)
      const child = spawn(shell, args, {
        cwd,
        detached: process.platform !== 'win32',
        env: getShellEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments
      })

      let timedOut = false
      let timeoutHandle: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        if (child.pid) killProcessTree(child.pid)
      }

      const buildResult = (statusSuffix?: string): AgentToolResult<any> => {
        output.finish()
        const snapshot = output.snapshot({ persistIfTruncated: true })
        void output.closeTempFile()
        const truncation = snapshot.truncation
        let text = snapshot.content
        const details: Record<string, unknown> = {}
        if (truncation.truncated) {
          details.truncation = truncation
          details.fullOutputPath = snapshot.fullOutputPath
          const startLine = truncation.totalLines - truncation.outputLines + 1
          const endLine = truncation.totalLines
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes())
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`
          } else if (truncation.truncatedBy === 'lines') {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`
          }
        }
        if (statusSuffix) {
          text = text ? `${text}\n\n${statusSuffix}` : statusSuffix
        }
        return { content: [{ type: 'text', text: text || '(no output)' }], details }
      }

      child.stdout?.on('data', handleData)
      child.stderr?.on('data', handleData)
      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          if (child.pid) killProcessTree(child.pid)
        }, timeout * 1000)
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      let exitCode: number | null
      try {
        exitCode = await waitForChildProcess(child)
      } finally {
        clearUpdateTimer()
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (signal) signal.removeEventListener('abort', onAbort)
      }

      const resultText = (r: AgentToolResult<any>): string => (r.content[0] as { text: string }).text
      if (signal?.aborted) {
        throw new Error(resultText(buildResult('Command aborted')))
      }
      if (timedOut) {
        throw new Error(resultText(buildResult(`Command timed out after ${timeout} seconds`)))
      }
      if (exitCode !== 0 && exitCode !== null) {
        throw new Error(resultText(buildResult(`Command exited with code ${exitCode}`)))
      }
      return buildResult()
    }
  }
}
