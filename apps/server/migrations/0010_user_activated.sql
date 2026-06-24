-- Account activation gate. New self-service registrations land deactivated and
-- must be activated by an administrator before they can sign in to the client.
--
-- DEFAULT true so existing users (and admins) stay usable across this migration;
-- the self-registration path explicitly inserts `false`.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS activated BOOLEAN NOT NULL DEFAULT true;
