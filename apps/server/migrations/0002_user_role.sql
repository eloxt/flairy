-- Add a role to users so admin-only surfaces (admin web, /api/config) can be gated.
-- Values: 'user' (default, end users) | 'admin' (technical administrators).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

-- Constrain to the known roles.
ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
