// One validation row per (cycle_id, question_id, bu_code, material_risk).
// Finance Division has two material risks per question; without this, both responses
// collapsed into a single validation row preventing per-risk validation.
exports.up = (pgm) => {
  // 1. Add material_risk column
  pgm.sql(`ALTER TABLE validations ADD COLUMN IF NOT EXISTS material_risk TEXT;`);

  // 2. Drop old unique constraint
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_key;`);

  // 3. Expand existing validation rows: for each validation that has multiple
  //    submitted responses differing only by material_risk, insert one row per risk.
  pgm.sql(`
    INSERT INTO validations (
      cycle_id, question_id, bu_code, material_risk, status, validation_score,
      justification, additional_controls, validated_by, validated_at,
      senior_validated_by, senior_validated_at, senior_rejection_comment,
      workflow_history
    )
    SELECT DISTINCT
      v.cycle_id, v.question_id, v.bu_code, r.material_risk, v.status, v.validation_score,
      v.justification, v.additional_controls, v.validated_by, v.validated_at,
      v.senior_validated_by, v.senior_validated_at, v.senior_rejection_comment,
      v.workflow_history
    FROM validations v
    JOIN responses r
      ON r.cycle_id = v.cycle_id
      AND r.question_id = v.question_id
      AND r.bu_code = v.bu_code
      AND r.material_risk IS NOT NULL
      AND r.status = 'submitted'
    WHERE v.material_risk IS NULL
    ON CONFLICT DO NOTHING;
  `);

  // 4. Remove old null-material_risk stub rows where per-risk rows now exist
  pgm.sql(`
    DELETE FROM validations v
    WHERE v.material_risk IS NULL
      AND EXISTS (
        SELECT 1 FROM validations v2
        WHERE v2.cycle_id = v.cycle_id
          AND v2.question_id = v.question_id
          AND v2.bu_code = v.bu_code
          AND v2.material_risk IS NOT NULL
      );
  `);

  // 5. Add new unique constraint including material_risk
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_risk_key;`);
  pgm.sql(`
    DELETE FROM validations v
    WHERE v.id NOT IN (
      SELECT MIN(id) FROM validations GROUP BY cycle_id, question_id, bu_code
    );
  `);
  pgm.sql(`UPDATE validations SET material_risk = NULL;`);
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_question_bu_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code);
  `);
  pgm.sql(`ALTER TABLE validations DROP COLUMN IF EXISTS material_risk;`);
};
