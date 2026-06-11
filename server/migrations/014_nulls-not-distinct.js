// Switch the (cycle, question, bu, material_risk) UNIQUE constraints to
// NULLS NOT DISTINCT so ON CONFLICT treats (…, NULL) as a single unique row.
//
// The live data already contains duplicate (cycle, question, bu, NULL) rows that
// the old NULLS-DISTINCT constraint permitted (distribute ran more than once,
// leaving empty draft stubs) — so the new constraint can't be created until those
// duplicates are removed. Deduplicate first, keeping the richest row per group
// (most attachments → most-complete status → has score → has comment → newest →
// lowest id), which only ever deletes empty stub copies, not real answers.
exports.up = (pgm) => {
  // 1. Deduplicate responses (NULLS NOT DISTINCT grouping via COALESCE)
  pgm.sql(`
    DELETE FROM responses WHERE id IN (
      SELECT id FROM (
        SELECT r.id, ROW_NUMBER() OVER (
          PARTITION BY r.cycle_id, r.question_id, r.bu_code, COALESCE(r.material_risk, '')
          ORDER BY
            (SELECT count(*) FROM response_attachments ra WHERE ra.response_id = r.id) DESC,
            CASE r.status WHEN 'submitted' THEN 3 WHEN 'in_progress' THEN 2 ELSE 1 END DESC,
            (r.compliance_score IS NOT NULL) DESC,
            (r.comments IS NOT NULL AND r.comments <> '') DESC,
            r.submitted_at DESC NULLS LAST,
            r.id ASC
        ) AS rn
        FROM responses r
      ) ranked WHERE rn > 1
    );
  `);
  // 2. Deduplicate question_applicability (no per-row data to preserve — keep lowest id)
  pgm.sql(`
    DELETE FROM question_applicability WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY cycle_id, question_id, bu_code, COALESCE(material_risk, '')
          ORDER BY id ASC
        ) AS rn
        FROM question_applicability
      ) ranked WHERE rn > 1
    );
  `);
  // 3. Swap the constraints to NULLS NOT DISTINCT
  pgm.sql(`
    ALTER TABLE question_applicability
      DROP CONSTRAINT IF EXISTS question_applicability_cycle_question_bu_risk_key,
      ADD CONSTRAINT question_applicability_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_cycle_question_bu_risk_key,
      ADD CONSTRAINT responses_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE question_applicability
      DROP CONSTRAINT IF EXISTS question_applicability_cycle_question_bu_risk_key,
      ADD CONSTRAINT question_applicability_cycle_question_bu_risk_key
        UNIQUE (cycle_id, question_id, bu_code, material_risk);
  `);
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_cycle_question_bu_risk_key,
      ADD CONSTRAINT responses_cycle_question_bu_risk_key
        UNIQUE (cycle_id, question_id, bu_code, material_risk);
  `);
};
