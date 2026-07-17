/**
 * Migration 025 — Ensure validations.material_risk column and correct unique constraint exist.
 *
 * Migration 024 added material_risk and replaced the (cycle, question, bu) unique key with
 * (cycle, question, bu, material_risk). The 00-schema.sql baseline was not updated at that
 * time, so any environment bootstrapped from the baseline (or that somehow missed 024) has
 * the old constraint. The submit-all and single-submit endpoints use
 *   ON CONFLICT (cycle_id, question_id, bu_code, material_risk)
 * which fails with "no unique constraint matching ON CONFLICT" when material_risk is absent
 * from the constraint — producing a 500 Internal Server Error on submit.
 *
 * This migration is idempotent: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS.
 */
exports.up = (pgm) => {
  // 1. Ensure material_risk column exists (no-op if 024 already ran)
  pgm.sql(`ALTER TABLE validations ADD COLUMN IF NOT EXISTS material_risk TEXT;`);

  // 2. Drop the old three-column constraint (may or may not exist)
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_key;`);

  // 3. Drop the new four-column constraint in case it already exists (so ADD below is idempotent)
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_risk_key;`);

  // 4. Re-create the correct four-column NULLS NOT DISTINCT unique constraint
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_risk_key;`);
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_question_bu_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code);
  `);
  pgm.sql(`ALTER TABLE validations DROP COLUMN IF EXISTS material_risk;`);
};
