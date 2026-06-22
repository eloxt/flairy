-- System-prompt catalog: a flat list of prompt bodies pushed to clients in
-- `config:snapshot`. Bodies are small text, so the full body ships inline in the
-- snapshot (unlike skills).
--
-- Adding this module = this table + a version bump in each mutation tx
-- (see `bump_version` in the server's db layer), exactly like `mcp_servers`.
CREATE TABLE IF NOT EXISTS system_prompts (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    enabled    BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_prompts_order
    ON system_prompts (sort_order, created_at);
