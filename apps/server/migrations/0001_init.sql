-- Initial schema for the Flairy server.

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_updated
    ON sessions (user_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
    id         UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    raw        JSONB NOT NULL DEFAULT '{}'::jsonb,
    ts         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ts
    ON messages (session_id, ts);

-- Per-user central configuration pushed to clients.
CREATE TABLE IF NOT EXISTS config (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    llm         JSONB NOT NULL DEFAULT '{}'::jsonb,
    mcp_servers JSONB NOT NULL DEFAULT '[]'::jsonb,
    skills      JSONB NOT NULL DEFAULT '[]'::jsonb,
    version     BIGINT NOT NULL DEFAULT 0
);
