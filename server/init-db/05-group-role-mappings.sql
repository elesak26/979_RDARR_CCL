-- AD group → local role mappings, managed from the UI (Admin › Users).
--
-- Spec (Thanos, "Issues - Pending Items" item 4): the mapping between Azure AD
-- groups and the application's local roles must be configurable from the UI, not
-- baked into configuration. This table is that store; the auth middleware reads
-- it (cached) to turn the group claim on a verified token into a role.
--
-- ad_group holds whatever the token carries — an Entra group object-id (GUID) or
-- an app-role name. Matching is case-insensitive, so the unique index is on
-- LOWER(ad_group) to stop the same group being mapped twice under different case.
CREATE TABLE IF NOT EXISTS group_role_mappings (
  id         SERIAL PRIMARY KEY,
  ad_group   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('Admin', 'Senior Validator', 'Validator', 'Responder', 'Viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_group_role_mappings_group
  ON group_role_mappings (LOWER(ad_group));
