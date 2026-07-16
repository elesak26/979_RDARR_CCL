-- CCL Questionnaire — PostgreSQL schema baseline.
-- Idempotent: safe to re-run (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).

-- ---------- questionnaire_cycles ----------
CREATE TABLE IF NOT EXISTS questionnaire_cycles (
  id                      serial PRIMARY KEY,
  name                    text NOT NULL,
  year                    int NOT NULL,
  status                  text NOT NULL DEFAULT 'draft',
  created_by              text,
  published_at            timestamptz,
  distributed_at          timestamptz,
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  rejection_comment       text,
  checklist_file          text,
  description             text,
  checklist_original_name text,
  CONSTRAINT questionnaire_cycles_status_check
    CHECK (status IN ('draft','pending_approval','published','distributed','closed'))
);

-- ---------- questions ----------
CREATE TABLE IF NOT EXISTS questions (
  id                    serial PRIMARY KEY,
  item_number           int NOT NULL UNIQUE,
  thematic_area         text NOT NULL,
  requirement           text NOT NULL,
  bcbs_principle_number int,
  bcbs_principle_name   text,
  ecb_reference         text,
  expectations          text,
  score_1_desc          text,
  score_2_desc          text,
  score_3_desc          text,
  score_4_desc          text,
  respondents_hint      text,
  supportive_material   text,
  related_kpis          text,
  material_risk         text
);

-- ---------- respondent_units ----------
CREATE TABLE IF NOT EXISTS respondent_units (
  bu_code    text PRIMARY KEY,
  bu_name    text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id                text PRIMARY KEY,
  display_name      text NOT NULL,
  role              text NOT NULL,
  unit_codes        jsonb NOT NULL DEFAULT '[]',
  primary_unit_code text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  is_active         boolean NOT NULL DEFAULT true,
  CONSTRAINT users_role_check
    CHECK (role IN ('Admin','Validator','Senior Validator','Responder','Viewer'))
);

-- ---------- audit_log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          serial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  action      text NOT NULL,
  actor_id    text,
  actor_name  text,
  actor_role  text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cycle_id    int,
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id    ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_cycle_id    ON audit_log (cycle_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_type ON audit_log (entity_type);

-- ---------- login_history ----------
CREATE TABLE IF NOT EXISTS login_history (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL,
  display_name text,
  role         text,
  ip_address   text,
  user_agent   text,
  logged_in_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_history_logged_in_at ON login_history (logged_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_user_id      ON login_history (user_id);

-- ---------- cycle_comments ----------
CREATE TABLE IF NOT EXISTS cycle_comments (
  id         serial PRIMARY KEY,
  cycle_id   int NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  user_name  text NOT NULL,
  user_role  text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cycle_comments_cycle_id_idx ON cycle_comments (cycle_id);

-- ---------- notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id         serial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  body       text NOT NULL,
  cycle_id   int REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
  is_read    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  link       text
);
CREATE INDEX IF NOT EXISTS notifications_user_id_idx
  ON notifications (user_id, is_read, created_at DESC);

-- ---------- question_applicability ----------
CREATE TABLE IF NOT EXISTS question_applicability (
  id            serial PRIMARY KEY,
  cycle_id      int NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
  question_id   int NOT NULL REFERENCES questions(id),
  bu_code       text NOT NULL,
  bu_name       text NOT NULL,
  assigned_by   text,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  material_risk text,
  weight        numeric(10,6),
  CONSTRAINT question_applicability_cycle_question_bu_risk_key
    UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk)
);

-- ---------- responses ----------
CREATE TABLE IF NOT EXISTS responses (
  id               serial PRIMARY KEY,
  cycle_id         int NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
  question_id      int NOT NULL REFERENCES questions(id),
  bu_code          text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  compliance_score int,
  comments         text,
  responder_id     text,
  responder_name   text,
  submitted_at     timestamptz,
  return_comment   text,
  returned_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  material_risk    text,
  weight           numeric(10,6),
  CONSTRAINT responses_compliance_score_check CHECK (compliance_score >= 1 AND compliance_score <= 4),
  CONSTRAINT responses_status_check CHECK (status IN ('draft','in_progress','submitted','returned','cancelled')),
  CONSTRAINT responses_cycle_question_bu_risk_key
    UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk)
);

-- ---------- validations ----------
CREATE TABLE IF NOT EXISTS validations (
  id                       serial PRIMARY KEY,
  cycle_id                 int NOT NULL REFERENCES questionnaire_cycles(id) ON DELETE CASCADE,
  question_id              int NOT NULL REFERENCES questions(id),
  status                   text NOT NULL DEFAULT 'pending',
  validation_score         int,
  justification            text,
  additional_controls      text,
  validated_by             text,
  validated_at             timestamptz,
  workflow_history         jsonb NOT NULL DEFAULT '[]',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  senior_validated_by      text,
  senior_validated_at      timestamptz,
  senior_rejection_comment text,
  bu_code                  text,
  CONSTRAINT validations_validation_score_check CHECK (validation_score >= 1 AND validation_score <= 4),
  CONSTRAINT validations_status_check
    CHECK (status IN ('pending','in_review','returned','rejected','pending_approval','closed','cancelled')),
  CONSTRAINT validations_cycle_question_bu_key
    UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code)
);

-- ---------- ccl_item_weights ----------
CREATE TABLE IF NOT EXISTS ccl_item_weights (
  item_number int NOT NULL,
  bu_code     text NOT NULL REFERENCES respondent_units(bu_code) ON UPDATE CASCADE,
  weight      numeric(20,18) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_number, bu_code),
  CONSTRAINT ccl_item_weights_weight_check CHECK (weight > 0 AND weight <= 1)
);

-- ---------- response_attachments ----------
CREATE TABLE IF NOT EXISTS response_attachments (
  id          serial PRIMARY KEY,
  response_id int NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  file_path   text NOT NULL,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- validation_attachments ----------
CREATE TABLE IF NOT EXISTS validation_attachments (
  id            serial PRIMARY KEY,
  validation_id int NOT NULL REFERENCES validations(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  file_path     text NOT NULL,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
