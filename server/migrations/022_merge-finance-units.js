/**
 * Migration 022 — Merge Finance Function (006) and (956) into a single
 * Finance Division user with bu_code '006-956'.
 *
 * Background: 006-956 is treated as one combined respondent (Finance Division)
 * per the CCL Respondents Units document (row 8: unit '006-956', Finance Division).
 * Previously two separate user accounts existed (bu-006, bu-956). This migration
 * repurposes bu-006 as the single canonical Finance Division account and
 * deactivates bu-956.
 *
 * NOTE: bu-006's id cannot be renamed because login_history references it via FK.
 * The id stays 'bu-006'; only display_name, unit_codes, and primary_unit_code change.
 */

exports.up = (pgm) => {
  // Repurpose bu-006 as the single Finance Division account
  pgm.sql(`
    UPDATE users
    SET
      display_name      = 'Finance Division (006-956)',
      unit_codes        = ARRAY['006-956'],
      primary_unit_code = '006-956'
    WHERE id = 'bu-006';
  `);

  // Deactivate the redundant bu-956 account
  pgm.sql(`
    UPDATE users
    SET is_active = false
    WHERE id = 'bu-956';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE users
    SET
      display_name      = 'Finance Function (006)',
      unit_codes        = ARRAY['006', '006-956'],
      primary_unit_code = '006'
    WHERE id = 'bu-006';

    UPDATE users
    SET is_active = true
    WHERE id = 'bu-956';
  `);
};
