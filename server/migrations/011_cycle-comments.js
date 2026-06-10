/**
 * Migration 011 – cycle_comments table.
 *
 * Rewritten to use the node-pg-migrate MigrationBuilder API (pgm.sql). The
 * original used `async (db) => db.query(...)`, but the migration callback
 * receives a MigrationBuilder, which has no .query() method, so it threw
 * "TypeError: db.query is not a function" and broke the migration run.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS cycle_comments (
      id         SERIAL PRIMARY KEY,
      cycle_id   INTEGER NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      user_name  TEXT NOT NULL,
      user_role  TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS cycle_comments_cycle_id_idx ON cycle_comments(cycle_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS cycle_comments;`);
};
