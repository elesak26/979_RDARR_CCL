/**
 * Migration 004 – Add Senior Validator role and pending_approval status
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Add 'Senior Validator' to users role constraint
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('Admin','Validator','Senior Validator','Responder','Viewer'));

    -- Add 'pending_approval' to validations status constraint
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','pending_approval','closed'));

    -- Add senior validator columns to validations
    ALTER TABLE validations ADD COLUMN IF NOT EXISTS senior_validated_by TEXT;
    ALTER TABLE validations ADD COLUMN IF NOT EXISTS senior_validated_at TIMESTAMPTZ;
    ALTER TABLE validations ADD COLUMN IF NOT EXISTS senior_rejection_comment TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Drop senior validator columns from validations
    ALTER TABLE validations DROP COLUMN IF EXISTS senior_rejection_comment;
    ALTER TABLE validations DROP COLUMN IF EXISTS senior_validated_at;
    ALTER TABLE validations DROP COLUMN IF EXISTS senior_validated_by;

    -- Revert validations status constraint (remove pending_approval)
    UPDATE validations SET status = 'in_review' WHERE status = 'pending_approval';
    ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_status_check;
    ALTER TABLE validations ADD CONSTRAINT validations_status_check
      CHECK (status IN ('pending','in_review','closed'));

    -- Revert users role constraint (remove Senior Validator)
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('Admin','Validator','Responder','Viewer'));
  `);
};
