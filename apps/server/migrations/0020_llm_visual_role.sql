-- Allow the 'visual' role: an auxiliary vision model the client uses to
-- extract text from image attachments when the main model does not accept
-- image input. Extends the role CHECK constraints on both the global and the
-- per-user assignment tables.
ALTER TABLE llm_role_assignments
    DROP CONSTRAINT llm_role_check;
ALTER TABLE llm_role_assignments
    ADD CONSTRAINT llm_role_check CHECK (role IN ('main', 'tool', 'visual'));

ALTER TABLE llm_user_role_assignments
    DROP CONSTRAINT llm_user_role_assignments_role_check;
ALTER TABLE llm_user_role_assignments
    ADD CONSTRAINT llm_user_role_assignments_role_check
        CHECK (role IN ('main', 'tool', 'visual'));
