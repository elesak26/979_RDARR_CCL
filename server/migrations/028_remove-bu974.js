/**
 * Migration 028: Remove BU 974 (Internal Control Function) from all tables.
 * BU 997 had no records in the DB and requires no action.
 */
exports.up = async (db) => {
  await db.query(`
    DELETE FROM ccl_item_weights        WHERE bu_code = '974';
    DELETE FROM question_applicability  WHERE bu_code = '974';
    DELETE FROM validations             WHERE bu_code = '974';
    DELETE FROM responses               WHERE bu_code = '974';
    DELETE FROM users                   WHERE id = 'bu-974';
  `);
};

exports.down = async (db) => {
  // Re-insert the user only; weights/applicability/responses are not restored
  // as they depend on cycle-specific data that is no longer available.
  await db.query(`
    INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active)
    VALUES ('bu-974', 'Internal Control Function', 'Responder', '["974"]', '974', true)
    ON CONFLICT (id) DO NOTHING;
  `);
};
