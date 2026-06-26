# Flairy

A desktop AI Agent product aimed at **non-technical users**. Users don't need to understand concepts like MCP, skills, or models — these are all centrally configured and pushed down by a **unified server**, so the client works out of the box.

## Product Goals

- **Target users**: ordinary users who don't understand AI concepts (MCP / skill / model / API key).
- **Unified management server**: administrators centrally configure skills, MCP servers, LLM models, and credentials in the server-side admin backend; configuration is pushed to clients in real time, requiring zero configuration on the user side.
- **User system + session sync**: the client has a login state; user sessions are synced across multiple devices via the server.
- **Real-time communication**: client ↔ server communicate over **socket.io** (config delivery, session sync, multi-device push).

## Architecture Overview (Key Decisions)

**Thick client**: the agent main loop, tools, and MCP all run locally on the client. The server is the **control plane** and never touches LLM traffic.

```
┌─ Client (Electron + React)──────────────────────┐      ┌─ Server (Rust/Axum + React admin)─────┐
│  pi-agent-core (agent loop, local)               │      │  Admin Web UI (React, configure skill) │
│  Local tools (fs / shell)                         │      │  User system / auth (Axum JWT)         │
│  MCP client (connects to server-pushed MCP svrs)  │◄────►│  Central config store + delivery        │
│  LLM: "direct connect" to provider via pushed cfg │ s.io │  Session sync store (PostgreSQL)        │
│  Local cache (SQLite, offline-capable)            │      │  socketioxide (Axum / Tokio)            │
└─────────────────────────────────────────────────┘      └──────────────────────────────────────┘
        │ Direct connection to LLM provider (using pushed credentials)
        ▼
   Anthropic / OpenAI / Google ...
```

**Important**: the server **only pushes LLM configuration (model + credentials); it does NOT proxy the LLM**. Once the client receives the config, it calls the provider directly. LLM traffic never passes through the server.

## Monorepo Structure (Target)

pnpm workspace:

A **polyglot** repo: TS client + Rust server.

```
flairy/
├── apps/
│   ├── desktop/        # Electron client (TS, electron-vite + React + shadcn/ui)
│   ├── server/         # Rust server (Axum): REST API + socketioxide
│   └── admin/          # React admin web (Vite + TS + shadcn/ui)
├── packages/
│   └── shared/         # TS contracts (shared by desktop + admin); aligned with the server's Rust serde structs
├── pnpm-workspace.yaml # Manages the TS side (desktop / admin / shared)
└── AGENTS.md
```

> **Current status**: the Electron scaffold currently lives at the repo root `src/` (already passes `pnpm typecheck` + `pnpm build`). The next step is to migrate it to `apps/desktop/`, and create `apps/server/` (Rust, managed by Cargo), `apps/admin/`, and `packages/shared/`.
>
> **Contract sharing (polyglot)**: the server is Rust and cannot directly import TS. Conventions:
> - **REST**: use `utoipa` to produce OpenAPI from Axum handlers → use `openapi-typescript` to generate TS types for desktop/admin.
> - **socket.io events / config schema / session models**: the server's **Rust serde structs are the single source of truth**, and `packages/shared` maintains aligned TS types (which can be generated from JSON Schema exported by schemars). Changing one side requires syncing the other.

## Tech Stack

**Client `apps/desktop`**
- electron-vite + electron-builder, TypeScript, React 19, shadcn/ui (new-york / neutral / Tailwind v4)
- `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` (agent kernel + multi-provider LLM)
- Zustand (state), better-sqlite3 / Drizzle (local cache), `socket.io-client` (real-time)
- Rendering: react-markdown + remark-gfm + Shiki + react-virtuoso
- Process model: the agent runs in the **main / utility process** (Node), events are pushed to the renderer via IPC; the renderer never touches Node/credentials

**Server `apps/server` (Rust)**
- **Axum** (REST API, Tokio runtime) + **socketioxide** (implements the Socket.IO server protocol on top of Axum/Tower, interoperating with the client's `socket.io-client`)
- **serde** (serialization, source of truth for REST and event contracts) + `validator` (validation) + `utoipa` (produces OpenAPI) + `schemars` (exports JSON Schema)
- DB: **PostgreSQL** + **SQLx** (async, compile-time-checked SQL) + `sqlx migrate` (migrations)
- Auth: JWT (`jsonwebtoken`), `argon2` for password hashing; the socket.io handshake is validated with the same JWT
- Dependency management: Cargo; the artifact is a single static binary, easy to self-host
- **Deployment must hold long-lived connections** (socket.io) → self-host or use a platform that supports WebSocket; **do not use serverless**

**Admin backend `apps/admin` (React)**
- Vite + React + TypeScript + shadcn/ui (shares the design language with the client)
- Calls the server: uses a TS client generated from the OpenAPI produced by Axum/utoipa
- Aimed at **technical administrators**

## socket.io Protocol (server: socketioxide; source of truth = Rust serde structs; TS mirror in `packages/shared`)

Handshake: the client carries the login JWT in the `auth` field; the server (socketioxide) validates it and establishes the connection.

| Direction | Event | Payload | Description |
|---|---|---|---|
| S→C | `config:snapshot` | `{ models, mcpServers, skills, llm }` | Full delivery once the connection is established |
| S→C | `config:updated` | Incremental config | Pushed in real time after an admin changes config |
| C→S | `session:upsert` | `{ session, messages }` | Client syncs a local session to the server |
| C→S | `session:patch` | `{ sessionId, appendMessages }` | Incremental append (during an ongoing conversation) |
| C→S | `session:pull` | `{ since? }` | Pull the remote session list/updates |
| S→C | `session:remote` | `{ session, messages }` | Another device updated a session → push it to this client |

Conventions: all event names are centralized in `packages/shared`; scattered string literals are forbidden. Session sync follows "local-first + server mirror", with conflicts resolved by the newer `updatedAt` (can later be upgraded to CRDT).

## Configuration Delivery Model

The server is the sole source of skills / MCP / LLM configuration; the client receives it passively:

- **LLM**: `{ provider, model, credentials, baseUrl? }`. The client uses `new Agent({ getApiKey })` to inject the pushed credentials and connects directly to the provider.
- **MCP**: the server pushes MCP server connection info; once the client's MCP client connects, it adapts those tools into `AgentTool`s and injects them into `agent.state.tools`.
- **skills**: skills defined on the server (system prompt fragments + tool combinations); after delivery, the client assembles them into the agent.

> **Security note**: pushing raw provider keys to every client creates a leak surface. Prefer pushing **short-lived / rotatable scoped credentials** or a gateway token rather than a long-lived master key. Credentials live only in client memory + safeStorage, and must never reach the renderer.

## Data Flow of a Single Conversation

1. The renderer sends a prompt → IPC → the main process's AgentService
2. The main process's `pi-agent-core` Agent runs the loop, connecting directly to the provider using the pushed LLM config
3. Tool calls: local tools (fs/shell) or MCP tools; dangerous tools go through the `beforeToolCall` approval gate (awaiting user confirmation)
4. `agent.subscribe` events are streamed to the renderer via IPC for rendering
5. End of turn: messages are written to local SQLite and synced to the server via socket.io `session:patch` → the server pushes `session:remote` to the user's other devices

## pi-agent-core API Notes (battle-tested pitfalls, must follow)

Based on hands-on testing with 0.79.6; the README examples diverge from the actual types:

- `getModel(provider, modelId)` **takes only 2 arguments** and does not accept an apiKey. Credentials are injected via `new Agent({ getApiKey: (provider) => ... })`.
- `AgentTool` **requires `label`**; the `execute` return value **requires `details`**; `params` must be explicitly typed as `any` (`Static<any>` actually resolves to `unknown`).
- Messages need a `timestamp`: `agent.steer({ role, content, timestamp: Date.now() })`.
- typebox is a **standalone package** (`typebox` v1.x), not `@sinclair/typebox`.
- Tools should throw errors rather than putting the error into `content` (pi converts exceptions into tool errors).
- pi **has no permission system**: security relies solely on the approval gate + path restrictions + a real sandbox (use Docker isolation in production).

## Electron Packaging Notes (only surface at build time)

- Under `"type": "module"`, the preload artifact is `index.mjs`; the main process's reference must match.
- The main process is bundled as ESM → use `import.meta.dirname`, not `__dirname`.
- A sandboxed preload cannot be ESM → `sandbox: false` + `contextIsolation: true` (the real boundary) + `nodeIntegration: false`.
- pnpm 11: build scripts for native modules (better-sqlite3 / electron) must be explicitly allowed in `pnpm-workspace.yaml`'s `allowBuilds`.

## Development Commands

```bash
# Client (currently at the repo root; under apps/desktop after migration)
pnpm dev            # HMR for all three frontends
pnpm typecheck      # tsc check (Node side + Web side)
pnpm build          # Packaging validation
pnpm package:mac    # Produce a .dmg (requires signing + notarization)
```

## Conventions

- Shared types on the TS side (desktop + admin) go in `packages/shared`; do not duplicate them in each app.
- Cross-language contracts: REST generates TS from the Axum/utoipa OpenAPI; socket.io events / config schema / session models follow the server's Rust serde structs, and the TS in `packages/shared` must stay aligned — change one side, sync the other.
- Credentials/keys live only in the client's main process (encrypted with safeStorage); they must never reach the renderer and never be written to disk in plaintext.
- End-user-facing copy must not contain technical jargon like MCP/skill/schema.
- The agent runs in the client's main process; the server never carries LLM/agent traffic.
- Before declaring done: typecheck passes, build passes.
- Use ppnpm dlx shadcn@latest add when missing a component from the UI library.
- DO NOT modify components in components/ui folder.
