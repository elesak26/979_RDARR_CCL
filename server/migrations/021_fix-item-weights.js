/**
 * Migration 021 — Correct item weights to match column K of CCL_ELSA_with_Weights.xlsx
 *
 * Items 1, 2, and 25 had equal weights in migration 017.
 * Column K of the Excel defines unequal weights for these three items.
 * Item 3 already has weight 1.0 (single BU) — no change needed.
 * All other items have only equal weights in the Excel, so they remain as-is.
 *
 * After updating ccl_item_weights, we propagate the corrected weights to:
 *   - question_applicability.weight  (seeded at distribute-cycle time)
 *   - responses.weight               (seeded at distribute-cycle time)
 * for any existing cycles so that reporting and the validation overview
 * use the corrected weights immediately.
 */

exports.up = (pgm) => {
  // ── Item 1: 966=40%, 007=60% ──────────────────────────────────────────────
  pgm.sql(`
    UPDATE ccl_item_weights SET weight = 0.4, updated_at = now()
    WHERE item_number = 1 AND bu_code = '966';
    UPDATE ccl_item_weights SET weight = 0.6, updated_at = now()
    WHERE item_number = 1 AND bu_code = '007';
  `);

  // ── Item 2: 966=20%, 030=10%, 961-Market=10%, 961-IRRBB=2.5%,
  //           961-Liquidity=2.5%, 023=20%, 908=10%, 006-956=10%, 974=15% ────
  pgm.sql(`
    UPDATE ccl_item_weights SET weight = 0.20,  updated_at = now() WHERE item_number = 2 AND bu_code = '966';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 2 AND bu_code = '030';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 2 AND bu_code = '961-Market';
    UPDATE ccl_item_weights SET weight = 0.025, updated_at = now() WHERE item_number = 2 AND bu_code = '961-IRRBB';
    UPDATE ccl_item_weights SET weight = 0.025, updated_at = now() WHERE item_number = 2 AND bu_code = '961-Liquidity';
    UPDATE ccl_item_weights SET weight = 0.20,  updated_at = now() WHERE item_number = 2 AND bu_code = '023';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 2 AND bu_code = '908';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 2 AND bu_code = '006-956';
    UPDATE ccl_item_weights SET weight = 0.15,  updated_at = now() WHERE item_number = 2 AND bu_code = '974';
  `);

  // ── Item 25: 030=15%, 961-Market=10%, 961-IRRBB=2.5%, 961-Liquidity=2.5%,
  //            023=10%, 908=30%, 006-956=30% ──────────────────────────────────
  pgm.sql(`
    UPDATE ccl_item_weights SET weight = 0.15,  updated_at = now() WHERE item_number = 25 AND bu_code = '030';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 25 AND bu_code = '961-Market';
    UPDATE ccl_item_weights SET weight = 0.025, updated_at = now() WHERE item_number = 25 AND bu_code = '961-IRRBB';
    UPDATE ccl_item_weights SET weight = 0.025, updated_at = now() WHERE item_number = 25 AND bu_code = '961-Liquidity';
    UPDATE ccl_item_weights SET weight = 0.10,  updated_at = now() WHERE item_number = 25 AND bu_code = '023';
    UPDATE ccl_item_weights SET weight = 0.30,  updated_at = now() WHERE item_number = 25 AND bu_code = '908';
    UPDATE ccl_item_weights SET weight = 0.30,  updated_at = now() WHERE item_number = 25 AND bu_code = '006-956';
  `);

  // ── Propagate corrected weights to existing cycle data ────────────────────
  // question_applicability.weight
  pgm.sql(`
    UPDATE question_applicability qa
    SET weight = w.weight
    FROM questions q, ccl_item_weights w
    WHERE qa.question_id = q.id
      AND w.item_number = q.item_number
      AND w.bu_code = qa.bu_code
      AND q.item_number IN (1, 2, 25);
  `);

  // responses.weight
  pgm.sql(`
    UPDATE responses r
    SET weight = w.weight
    FROM questions q, ccl_item_weights w
    WHERE r.question_id = q.id
      AND w.item_number = q.item_number
      AND w.bu_code = r.bu_code
      AND q.item_number IN (1, 2, 25);
  `);
};

exports.down = (pgm) => {
  // Restore equal weights for items 1, 2, 25
  pgm.sql(`
    UPDATE ccl_item_weights SET weight = 0.5, updated_at = now()
    WHERE item_number = 1;

    UPDATE ccl_item_weights SET weight = 0.111111111111111111, updated_at = now()
    WHERE item_number = 2;

    UPDATE ccl_item_weights SET weight = 0.142857142857142857, updated_at = now()
    WHERE item_number = 25;
  `);

  // Restore equal weights in cycle data for items 1, 2, 25
  pgm.sql(`
    UPDATE question_applicability qa
    SET weight = w.weight
    FROM questions q, ccl_item_weights w
    WHERE qa.question_id = q.id
      AND w.item_number = q.item_number
      AND w.bu_code = qa.bu_code
      AND q.item_number IN (1, 2, 25);

    UPDATE responses r
    SET weight = w.weight
    FROM questions q, ccl_item_weights w
    WHERE r.question_id = q.id
      AND w.item_number = q.item_number
      AND w.bu_code = r.bu_code
      AND q.item_number IN (1, 2, 25);
  `);
};
