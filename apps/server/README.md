# Flairy Server

Rust control-plane server for Flairy: REST API (Axum) + real-time socket.io
(socketioxide) over Tokio, backed by PostgreSQL via SQLx.

The server is the **control plane** only — it ships config and mirrors sessions.
It never proxies LLM traffic.

## Contract source of truth

The serde structs in `src/models/` are the single source of truth for the
socket.io / config / session contract and are mirrored in
`packages/shared/src/*.ts`. All JSON is camelCase. Change one side, sync the
other.

## Requirements

- Rust (cargo 1.93+)
- PostgreSQL (optional for compiling/running; required for actual functionality)

## Configuration

Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

- `DATABASE_URL` — Postgres URL. If unset, the server still starts, but
  DB-backed routes return `503` and socket session sync is a no-op.
- `JWT_SECRET` — HS256 secret for JWTs (REST + socket handshake).
- `BIND_ADDR` — listen address (default `0.0.0.0:8787`).

## Database setup

Create the database and apply the migration with `psql`:

```bash
createdb flairy
psql "$DATABASE_URL" -f migrations/0001_init.sql
```

(On startup the server also attempts to run migrations automatically when a DB
is configured.)

## Run

```bash
cargo run
```

The server listens on `BIND_ADDR` (default `http://0.0.0.0:8787`).

## REST API

| Method | Path                | Body                                   | Notes                          |
|--------|---------------------|----------------------------------------|--------------------------------|
| GET    | `/api/health`       | —                                      | `200 OK`                       |
| POST   | `/api/auth/login`   | `{ email, password }`                  | → `{ token, user }`            |
| POST   | `/api/auth/register`| `{ email, password, displayName }`     | → `201 { token, user }`        |
| GET    | `/api/config`       | — (Bearer token)                       | → `ConfigSnapshot`             |
| PUT    | `/api/config`       | `ConfigUpdate` (Bearer token)          | → updated `ConfigSnapshot`     |

Authenticated routes expect `Authorization: Bearer <jwt>`.

## socket.io

Clients connect with the JWT in the handshake `auth` field:
`io(url, { auth: { token } })`. On success the socket joins the room
`user:<userId>` and receives `config:snapshot`.

| Direction | Event              | Payload                  | Ack                          |
|-----------|--------------------|--------------------------|------------------------------|
| S→C       | `config:snapshot`  | `ConfigSnapshot`         | —                            |
| C→S       | `session:upsert`   | `SessionUpsertPayload`   | `bool`                       |
| C→S       | `session:patch`    | `SessionPatchPayload`    | `bool`                       |
| C→S       | `session:pull`     | `SessionPullPayload`     | `SessionWithMessages[]`      |
| S→C       | `session:remote`   | `SessionWithMessages`    | — (to user's other devices)  |

Invalid/missing tokens are disconnected.

## Notes

- Uses SQLx **runtime** queries (no compile-time macros) so the crate builds
  without a live database.
- CORS is permissive for development.
