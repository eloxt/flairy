-- Normalize central configuration from the single per-user `config` table
-- (three JSONB blobs) into per-module global catalog tables. Config is now
-- GLOBAL (one central catalog pushed to every client), not per-user.
--
-- Adding a future module = a new table here + a version bump in the same tx
-- (see `bump_version` in the server's db layer). `config_meta` holds the single
-- monotonic version the clients diff against.

-- LLM catalog: many configs, at most one active. The active one is what clients
-- receive in `config:snapshot`.
CREATE TABLE IF NOT EXISTS llm_configs (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    credential TEXT NOT NULL DEFAULT '',
    base_url   TEXT,
    is_active  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_provider_check CHECK (provider IN ('anthropic', 'openai', 'google'))
);

-- At most one active LLM config across the whole catalog.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_llm_active
    ON llm_configs (is_active) WHERE is_active;

-- MCP server catalog. `transport` stays JSONB because it is a polymorphic
-- stdio/sse/http union; the rest of the row is normalized.
CREATE TABLE IF NOT EXISTS mcp_servers (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    transport  JSONB NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_order
    ON mcp_servers (sort_order, created_at);

-- Skill catalog: system-prompt fragment + allowed tool set.
CREATE TABLE IF NOT EXISTS skills (
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skills_order
    ON skills (sort_order, created_at);

-- Single-row global config version, bumped on every catalog mutation.
CREATE TABLE IF NOT EXISTS config_meta (
    id         BOOLEAN PRIMARY KEY DEFAULT true,
    version    BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT config_meta_singleton CHECK (id)
);

INSERT INTO config_meta (id, version) VALUES (true, 0)
    ON CONFLICT (id) DO NOTHING;

-- Retire the old monolithic per-user config table.
DROP TABLE IF EXISTS config;
