-- Long-term agent memory (user-scoped). Mirrors the client SQLite `memories`
-- table and the `Memory` contract in packages/shared. Timestamps are epoch
-- milliseconds (BIGINT) to match the wire shape directly — no TIMESTAMPTZ
-- conversion. Deletes are soft (deleted_at set) so a deletion propagates to a
-- user's other devices through memory:pull instead of being resurrected.
CREATE TABLE IF NOT EXISTS memories (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    text       TEXT NOT NULL,
    source     TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_memories_user_updated
    ON memories (user_id, updated_at);
