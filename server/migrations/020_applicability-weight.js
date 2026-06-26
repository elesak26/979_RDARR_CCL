/**
 * Migration 020 — Add weight column to question_applicability and responses
 *
 * weight is a decimal (0–1) representing this BU's contribution to the
 * consolidated validation score for this question.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE question_applicability ADD COLUMN IF NOT EXISTS weight NUMERIC(10,6);
    ALTER TABLE responses              ADD COLUMN IF NOT EXISTS weight NUMERIC(10,6);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE question_applicability DROP COLUMN IF EXISTS weight;
    ALTER TABLE responses              DROP COLUMN IF EXISTS weight;
  `);
};
