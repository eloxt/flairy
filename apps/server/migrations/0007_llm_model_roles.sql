CREATE TABLE IF NOT EXISTS llm_role_assignments (
    role       TEXT PRIMARY KEY,
    model_id   UUID NOT NULL REFERENCES llm_models (id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_role_check CHECK (role IN ('main','tool'))
);
DROP INDEX IF EXISTS uniq_llm_model_active;
