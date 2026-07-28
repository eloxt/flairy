-- Per-model "user selectable" flag: marks a model as a candidate for the
-- desktop user's own main-model picker. Selectable models are delivered to
-- clients (joined with their provider) as `ConfigSnapshot.modelOptions`; the
-- user's pick is stored locally on each device, never on the server. Mirrors
-- `LlmModelConfig` in `apps/server/src/models/llm.rs` and
-- `packages/shared/src/config.ts`.
--
-- Note: flagging a model selectable ships its provider credential to every
-- client (encrypted at rest there, masked before the renderer).
ALTER TABLE llm_models
    ADD COLUMN selectable BOOLEAN NOT NULL DEFAULT FALSE;
