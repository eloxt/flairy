-- Per-model reasoning effort delivered to clients and applied by the agent loop
-- (pi-agent-core `thinkingLevel`). NULL means "no explicit level forced" — the
-- client/provider default decides. The allowed set mirrors `ThinkingLevel` in
-- `apps/server/src/models/llm.rs` and `packages/shared/src/config.ts`.
ALTER TABLE llm_models
    ADD COLUMN thinking_level TEXT;

ALTER TABLE llm_models
    ADD CONSTRAINT llm_model_thinking_level_check
    CHECK (thinking_level IS NULL
           OR thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'));
