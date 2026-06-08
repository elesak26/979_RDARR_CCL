/**
 * Migration 006 – Audit log table
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Migration 001 already created an earlier audit_log shape (old_value/new_value,
    -- no cycle_id/details). A plain CREATE TABLE IF NOT EXISTS is therefore a no-op
    -- on a from-scratch run, leaving cycle_id/details absent and the cycle_id index
    -- below failing. Create-if-absent AND reconcile the columns so this migration
    -- applies cleanly both from scratch and on databases still holding the 001 shape.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          BIGSERIAL PRIMARY KEY,
      action      TEXT NOT NULL,
      actor_id    TEXT,
      actor_name  TEXT,
      actor_role  TEXT,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      cycle_id    INTEGER,
      details     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS cycle_id INTEGER;
    ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS details  JSONB NOT NULL DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at   ON audit_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id     ON audit_log (actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity_type  ON audit_log (entity_type);
    CREATE INDEX IF NOT EXISTS idx_audit_log_cycle_id     ON audit_log (cycle_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_audit_log_cycle_id;
    DROP INDEX IF EXISTS idx_audit_log_entity_type;
    DROP INDEX IF EXISTS idx_audit_log_actor_id;
    DROP INDEX IF EXISTS idx_audit_log_created_at;
    DROP TABLE IF EXISTS audit_log;
  `);
};
