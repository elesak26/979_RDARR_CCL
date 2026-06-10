/**
 * Migration 012 – questionnaire_cycles.description.
 *
 * Rewritten to use pgm.sql (the MigrationBuilder has no .query() method; the
 * original `async (db) => db.query(...)` threw "db.query is not a function").
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS description TEXT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE questionnaire_cycles DROP COLUMN IF EXISTS description;`);
};
