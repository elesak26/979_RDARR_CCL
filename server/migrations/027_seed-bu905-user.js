/**
 * Migration 027 — Upsert bu-905 (GROUP IT PMO & GOVERNANCE DIVISION) user.
 *
 * Earlier migrations may have inserted bu-905 with stale display_name or unit_codes.
 * DO UPDATE ensures the row is corrected on any DB where it already exists.
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active)
    VALUES ('bu-905', 'GROUP IT PMO & GOVERNANCE DIVISION', 'Responder', '["905"]', '905', true)
    ON CONFLICT (id) DO UPDATE SET
      display_name       = EXCLUDED.display_name,
      unit_codes         = EXCLUDED.unit_codes,
      primary_unit_code  = EXCLUDED.primary_unit_code;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM users WHERE id = 'bu-905';`);
};
