-- Per-model runtime parameters delivered to clients so the agent can run models
-- that pi-ai's built-in registry does NOT know (custom / third-party / OpenAI-
-- compatible endpoints, e.g. provider=openai + model=glm-5.2). When these are
-- NULL the client falls back to pi-ai's registry (`getModel`) for known models,
-- or to its own defaults. Mirrors `LlmModelConfig` in
-- `apps/server/src/models/llm.rs` and `packages/shared/src/config.ts`.
--
--   * `api`             — how the client talks to the provider (pi-ai `Api`).
--   * `context_window`  — model context window in tokens.
--   * `max_tokens`      — max output tokens per turn.
--   * `cost_*`          — per-token price (USD); informational, for usage stats.
ALTER TABLE llm_models
    ADD COLUMN api             TEXT,
    ADD COLUMN context_window  INTEGER,
    ADD COLUMN max_tokens      INTEGER,
    ADD COLUMN cost_input      DOUBLE PRECISION,
    ADD COLUMN cost_output     DOUBLE PRECISION,
    ADD COLUMN cost_cache_read DOUBLE PRECISION,
    ADD COLUMN cost_cache_write DOUBLE PRECISION;

-- The allowed `api` set mirrors the vendors we support plus the universal
-- OpenAI-compatible completions API used by most third-party gateways.
ALTER TABLE llm_models
    ADD CONSTRAINT llm_model_api_check
    CHECK (api IS NULL
           OR api IN ('openai-completions', 'openai-responses',
                      'anthropic-messages', 'google-generative-ai'));
