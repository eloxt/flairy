-- Split the flat `llm_configs` catalog into two levels:
--   * `llm_providers` — a vendor connection holding the credential + base URL.
--   * `llm_models`     — a model entry under one provider; at most one is active.
-- A provider's credential is shared by all its models. The active model joined
-- with its provider is what clients receive in `config:snapshot`.

CREATE TABLE IF NOT EXISTS llm_providers (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    provider   TEXT NOT NULL,
    credential TEXT NOT NULL DEFAULT '',
    base_url   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_provider_kind_check CHECK (provider IN ('anthropic', 'openai', 'google'))
);

CREATE TABLE IF NOT EXISTS llm_models (
    id          UUID PRIMARY KEY,
    provider_id UUID NOT NULL REFERENCES llm_providers (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    model       TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_models_provider
    ON llm_models (provider_id);

-- At most one active model across the whole catalog.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_llm_model_active
    ON llm_models (is_active) WHERE is_active;

-- Retire the flat single-level catalog.
DROP TABLE IF EXISTS llm_configs;
