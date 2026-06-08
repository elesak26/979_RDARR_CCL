/**
 * Migration 006 – Audit log table
 */

exports.up = (pgm) => {
  pgm.sql(`
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

    CREATE INDEX idx_audit_log_created_at   ON audit_log (created_at DESC);
    CREATE INDEX idx_audit_log_actor_id     ON audit_log (actor_id);
    CREATE INDEX idx_audit_log_entity_type  ON audit_log (entity_type);
    CREATE INDEX idx_audit_log_cycle_id     ON audit_log (cycle_id);
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
