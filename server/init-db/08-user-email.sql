-- Add email column to users table.
-- Populated automatically from the OIDC email claim on each login;
-- can also be set manually by an Admin via the User Management UI.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
