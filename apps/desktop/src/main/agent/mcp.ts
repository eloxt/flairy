import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { McpServerConfig, McpTransport } from '@flairy/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * MCP integration for the desktop client.
 *
 * pi-agent-core ships NO MCP support — its design (and the pi-coding-agent docs)
 * deliberately leaves remote tool servers to the host app. So `McpManager` is the
 * client side of Flairy's config-delivery model: the server pushes a list of
 * `McpServerConfig`s, and this manager connects to each enabled one, lists its
 * tools, and adapts every remote tool into a pi `AgentTool` injected into the
 * agent's tool set (agent-service.ts).
 *
 * ARCHITECTURE — one process-level singleton, NOT one per session:
 * - MCP servers are global, server-pushed config; a stdio server should be a
 *   single child process, not re-spawned for every open chat. So the manager is
 *   shared across all AgentServices and owns the connection lifecycle.
 * - It reconciles against `config.mcpServers` on every snapshot/delta (driven by
 *   ServerClient.onConfig). Connections are keyed by server id and fingerprinted;
 *   unchanged servers are left untouched, changed/removed ones are torn down,
 *   new ones are connected.
 * - getTools() is a synchronous snapshot of the currently-connected tools.
 *   onToolsChanged() lets live AgentServices re-inject the set once an async
 *   connection completes (or drops).
 *
 * SECURITY: every MCP tool is unknown to the read-only allowlist (tools/index.ts),
 * so it is gated by the approval prompt by default — see agent-service.ts.
 */

const CLIENT_INFO = { name: 'flairy', version: '0.1.0' }
/** Per-call timeout for a remote tool invocation. */
const CALL_TIMEOUT_MS = 120_000
/** How long to wait for connect()+listTools() before giving up on a server. */
const CONNECT_TIMEOUT_MS = 20_000

type Listener = () => void

/** A remote tool as listed by a server, before it's wrapped as an AgentTool. */
interface RemoteTool {
  remoteName: string
  description?: string
  inputSchema?: unknown
}

interface Connection {
  /** Fingerprint of the server config; a change forces a reconnect. */
  hash: string
  server: McpServerConfig
  client: Client
  tools: RemoteTool[]
}

export class McpManager {
  /** Connected servers, keyed by McpServerConfig.id. */
  private connections = new Map<string, Connection>()
  /** Flattened, collision-resolved AgentTools — the live getTools() snapshot. */
  private flat: AgentTool<any>[] = []
  private listeners = new Set<Listener>()
  /** Serializes reconciles so overlapping config deltas can't race. */
  private queue: Promise<void> = Promise.resolve()

  /** Latest connected tools, ready to merge into an agent's tool set. */
  getTools(): AgentTool<any>[] {
    return this.flat
  }

  /** Notified after the tool set changes (a server connected, dropped, or updated). */
  onToolsChanged(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Reconcile connections against the latest server-pushed config. Cheap when
   * nothing changed (fingerprint compare). Safe to call on every config tick;
   * calls are serialized, so a burst of deltas converges to the final state.
   */
  sync(servers: McpServerConfig[]): void {
    const list = servers ?? []
    const enabled = list.filter((s) => s.enabled)
    console.log(
      `[mcp] sync: ${list.length} server(s), ${enabled.length} enabled` +
        (enabled.length ? ` → ${enabled.map((s) => `${s.name}[${s.transport.kind}]`).join(', ')}` : '')
    )
    this.queue = this.queue
      .then(() => this.reconcile(list))
      .catch((err) => console.error('[mcp] reconcile failed:', err))
  }

  /** Close every connection (app shutdown). */
  async dispose(): Promise<void> {
    const conns = [...this.connections.values()]
    this.connections.clear()
    this.flat = []
    await Promise.all(conns.map((c) => c.client.close().catch(() => {})))
  }

  private async reconcile(servers: McpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled)
    const desired = new Map(enabled.map((s) => [s.id, s]))
    let changed = false

    // Tear down connections that vanished, were disabled, or whose config changed.
    for (const [id, conn] of [...this.connections]) {
      const want = desired.get(id)
      if (!want || fingerprint(want) !== conn.hash) {
        this.connections.delete(id)
        changed = true
        void conn.client.close().catch(() => {})
      }
    }

    // Bring up servers that aren't connected yet (new, or just dropped above).
    for (const server of enabled) {
      if (this.connections.has(server.id)) continue
      try {
        console.log(`[mcp] connecting "${server.name}" (${describeTransport(server.transport)}) ...`)
        const conn = await connect(server)
        this.connections.set(server.id, conn)
        changed = true
        console.log(
          `[mcp] "${server.name}" connected: ${conn.tools.length} tool(s)` +
            (conn.tools.length ? ` → ${conn.tools.map((t) => t.remoteName).join(', ')}` : '')
        )
      } catch (err) {
        // Leave it absent; the next config tick retries. A bad command or an
        // offline server must never break the agent or other servers.
        console.error(`[mcp] connect failed for "${server.name}" (${server.id}):`, err)
      }
    }

    if (changed) {
      this.rebuild()
      console.log(`[mcp] tool set updated: ${this.flat.length} tool(s) live`)
      for (const cb of this.listeners) cb()
    }
  }

  /**
   * Flatten all connections into one AgentTool list, resolving name collisions:
   * two servers may each expose a `search` tool, but the LLM tool list (and the
   * approval gate, keyed by name) needs unique names. The first claim wins its
   * bare name; later clashes are prefixed with the server's slug, then numbered.
   */
  private rebuild(): void {
    const used = new Set<string>()
    const out: AgentTool<any>[] = []
    for (const conn of this.connections.values()) {
      for (const rt of conn.tools) {
        let name = rt.remoteName
        if (used.has(name)) name = `${slug(conn.server.name)}_${rt.remoteName}`
        let unique = name
        let n = 2
        while (used.has(unique)) unique = `${name}_${n++}`
        used.add(unique)
        out.push(makeTool(unique, rt, conn))
      }
    }
    this.flat = out
  }
}

/** Connect, handshake, and list a single server's tools (bounded by a timeout). */
async function connect(server: McpServerConfig): Promise<Connection> {
  const client = new Client(CLIENT_INFO)
  await withTimeout(client.connect(buildTransport(server.transport)), 'connect')
  const { tools } = await withTimeout(client.listTools(), 'listTools')
  return {
    hash: fingerprint(server),
    server,
    client,
    tools: tools.map((t) => ({
      remoteName: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }
}

/** Reject if a connection step hangs, so it logs instead of wedging the queue. */
function withTimeout<T>(p: Promise<T>, step: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${step} timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
    )
  ])
}

/** One-line, secret-free description of a transport for logs. */
function describeTransport(t: McpTransport): string {
  return t.kind === 'stdio' ? `stdio: ${t.command}` : `${t.kind}: ${t.url}`
}

/** Build the SDK transport for a pushed transport config. */
function buildTransport(t: McpTransport): Transport {
  switch (t.kind) {
    case 'stdio':
      return new StdioClientTransport({
        command: t.command,
        args: t.args,
        // Merge over the SDK's safe default env so the child still inherits PATH
        // etc.; pushed env vars (e.g. credentials) take precedence.
        env: { ...getDefaultEnvironment(), ...(t.env ?? {}) }
      })
    case 'sse':
      return new SSEClientTransport(
        new URL(t.url),
        t.headers ? { requestInit: { headers: t.headers } } : undefined
      )
    case 'http':
      return new StreamableHTTPClientTransport(
        new URL(t.url),
        t.headers ? { requestInit: { headers: t.headers } } : undefined
      )
  }
}

/** Adapt a remote MCP tool into a pi AgentTool that proxies execute() over MCP. */
function makeTool(name: string, rt: RemoteTool, conn: Connection): AgentTool<any> {
  // MCP inputSchema is already JSON Schema. Carry it through as a Type.Unsafe so
  // pi forwards it verbatim to the LLM without running typebox validation on it
  // (the server validates args; symbols are dropped on JSON serialization anyway).
  const parameters =
    rt.inputSchema && typeof rt.inputSchema === 'object'
      ? Type.Unsafe<any>(rt.inputSchema)
      : Type.Object({})

  return {
    name,
    label: name,
    description: rt.description ?? `${rt.remoteName} (from ${conn.server.name})`,
    parameters,
    execute: async (_id, args, signal) => {
      const res = await conn.client.callTool(
        { name: rt.remoteName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal, timeout: CALL_TIMEOUT_MS }
      )
      const content = mapContent(res.content)
      // MCP reports tool failures in-band via isError; pi expects a thrown error
      // (it converts exceptions into tool errors). Surface the text it returned.
      if (res.isError) {
        const text = content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        throw new Error(text || `MCP tool "${rt.remoteName}" failed`)
      }
      return { content, details: {} }
    }
  }
}

type PiContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/** Map MCP content blocks to the subset of pi content blocks we render. */
function mapContent(blocks: unknown): PiContent[] {
  if (!Array.isArray(blocks)) return []
  const out: PiContent[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const block = b as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      out.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      // resource / audio / unknown blocks: degrade to a readable note rather than
      // dropping them, so the model still sees that something came back.
      out.push({ type: 'text', text: `[unsupported MCP content: ${String(block.type)}]` })
    }
  }
  return out
}

/** Stable fingerprint of the parts of a server config that affect the connection. */
function fingerprint(server: McpServerConfig): string {
  return JSON.stringify({ transport: server.transport, enabled: server.enabled })
}

/** A filesystem/identifier-safe slug from a user-facing server name. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'mcp'
  )
}
