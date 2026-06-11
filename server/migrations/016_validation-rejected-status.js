/**
 * Migration 016 – allow 'rejected' in the validations status CHECK.
 *
 * routes/validations.ts (Senior Validator reject) sets status = 'rejected', and
 * the "submit for approval" route's guard accepts 'rejected'. But the CHECK
 * constraint (last set in migration 004) only allowed
 * ('pending','in_review','pending_approval','closed') — so clicking Reject threw
 * a check-constraint violation → 500 Internal server error. Add 'rejected'.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','pending_approval','rejected','closed'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE validations SET status = 'in_review' WHERE status = 'rejected';
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','pending_approval','closed'));
  `);
};
