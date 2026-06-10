/**
 * Migration 008 – Add material_risk support.
 *
 * 1. Add material_risk TEXT to questions (nullable – not all questions have one)
 * 2. Add material_risk TEXT to question_applicability and responses
 * 3. Update unique constraints to include material_risk (so BU 961 can have
 *    multiple rows for the same question, one per risk)
 * 4. Seed material_risk values into questions from the Excel column M data.
 *    Separator in the Excel is comma; values are stored as-is (comma-separated)
 *    so the server can split on ', ' at distribute time.
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Add material_risk to questions
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS material_risk TEXT;

    -- Seed material_risk for the 22 questions that have column M populated
    UPDATE questions SET material_risk = 'Market Risk, Liquidity Risk, IRRBB Risk'
    WHERE item_number IN (2,8,12,13,14,19,21,23,25,27,28,29,30,31,33,34,35,36,37,38,39,40);

    -- 2. Add material_risk to question_applicability (nullable; only BU 961 rows will have it)
    ALTER TABLE question_applicability ADD COLUMN IF NOT EXISTS material_risk TEXT;

    -- Drop old unique constraint and recreate including material_risk
    ALTER TABLE question_applicability
      DROP CONSTRAINT IF EXISTS question_applicability_cycle_id_question_id_bu_code_key;
    ALTER TABLE question_applicability
      ADD CONSTRAINT question_applicability_cycle_question_bu_risk_key
      UNIQUE (cycle_id, question_id, bu_code, material_risk);

    -- 3. Add material_risk to responses
    ALTER TABLE responses ADD COLUMN IF NOT EXISTS material_risk TEXT;

    -- Drop old unique constraint and recreate including material_risk
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_cycle_id_question_id_bu_code_key;
    ALTER TABLE responses
      ADD CONSTRAINT responses_cycle_question_bu_risk_key
      UNIQUE (cycle_id, question_id, bu_code, material_risk);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE responses
      DROP CONSTRAINT IF EXISTS responses_cycle_question_bu_risk_key;
    ALTER TABLE responses
      ADD CONSTRAINT responses_cycle_id_question_id_bu_code_key
      UNIQUE (cycle_id, question_id, bu_code);
    ALTER TABLE responses DROP COLUMN IF EXISTS material_risk;

    ALTER TABLE question_applicability
      DROP CONSTRAINT IF EXISTS question_applicability_cycle_question_bu_risk_key;
    ALTER TABLE question_applicability
      ADD CONSTRAINT question_applicability_cycle_id_question_id_bu_code_key
      UNIQUE (cycle_id, question_id, bu_code);
    ALTER TABLE question_applicability DROP COLUMN IF EXISTS material_risk;

    ALTER TABLE questions DROP COLUMN IF EXISTS material_risk;
  `);
};
