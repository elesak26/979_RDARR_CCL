/**
 * Migration 023 — Add 'cancelled' status to responses and validations
 * Allows force-closing a cycle by cancelling all in-flight items.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_status_check,
      ADD CONSTRAINT responses_status_check
        CHECK (status = ANY (ARRAY['draft','in_progress','submitted','returned','cancelled']));

    ALTER TABLE validations
      DROP CONSTRAINT IF EXISTS validations_status_check,
      ADD CONSTRAINT validations_status_check
        CHECK (status = ANY (ARRAY['pending','in_review','returned','rejected','pending_approval','closed','cancelled']));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_status_check,
      ADD CONSTRAINT responses_status_check
        CHECK (status = ANY (ARRAY['draft','in_progress','submitted','returned']));

    ALTER TABLE validations
      DROP CONSTRAINT IF EXISTS validations_status_check,
      ADD CONSTRAINT validations_status_check
        CHECK (status = ANY (ARRAY['pending','in_review','returned','rejected','pending_approval','closed']));
  `);
};
