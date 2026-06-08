/**
 * Migration 005 – Add pending_approval status and rejection_comment to cycles
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Extend cycle status constraint to include pending_approval
    ALTER TABLE questionnaire_cycles DROP CONSTRAINT IF EXISTS questionnaire_cycles_status_check;
    ALTER TABLE questionnaire_cycles ADD CONSTRAINT questionnaire_cycles_status_check
      CHECK (status IN ('draft','pending_approval','published','distributed','closed'));

    -- Add rejection_comment column for Senior Validator feedback
    ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS rejection_comment TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE questionnaire_cycles DROP COLUMN IF EXISTS rejection_comment;

    UPDATE questionnaire_cycles SET status = 'draft' WHERE status = 'pending_approval';

    ALTER TABLE questionnaire_cycles DROP CONSTRAINT IF EXISTS questionnaire_cycles_status_check;
    ALTER TABLE questionnaire_cycles ADD CONSTRAINT questionnaire_cycles_status_check
      CHECK (status IN ('draft','published','distributed','closed'));
  `);
};
