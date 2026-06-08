/**
 * Migration 001 – Initial schema for NBG RDARR Compliance Checklist
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- users
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Admin','Validator','Responder','Viewer')),
      unit_codes TEXT[] NOT NULL DEFAULT '{}',
      primary_unit_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- questionnaire_cycles
    CREATE TABLE IF NOT EXISTS questionnaire_cycles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','distributed','closed')),
      created_by TEXT,
      published_at TIMESTAMPTZ,
      distributed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- questions (seeded from Excel — 40 total)
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      item_number INTEGER NOT NULL UNIQUE,
      thematic_area TEXT NOT NULL,
      requirement TEXT NOT NULL,
      bcbs_principle_number INTEGER,
      bcbs_principle_name TEXT,
      ecb_reference TEXT,
      expectations TEXT,
      score_1_desc TEXT,
      score_2_desc TEXT,
      score_3_desc TEXT,
      score_4_desc TEXT,
      respondents_hint TEXT,
      supportive_material TEXT,
      related_kpis TEXT
    );

    -- question_applicability: which BU answers which question per cycle
    CREATE TABLE IF NOT EXISTS question_applicability (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      bu_code TEXT NOT NULL,
      bu_name TEXT NOT NULL,
      assigned_by TEXT,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(cycle_id, question_id, bu_code)
    );

    -- responses: one per BU per question per cycle
    CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      bu_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
      compliance_score INTEGER CHECK (compliance_score BETWEEN 1 AND 4),
      comments TEXT,
      responder_id TEXT,
      responder_name TEXT,
      submitted_at TIMESTAMPTZ,
      return_comment TEXT,
      returned_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(cycle_id, question_id, bu_code)
    );

    -- response_attachments
    CREATE TABLE IF NOT EXISTS response_attachments (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- validations: one per question per cycle — created when all BUs submit
    CREATE TABLE IF NOT EXISTS validations (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_review','closed')),
      validation_score INTEGER CHECK (validation_score BETWEEN 1 AND 4),
      justification TEXT,
      additional_controls TEXT,
      validated_by TEXT,
      validated_at TIMESTAMPTZ,
      workflow_history JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(cycle_id, question_id)
    );

    -- validation_attachments
    CREATE TABLE IF NOT EXISTS validation_attachments (
      id SERIAL PRIMARY KEY,
      validation_id INTEGER NOT NULL REFERENCES validations(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- audit_log
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT,
      actor_name TEXT,
      actor_role TEXT,
      old_value JSONB,
      new_value JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_log CASCADE;
    DROP TABLE IF EXISTS validation_attachments CASCADE;
    DROP TABLE IF EXISTS validations CASCADE;
    DROP TABLE IF EXISTS response_attachments CASCADE;
    DROP TABLE IF EXISTS responses CASCADE;
    DROP TABLE IF EXISTS question_applicability CASCADE;
    DROP TABLE IF EXISTS questions CASCADE;
    DROP TABLE IF EXISTS questionnaire_cycles CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
};
