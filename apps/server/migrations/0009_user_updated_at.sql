-- Track last-modified time on user accounts so the admin user-management
-- surface can show when a user was created vs. last changed.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
