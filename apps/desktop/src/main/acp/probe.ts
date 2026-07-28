import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { app } from 'electron'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption
} from '@agentclientprotocol/sdk'
import type { AcpBackendView, AcpConfigOption } from '@shared/ipc'
import {
  augmentedPath,
  getProbeSpawnSpec,
  listBackendViews,
  writeProbeCache
} from './backends'

/**
 * Discover what a worker agent lets us configure: launch it briefly against a
 * scratch directory, open a session, and read the `configOptions` it reports
 * (model, effort, mode, …). Results are cached in the settings KV so the ACP
 * settings page renders instantly; the user can re-probe explicitly.
 *
 * Slow on first run — `npx -y` self-installs the adapter. Generous timeout.
 */

const PROBE_TIMEOUT_MS = 120_000

/**
 * Flatten a protocol SessionConfigOption (select values may be grouped) into
 * the renderer-safe shape.
 */
function toConfigOption(o: SessionConfigOption): AcpConfigOption | null {
  if (o.type === 'boolean') {
    return {
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
      type: 'boolean',
      defaultValue: (o as unknown as { currentValue: boolean }).currentValue
    }
  }
  if (o.type === 'select') {
    const raw = o.options as Array<
      | { value: string; name: string; description?: string | null }
      | { group: string; name: string; options: { value: string; name: string; description?: string | null }[] }
    >
    const choices = raw.flatMap((entry) =>
      'group' in entry
        ? entry.options.map((c) => ({
            value: c.value,
            name: `${entry.name} · ${c.name}`,
            description: c.description ?? undefined
          }))
        : [{ value: entry.value, name: entry.name, description: entry.description ?? undefined }]
    )
    return {
      id: o.id,
      name: o.name,
      description: o.description ?? undefined,
      category: o.category ?? undefined,
      type: 'select',
      defaultValue: o.currentValue,
      choices
    }
  }
  return null
}

/** Probe one backend and refresh the cache; always resolves with fresh views. */
export async function probeBackend(id: string): Promise<AcpBackendView[]> {
  const spec = getProbeSpawnSpec(id)
  const cwd = join(app.getPath('userData'), 'acp-probe')
  mkdirSync(cwd, { recursive: true })

  try {
    const options = await new Promise<AcpConfigOption[]>((resolvePromise, rejectPromise) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      const child = spawn(spec.command, spec.args, {
        cwd,
        env: { ...process.env, PATH: augmentedPath() },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const kill = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
      let stderrTail = ''
      child.stderr?.on('data', (b: Buffer) => {
        stderrTail = (stderrTail + b.toString()).slice(-500)
      })
      child.on('error', (err) =>
        settle(() => rejectPromise(new Error(`Failed to launch '${spec.command}': ${err.message}`)))
      )
      child.on('exit', () =>
        settle(() =>
          rejectPromise(
            new Error(`The agent exited before reporting its options.${stderrTail ? ` ${stderrTail.trim()}` : ''}`)
          )
        )
      )
      const timer = setTimeout(() => {
        settle(() => rejectPromise(new Error('Timed out waiting for the agent to start.')))
        kill()
      }, PROBE_TIMEOUT_MS)
      timer.unref()

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      )
      client({ name: 'flairy-probe' })
        // A probe never grants anything; it also never prompts, so this is moot.
        .onRequest(methods.client.session.requestPermission, () => ({
          outcome: { outcome: 'cancelled' as const }
        }))
        .connectWith(stream, async (ctx) => {
          await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
          })
          const session = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] })
          return (session.configOptions ?? [])
            .map(toConfigOption)
            .filter((o): o is AcpConfigOption => o !== null)
        })
        .then((opts) => {
          clearTimeout(timer)
          settle(() => resolvePromise(opts))
          kill()
        })
        .catch((err: unknown) => {
          clearTimeout(timer)
          settle(() =>
            rejectPromise(err instanceof Error ? err : new Error(String(err)))
          )
          kill()
        })
    })
    writeProbeCache(id, { at: Date.now(), options })
  } catch (err) {
    writeProbeCache(id, {
      at: Date.now(),
      error: err instanceof Error ? err.message : String(err)
    })
  }
  return listBackendViews()
}
