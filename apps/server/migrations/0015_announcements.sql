-- System announcement catalog: a flat list of banners pushed to clients in
-- `config:snapshot` and shown atop the empty chat screen. Content is small text,
-- so the full row ships inline in the snapshot (like `system_prompts`).
--
-- `kind` drives the client's visual tone (info / success / warning / error);
-- the CHECK keeps it a closed set, matching `AnnouncementKind` on both sides.
--
-- Adding this module = this table + a version bump in each mutation tx
-- (see `bump_version` in the server's db layer), exactly like `system_prompts`.
CREATE TABLE IF NOT EXISTS announcements (
    id         UUID PRIMARY KEY,
    kind       TEXT NOT NULL DEFAULT 'info'
        CHECK (kind IN ('info', 'success', 'warning', 'error')),
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    enabled    BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_order
    ON announcements (sort_order, created_at);
