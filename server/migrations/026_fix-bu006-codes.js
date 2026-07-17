/**
 * Migration 026 — Rename any bu_code='006' rows to '006-956'.
 *
 * When a cycle is distributed from an XLSX checklist, the distribute endpoint
 * failed to call normaliseBuCode() on the raw BU code, so BU 006 entries were
 * stored as bu_code='006' instead of '006-956'. The bu-006 user has
 * unit_codes=['006-956'], so those rows were invisible to them.
 *
 * This migration renames '006' → '006-956' in question_applicability and responses.
 * The matching unique constraints use NULLS NOT DISTINCT so an ON CONFLICT clause
 * is not needed — any duplicate (cycle, question, '006-956', material_risk) that
 * already exists is left untouched (the '006' row simply won't update to a duplicate).
 */
exports.up = (pgm) => {
  // question_applicability
  pgm.sql(`
    UPDATE question_applicability
    SET bu_code = '006-956'
    WHERE bu_code = '006'
      AND NOT EXISTS (
        SELECT 1 FROM question_applicability qa2
        WHERE qa2.cycle_id     = question_applicability.cycle_id
          AND qa2.question_id  = question_applicability.question_id
          AND qa2.bu_code      = '006-956'
          AND qa2.material_risk IS NOT DISTINCT FROM question_applicability.material_risk
      );
  `);

  // responses
  pgm.sql(`
    UPDATE responses
    SET bu_code = '006-956'
    WHERE bu_code = '006'
      AND NOT EXISTS (
        SELECT 1 FROM responses r2
        WHERE r2.cycle_id    = responses.cycle_id
          AND r2.question_id = responses.question_id
          AND r2.bu_code     = '006-956'
          AND r2.material_risk IS NOT DISTINCT FROM responses.material_risk
      );
  `);

  // validations (in case any were created under the wrong code)
  pgm.sql(`
    UPDATE validations
    SET bu_code = '006-956'
    WHERE bu_code = '006'
      AND NOT EXISTS (
        SELECT 1 FROM validations v2
        WHERE v2.cycle_id    = validations.cycle_id
          AND v2.question_id = validations.question_id
          AND v2.bu_code     = '006-956'
          AND v2.material_risk IS NOT DISTINCT FROM validations.material_risk
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE question_applicability SET bu_code = '006' WHERE bu_code = '006-956' AND NOT EXISTS (SELECT 1 FROM question_applicability qa2 WHERE qa2.cycle_id = question_applicability.cycle_id AND qa2.question_id = question_applicability.question_id AND qa2.bu_code = '006' AND qa2.material_risk IS NOT DISTINCT FROM question_applicability.material_risk);`);
  pgm.sql(`UPDATE responses SET bu_code = '006' WHERE bu_code = '006-956' AND NOT EXISTS (SELECT 1 FROM responses r2 WHERE r2.cycle_id = responses.cycle_id AND r2.question_id = responses.question_id AND r2.bu_code = '006' AND r2.material_risk IS NOT DISTINCT FROM responses.material_risk);`);
  pgm.sql(`UPDATE validations SET bu_code = '006' WHERE bu_code = '006-956' AND NOT EXISTS (SELECT 1 FROM validations v2 WHERE v2.cycle_id = validations.cycle_id AND v2.question_id = validations.question_id AND v2.bu_code = '006' AND v2.material_risk IS NOT DISTINCT FROM validations.material_risk);`);
};
