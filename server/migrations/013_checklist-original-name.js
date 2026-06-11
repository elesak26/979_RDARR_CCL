exports.up = async (db) => {
  await db.query(`ALTER TABLE questionnaire_cycles ADD COLUMN IF NOT EXISTS checklist_original_name TEXT`);
};

exports.down = async (db) => {
  await db.query(`ALTER TABLE questionnaire_cycles DROP COLUMN IF EXISTS checklist_original_name`);
};
