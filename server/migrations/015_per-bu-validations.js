// One validation row per (cycle_id, question_id, bu_code) instead of per (cycle_id, question_id).
// This allows the Validator to score each BU's self-assessment independently.
exports.up = (pgm) => {
  // 1. Drop old unique constraint
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT validations_cycle_id_question_id_key;`);

  // 2. Add bu_code column
  pgm.sql(`ALTER TABLE validations ADD COLUMN IF NOT EXISTS bu_code TEXT;`);

  // 3. Expand existing rows: for each validation, insert one row per BU that has a submitted response
  pgm.sql(`
    INSERT INTO validations (
      cycle_id, question_id, bu_code, status, validation_score,
      justification, additional_controls, validated_by, validated_at,
      senior_validated_by, senior_validated_at, senior_rejection_comment,
      workflow_history
    )
    SELECT
      v.cycle_id, v.question_id, r.bu_code, v.status, v.validation_score,
      v.justification, v.additional_controls, v.validated_by, v.validated_at,
      v.senior_validated_by, v.senior_validated_at, v.senior_rejection_comment,
      v.workflow_history
    FROM validations v
    JOIN (
      SELECT DISTINCT cycle_id, question_id, bu_code
      FROM responses
      WHERE status = 'submitted'
    ) r ON r.cycle_id = v.cycle_id AND r.question_id = v.question_id
    WHERE v.bu_code IS NULL
    ON CONFLICT DO NOTHING;
  `);

  // 4. Remove old stub rows where per-BU rows now exist
  pgm.sql(`
    DELETE FROM validations v
    WHERE v.bu_code IS NULL
      AND EXISTS (
        SELECT 1 FROM validations v2
        WHERE v2.cycle_id = v.cycle_id
          AND v2.question_id = v.question_id
          AND v2.bu_code IS NOT NULL
      );
  `);

  // 5. Add new unique constraint
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_question_bu_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE validations DROP CONSTRAINT IF EXISTS validations_cycle_question_bu_key;`);
  pgm.sql(`
    DELETE FROM validations v
    WHERE v.id NOT IN (
      SELECT MAX(id) FROM validations GROUP BY cycle_id, question_id
    );
  `);
  pgm.sql(`ALTER TABLE validations DROP COLUMN IF EXISTS bu_code;`);
  pgm.sql(`
    ALTER TABLE validations
      ADD CONSTRAINT validations_cycle_id_question_id_key
        UNIQUE (cycle_id, question_id);
  `);
};
