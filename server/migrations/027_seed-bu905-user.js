/**
 * Migration 027 — Insert bu-905 (Enterprise Data, Risk & Insights Solutions / BU 997) user.
 *
 * The 03-seed-users.sql baseline includes this user but the Azure DB was bootstrapped
 * before the entry was added, so the user is absent from production. This migration
 * inserts it idempotently (ON CONFLICT DO NOTHING).
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active)
    VALUES ('bu-905', 'Enterprise Data, Risk & Insights Solutions', 'Responder', '["997"]', '997', true)
    ON CONFLICT (id) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM users WHERE id = 'bu-905';`);
};
