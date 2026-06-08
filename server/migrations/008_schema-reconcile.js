/**
 * Migration 008 – Reconcile schema with application code.
 *
 * The application code references schema objects that no prior migration ever
 * created (they existed only in the developers' hand-patched dev database, so a
 * from-scratch deploy fails at runtime with "column/relation does not exist"):
 *
 *   - users.is_active            — auth middleware + routes/users.ts (enable/disable users)
 *   - questionnaire_cycles.checklist_file — routes/cycles.ts (checklist upload/download)
 *   - login_history (whole table) — auth middleware recordLogin + users/reporting login tracking
 *
 * All statements are idempotent so this applies cleanly on fresh and patched DBs.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- users.is_active (DEFAULT true backfills the rows seeded by migration 007)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

    -- questionnaire_cycles.checklist_file (uploaded checklist filename)
    ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS checklist_file TEXT;

    -- login_history: one row per recorded login (auth.ts recordLogin)
    --   INSERT (user_id, display_name, role, ip_address, user_agent); logged_in_at defaults now()
    CREATE TABLE IF NOT EXISTS login_history (
      id           BIGSERIAL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      display_name TEXT,
      role         TEXT,
      ip_address   TEXT,
      user_agent   TEXT,
      logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_login_history_user_id      ON login_history (user_id);
    CREATE INDEX IF NOT EXISTS idx_login_history_logged_in_at ON login_history (logged_in_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS login_history;
    ALTER TABLE questionnaire_cycles DROP COLUMN IF EXISTS checklist_file;
    ALTER TABLE users DROP COLUMN IF EXISTS is_active;
  `);
};
