-- Per-user LLM role overrides.
--
-- llm_role_assignments stays the global default (what every user gets); a row
-- here overrides one role for one user. Snapshot resolution per user is:
-- user override if present, else the global binding. Both FKs are concrete, so
-- deleting a user or a model cleans its overrides via cascade.
CREATE TABLE IF NOT EXISTS llm_user_role_assignments (
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('main', 'tool')),
    model_id   UUID NOT NULL REFERENCES llm_models (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_llm_user_role_assignments_model
    ON llm_user_role_assignments (model_id);
