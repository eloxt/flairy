CREATE TABLE IF NOT EXISTS llm_role_assignments (
    role       TEXT PRIMARY KEY,
    model_id   UUID NOT NULL REFERENCES llm_models (id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_role_check CHECK (role IN ('main','tool'))
);
-- migrate the current single active model into the `main` role
INSERT INTO llm_role_assignments (role, model_id)
SELECT 'main', id FROM llm_models WHERE is_active
ON CONFLICT (role) DO NOTHING;
DROP INDEX IF EXISTS uniq_llm_model_active;
ALTER TABLE llm_models DROP COLUMN IF EXISTS is_active;
