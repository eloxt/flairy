CREATE TABLE IF NOT EXISTS services (
    id         UUID PRIMARY KEY,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    secret     TEXT NOT NULL DEFAULT '',
    settings   JSONB NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_order ON services (sort_order, created_at);
