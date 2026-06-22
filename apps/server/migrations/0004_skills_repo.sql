-- Rich Agent-Skills model (no versioning). Replaces 0003's simple skills table.
--
-- A skill = a SKILL.md (YAML frontmatter + markdown body) plus supporting files.
-- File bytes live in `skill_file_blobs`, deduped by sha256 so unchanged content
-- across saves reuses the same blob row. File rows belong directly to a skill
-- (no version layer). Mutations bump `config_meta.version` so clients re-sync.

DROP TABLE IF EXISTS skills CASCADE;

CREATE TABLE skills (
    id                UUID PRIMARY KEY,
    name              VARCHAR(64)  NOT NULL UNIQUE,           -- agent-skills name spec
    description       VARCHAR(1024) NOT NULL DEFAULT '',
    license           TEXT,
    compatibility     VARCHAR(500),
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,     -- string->string map
    extra_frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,     -- arbitrary object
    allowed_tools     TEXT,                                   -- space-separated string (frontmatter form)
    skill_md_body     TEXT NOT NULL DEFAULT '',
    enabled           BOOLEAN NOT NULL DEFAULT true,          -- KEPT (Bifrost has none)
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_by        VARCHAR(255),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skills_order ON skills (sort_order, created_at);

-- File bytes (Postgres-only; Bifrost's DB-blob fallback). Dedupe by sha256 so
-- unchanged content across saves reuses the same blob row.
CREATE TABLE skill_file_blobs (
    id         UUID PRIMARY KEY,
    sha256     CHAR(64) NOT NULL UNIQUE,
    data       BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- File rows belong directly to a skill (no version layer).
CREATE TABLE skill_files (
    id               UUID PRIMARY KEY,
    skill_id         UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    path             VARCHAR(1024) NOT NULL,
    source_type      VARCHAR(32) NOT NULL,                   -- url|text|dataurl|upload
    source_url       TEXT,
    blob_id          UUID REFERENCES skill_file_blobs(id) ON DELETE SET NULL,
    mime_type        VARCHAR(255) NOT NULL DEFAULT 'text/plain',
    file_size_bytes  BIGINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (skill_id, path)
);
CREATE INDEX idx_skill_files_skill ON skill_files (skill_id);
CREATE INDEX idx_skill_files_blob  ON skill_files (blob_id);
