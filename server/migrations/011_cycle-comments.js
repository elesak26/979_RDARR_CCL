exports.up = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cycle_comments (
      id         SERIAL PRIMARY KEY,
      cycle_id   INTEGER NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL,
      user_name  TEXT NOT NULL,
      user_role  TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS cycle_comments_cycle_id_idx ON cycle_comments(cycle_id)`);
};

exports.down = async (db) => {
  await db.query(`DROP TABLE IF EXISTS cycle_comments`);
};
