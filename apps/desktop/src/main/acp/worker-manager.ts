import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { augmentedPath, type WorkerBackend } from './backends'

/**
 * Supervises external coding agents driven over ACP (Agent Client Protocol,
 * via the official @agentclientprotocol/sdk): one child process per run,
 * JSON-RPC over its stdio, cwd pinned to the run's git worktree. This class
 * owns process lifecycle + the permission policy; everything project-shaped
 * (worktrees, TASK.md, push, PR, reporting back into the session) lives in
 * ./dispatch.
 *
 * Deliberately OUTSIDE AgentManager's eviction machinery — these are not pi
 * sessions. App quit must call disposeAll() (wired in main/index.ts).
 */

export type WorkerOutcome = 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface WorkerResult {
  outcome: WorkerOutcome
  /** The worker's final assistant message (its own summary of what it did). */
  summary: string
  /** Error detail when outcome === 'failed'. */
  error?: string
}

export interface StartWorkerOptions {
  runId: string
  backend: WorkerBackend
  /** The run's isolated git worktree — the child's cwd AND its permission fence. */
  cwd: string
  prompt: string
  /**
   * User-chosen ACP config-option values (model, effort, …) applied via
   * session/set_config_option right after the session opens. Best-effort: an
   * option the agent no longer offers is noted in the tail, not fatal.
   */
  configValues?: Record<string, string | boolean>
  /** Kill the run if it hasn't finished within this window. */
  timeoutMs?: number
  /** Live activity feed (already ring-buffered by the manager). */
  onTail?: (tail: string) => void
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const TAIL_MAX_CHARS = 4_000
const KILL_GRACE_MS = 5_000

interface LiveRun {
  child: ChildProcess
  /** Sends session/cancel; set once the ACP session exists. */
  cancel?: () => void
  cancelled: boolean
  tail: string
}

export class AcpWorkerManager {
  private readonly runs = new Map<string, LiveRun>()

  /** Current live tail for a run (undefined when the run isn't live). */
  tailFor(runId: string): string | undefined {
    return this.runs.get(runId)?.tail
  }

  isLive(runId: string): boolean {
    return this.runs.has(runId)
  }

  /**
   * Spawn the backend and drive one full prompt turn. Resolves (never rejects)
   * with the outcome once the worker finishes, is aborted, times out, or dies.
   */
  async startRun(opts: StartWorkerOptions): Promise<WorkerResult> {
    const backend = opts.backend
    let child: ChildProcess
    try {
      child = spawn(backend.command, backend.args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: augmentedPath(), ...backend.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      return {
        outcome: 'failed',
        summary: '',
        error: `Failed to launch ${backend.label}: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const live: LiveRun = { child, cancelled: false, tail: '' }
    this.runs.set(opts.runId, live)

    const appendTail = (line: string): void => {
      if (!line) return
      live.tail = (live.tail + line).slice(-TAIL_MAX_CHARS)
      opts.onTail?.(live.tail)
    }

    // The worker's own final report. Agents narrate between tool calls, so
    // accumulating every chunk would make the "summary" the full running
    // commentary; instead reset at each tool-call boundary so what remains is
    // the last contiguous message — the closing summary.
    let lastMessage = ''
    let atMessageBoundary = false
    let spawnError: string | undefined
    child.on('error', (err) => {
      spawnError = `Failed to launch '${backend.command}': ${err.message}`
    })
    child.stderr?.on('data', (buf: Buffer) => {
      // Adapters log diagnostics to stderr; keep a taste of it in the tail.
      appendTail(buf.toString())
    })

    const handleUpdate = (params: SessionNotification): void => {
      const u = params.update
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content.type === 'text') {
            if (atMessageBoundary) {
              lastMessage = ''
              atMessageBoundary = false
            }
            lastMessage += u.content.text
            appendTail(u.content.text)
          }
          break
        case 'tool_call':
          atMessageBoundary = true
          appendTail(`\n[tool] ${u.title}\n`)
          break
        case 'tool_call_update':
          if (u.status === 'failed') appendTail(`\n[tool failed] ${u.title ?? u.toolCallId}\n`)
          break
        case 'plan':
          appendTail(`\n[plan] ${u.entries.map((e) => e.content).join(' · ')}\n`)
          break
        default:
          break
      }
    }

    const exited = new Promise<void>((res) => child.once('exit', () => res()))

    try {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      )

      const work = client({ name: 'flairy' })
        .onRequest(
          methods.client.session.requestPermission,
          (ctx): RequestPermissionResponse => {
            const decision = decidePermission(ctx.params, opts.cwd)
            appendTail(
              `\n[permission ${decision.optionId && decision.allow ? 'granted' : 'denied'}] ${ctx.params.toolCall.title ?? ctx.params.toolCall.kind ?? 'tool'}\n`
            )
            if (decision.optionId) {
              return { outcome: { outcome: 'selected', optionId: decision.optionId } }
            }
            return { outcome: { outcome: 'cancelled' } }
          }
        )
        .connectWith(stream, async (ctx): Promise<WorkerResult> => {
          await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
          })
          return await ctx.buildSession(opts.cwd).withSession(async (session) => {
            live.cancel = () => {
              void ctx
                .notify(methods.agent.session.cancel, { sessionId: session.sessionId })
                .catch(() => undefined)
            }
            for (const [configId, value] of Object.entries(opts.configValues ?? {})) {
              try {
                await ctx.request(methods.agent.session.setConfigOption, {
                  sessionId: session.sessionId,
                  configId,
                  ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value })
                })
              } catch (err) {
                appendTail(
                  `\n[config] could not set ${configId}=${String(value)}: ${err instanceof Error ? err.message : String(err)}\n`
                )
              }
            }
            // The stop arrives through the update loop; prompt() resolving is
            // redundant with that, so its rejection alone must not crash us.
            void session.prompt(opts.prompt).catch(() => undefined)
            for (;;) {
              const message = await session.nextUpdate()
              if (message.kind === 'stop') {
                const stopReason = message.stopReason
                if (stopReason === 'cancelled') {
                  return { outcome: 'cancelled', summary: lastMessage.trim() }
                }
                if (stopReason === 'refusal') {
                  return {
                    outcome: 'failed',
                    summary: lastMessage.trim(),
                    error: 'The worker refused the task.'
                  }
                }
                return { outcome: 'completed', summary: lastMessage.trim() }
              }
              handleUpdate(message.notification)
            }
          })
        })

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let timer: NodeJS.Timeout | undefined
      const timedOut = new Promise<WorkerResult>((res) => {
        timer = setTimeout(() => {
          res({
            outcome: 'timeout',
            summary: lastMessage.trim(),
            error: `Worker exceeded the ${Math.round(timeoutMs / 60_000)}min time limit.`
          })
        }, timeoutMs)
        timer.unref()
      })
      // A child that dies mid-turn leaves the update loop hanging on a dead
      // stream — treat process exit as failure.
      const died = exited.then(
        (): WorkerResult => ({
          outcome: live.cancelled ? 'cancelled' : 'failed',
          summary: lastMessage.trim(),
          error: spawnError ?? 'The worker process exited unexpectedly.'
        })
      )

      const result = await Promise.race([work, timedOut, died])
      if (timer) clearTimeout(timer)
      if (live.cancelled && result.outcome !== 'cancelled') {
        return { outcome: 'cancelled', summary: result.summary }
      }
      return result
    } catch (err) {
      return {
        outcome: live.cancelled ? 'cancelled' : 'failed',
        summary: lastMessage.trim(),
        error: spawnError ?? (err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.runs.delete(opts.runId)
      this.terminate(live)
    }
  }

  /** Abort a live run: polite session/cancel first, SIGKILL after a grace window. */
  abortRun(runId: string): boolean {
    const live = this.runs.get(runId)
    if (!live) return false
    live.cancelled = true
    live.cancel?.()
    setTimeout(() => this.terminate(live), KILL_GRACE_MS).unref()
    return true
  }

  /** Kill every live worker (app quit). */
  disposeAll(): void {
    for (const live of this.runs.values()) {
      live.cancelled = true
      this.terminate(live)
    }
    this.runs.clear()
  }

  private terminate(live: LiveRun): void {
    if (live.child.exitCode !== null || live.child.signalCode !== null) return
    live.child.kill('SIGTERM')
    setTimeout(() => {
      if (live.child.exitCode === null && live.child.signalCode === null) {
        live.child.kill('SIGKILL')
      }
    }, KILL_GRACE_MS).unref()
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Standing permission policy for unattended workers (user-approved design):
 * anything whose effect stays inside the run's worktree is allowed — reads,
 * edits, and command execution (the worker builds/tests there). Network-ish
 * tools ('fetch') and anything of unknown shape are denied; TASK.md separately
 * forbids touching remotes, and the worker never holds credentials anyway.
 * Option shapes differ per agent, so options are matched by `kind`.
 */
function decidePermission(
  params: RequestPermissionRequest,
  worktree: string
): { allow: boolean; optionId?: string } {
  const kind = params.toolCall.kind ?? 'other'
  const locations = params.toolCall.locations ?? []
  const locationsOk = locations.every((l) => isInside(worktree, l.path))
  const SAFE_KINDS = new Set(['read', 'search', 'think', 'edit', 'delete', 'move', 'execute'])
  const allow = SAFE_KINDS.has(kind) && locationsOk

  const pick = (kinds: PermissionOption['kind'][]): string | undefined => {
    for (const k of kinds) {
      const opt = params.options.find((o) => o.kind === k)
      if (opt) return opt.optionId
    }
    return undefined
  }

  if (allow) {
    const optionId = pick(['allow_once', 'allow_always'])
    if (optionId) return { allow: true, optionId }
    return { allow: false } // no allow option offered → treat as denial
  }
  const optionId = pick(['reject_once', 'reject_always'])
  return { allow: false, optionId }
}
