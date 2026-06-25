-- Consolidate the LLM "API protocol" onto the provider connection.
--
-- Before this migration the protocol was split across two places that carried the
-- same axis of information: `llm_providers.provider` held a coarse vendor
-- (anthropic / openai / google) and `llm_models.api` (added in 0011) optionally
-- refined it per model. The client only ever needs the pi-ai `Api`, and derives
-- the vendor from it — so the per-model `api` was redundant. Drop it and turn the
-- provider's vendor column into the API protocol itself. Mirrors `ProviderApi` /
-- `LlmProviderConfig` in `apps/server/src/models/llm.rs` and
-- `packages/shared/src/config.ts`.

-- 1. Drop the per-model API override (context_window / max_tokens / cost_* stay).
ALTER TABLE llm_models DROP CONSTRAINT IF EXISTS llm_model_api_check;
ALTER TABLE llm_models DROP COLUMN IF EXISTS api;

-- 2. Provider vendor → API protocol.
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_provider_kind_check;
ALTER TABLE llm_providers RENAME COLUMN provider TO api;
UPDATE llm_providers SET api = CASE api
    WHEN 'anthropic' THEN 'anthropic-messages'
    WHEN 'openai'    THEN 'openai-completions'
    WHEN 'google'    THEN 'google-generative-ai'
    ELSE api
END;
ALTER TABLE llm_providers
    ADD CONSTRAINT llm_provider_api_check
    CHECK (api IN ('openai-completions', 'openai-responses',
                   'anthropic-messages', 'google-generative-ai'));
