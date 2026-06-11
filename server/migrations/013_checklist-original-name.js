/**
 * Migration 013 – questionnaire_cycles.checklist_original_name.
 *
 * Stores the original (human) filename of the uploaded checklist; cycles.ts
 * SELECTs and UPDATEs it. Rewritten to use pgm.sql — the original
 * `async (db) => db.query(...)` throws "db.query is not a function" because the
 * node-pg-migrate callback receives a MigrationBuilder (no .query() method),
 * which breaks the whole migration run on container startup.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS checklist_original_name TEXT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE questionnaire_cycles DROP COLUMN IF EXISTS checklist_original_name;`);
};
