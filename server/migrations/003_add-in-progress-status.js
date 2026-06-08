/**
 * Migration 003 – Add 'in_progress' to responses.status
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_status_check;

    ALTER TABLE responses
      ADD CONSTRAINT responses_status_check
      CHECK (status IN ('draft', 'in_progress', 'submitted'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revert any in_progress rows to draft before dropping the constraint
    UPDATE responses SET status = 'draft' WHERE status = 'in_progress';

    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_status_check;

    ALTER TABLE responses
      ADD CONSTRAINT responses_status_check
      CHECK (status IN ('draft', 'submitted'));
  `);
};
