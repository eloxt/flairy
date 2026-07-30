-- Descriptive model facts sourced from models.dev (knowledge cutoff, release
-- date, capability flags). Informational only: the desktop renders them in the
-- user model picker's details card; nothing here changes how the client calls
-- the provider. One nullable JSONB blob (camelCase keys) rather than columns —
-- the set follows models.dev and is display-only, so it needs no constraints or
-- indexing. Mirrors `ModelMetadata` in `apps/server/src/models/llm.rs` and
-- `packages/shared/src/config.ts`.
ALTER TABLE llm_models
    ADD COLUMN metadata JSONB;
