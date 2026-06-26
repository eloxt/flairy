-- Per-user resource assignment for mcp_servers / skills / services.
--
-- audience='all'      -> delivered to every user (the migration default; preserves
--                        today's global behavior for all existing rows)
-- audience='specific' -> delivered only to the users listed in resource_assignments
--                        (an empty list therefore means "nobody")

ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'specific'));
ALTER TABLE skills
    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'specific'));
ALTER TABLE services
    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all'
    CHECK (audience IN ('all', 'specific'));

-- One unified, typed assignment table for every resource kind. Adding a new
-- resource kind later is just a new value in the resource_type CHECK.
-- user_id keeps an FK + cascade (users is concrete); resource_id has no FK
-- because it can point at three different tables, so resource deletes must
-- purge their assignment rows explicitly (see db delete mutations).
CREATE TABLE IF NOT EXISTS resource_assignments (
    resource_type TEXT NOT NULL CHECK (resource_type IN ('mcp', 'skill', 'service')),
    resource_id   UUID NOT NULL,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (resource_type, resource_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_assignments_user
    ON resource_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_resource_assignments_resource
    ON resource_assignments (resource_type, resource_id);
