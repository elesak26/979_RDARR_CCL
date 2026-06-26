/**
 * Migration 019 — Add link column to notifications for deep-linking
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link TEXT`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE notifications DROP COLUMN IF EXISTS link`);
};
