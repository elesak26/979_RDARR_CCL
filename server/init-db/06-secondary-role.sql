-- Add optional secondary_role to users.
-- The only valid secondary role is 'Validator', and only Admin users may have one.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS secondary_role TEXT
  CHECK (secondary_role IS NULL OR secondary_role = 'Validator');

-- Belt-and-suspenders: prevent non-Admin users from ever getting a secondary role at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS users_secondary_role_admin_only
  ON users (id)
  WHERE secondary_role IS NOT NULL AND role != 'Admin';
