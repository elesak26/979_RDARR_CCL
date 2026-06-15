/**
 * Migration 016 – Add missing status values to CHECK constraints.
 *
 * The application code writes 'rejected' and 'returned' to validations.status
 * and 'returned' to responses.status, but these values were never included in
 * the DB CHECK constraints. Every such write fails with a constraint violation,
 * which is why the Validator/Senior Validator validation actions appear empty:
 * - Validator returning a response → UPDATE validations SET status='returned' → fails
 * - Senior Validator rejecting     → UPDATE validations SET status='rejected' → fails
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- validations: add 'rejected' and 'returned'
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','returned','rejected','pending_approval','closed'));

    -- responses: add 'returned'
    ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_status_check;
    ALTER TABLE responses ADD CONSTRAINT responses_status_check
      CHECK (status IN ('draft','in_progress','submitted','returned'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Revert validations constraint (remove rejected/returned)
    UPDATE validations SET status = 'in_review' WHERE status IN ('rejected','returned');
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','pending_approval','closed'));

    -- Revert responses constraint (remove returned)
    UPDATE responses SET status = 'in_progress' WHERE status = 'returned';
    ALTER TABLE responses DROP CONSTRAINT IF EXISTS responses_status_check;
    ALTER TABLE responses ADD CONSTRAINT responses_status_check
      CHECK (status IN ('draft','in_progress','submitted'));
  `);
};
