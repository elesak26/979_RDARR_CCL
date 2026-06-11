// Fix: UNIQUE constraints on material_risk NULL columns must use NULLS NOT DISTINCT
// so that ON CONFLICT correctly treats (cycle, question, bu, NULL) as a single unique row.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE question_applicability
      DROP CONSTRAINT question_applicability_cycle_question_bu_risk_key,
      ADD CONSTRAINT question_applicability_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT responses_cycle_question_bu_risk_key,
      ADD CONSTRAINT responses_cycle_question_bu_risk_key
        UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE question_applicability
      DROP CONSTRAINT question_applicability_cycle_question_bu_risk_key,
      ADD CONSTRAINT question_applicability_cycle_question_bu_risk_key
        UNIQUE (cycle_id, question_id, bu_code, material_risk);
  `);
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT responses_cycle_question_bu_risk_key,
      ADD CONSTRAINT responses_cycle_question_bu_risk_key
        UNIQUE (cycle_id, question_id, bu_code, material_risk);
  `);
};
