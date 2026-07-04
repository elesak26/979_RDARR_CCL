-- ============================================================================
-- NBG RDARR Compliance Checklist — Azure SQL Database schema baseline (T-SQL).
-- Faithful port of the PostgreSQL schema (server/migrations/001..022) — 14 base
-- tables in schema dbo. See ~/_azuresql-migration/CONTRACT.md for the frozen
-- type-mapping rules. Migration-tracking table (app.schema_migrations) is owned
-- by scripts/run-migrations.ts and is NOT defined here.
--
-- Conventions (idempotent, re-runnable by scripts/run-migrations.ts which splits GO):
--   * Tables live in dbo (SQL Server default schema) so the app's unqualified
--     raw SQL resolves without change.
--   * text            -> nvarchar(max)  (Greek needs Unicode); indexed/keyed text
--                        -> bounded nvarchar (64|200|450) so it is indexable.
--   * text[] (arrays) -> nvarchar(max) JSON array, DEFAULT N'[]', CHECK(ISJSON)=1
--   * jsonb           -> nvarchar(max) + CHECK(ISJSON)=1 (+ original default)
--   * serial/bigserial-> int/bigint IDENTITY(1,1)
--   * boolean         -> bit
--   * timestamptz     -> datetimeoffset DEFAULT SYSDATETIMEOFFSET()
--   * numeric(p,s)    -> decimal(p,s)
--   * UNIQUE NULLS NOT DISTINCT (a,b,c) -> COALESCE(nullable,N'#NULL#') PERSISTED
--     computed key column + unique index (SPIKE T5).
-- ============================================================================
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

-- ---------- questionnaire_cycles (referenced by several FKs — create first) ----------
IF OBJECT_ID('dbo.questionnaire_cycles', 'U') IS NULL
CREATE TABLE dbo.questionnaire_cycles (
  id                      int IDENTITY(1,1) NOT NULL CONSTRAINT questionnaire_cycles_pkey PRIMARY KEY,
  name                    nvarchar(max) NOT NULL,
  year                    int NOT NULL,
  status                  nvarchar(64) NOT NULL CONSTRAINT DF_questionnaire_cycles_status DEFAULT N'draft',
  created_by              nvarchar(max) NULL,
  published_at            datetimeoffset NULL,
  distributed_at          datetimeoffset NULL,
  closed_at               datetimeoffset NULL,
  created_at              datetimeoffset NOT NULL CONSTRAINT DF_questionnaire_cycles_created_at DEFAULT SYSDATETIMEOFFSET(),
  updated_at              datetimeoffset NOT NULL CONSTRAINT DF_questionnaire_cycles_updated_at DEFAULT SYSDATETIMEOFFSET(),
  rejection_comment       nvarchar(max) NULL,
  checklist_file          nvarchar(max) NULL,
  description             nvarchar(max) NULL,
  checklist_original_name nvarchar(max) NULL,
  CONSTRAINT questionnaire_cycles_status_check CHECK (status IN (N'draft', N'pending_approval', N'published', N'distributed', N'closed'))
);
GO

-- ---------- questions ----------
IF OBJECT_ID('dbo.questions', 'U') IS NULL
CREATE TABLE dbo.questions (
  id                    int IDENTITY(1,1) NOT NULL CONSTRAINT questions_pkey PRIMARY KEY,
  item_number           int NOT NULL CONSTRAINT questions_item_number_key UNIQUE,
  thematic_area         nvarchar(max) NOT NULL,
  requirement           nvarchar(max) NOT NULL,
  bcbs_principle_number int NULL,
  bcbs_principle_name   nvarchar(max) NULL,
  ecb_reference         nvarchar(max) NULL,
  expectations          nvarchar(max) NULL,
  score_1_desc          nvarchar(max) NULL,
  score_2_desc          nvarchar(max) NULL,
  score_3_desc          nvarchar(max) NULL,
  score_4_desc          nvarchar(max) NULL,
  respondents_hint      nvarchar(max) NULL,
  supportive_material   nvarchar(max) NULL,
  related_kpis          nvarchar(max) NULL,
  material_risk         nvarchar(max) NULL
);
GO

-- ---------- respondent_units ----------
IF OBJECT_ID('dbo.respondent_units', 'U') IS NULL
CREATE TABLE dbo.respondent_units (
  bu_code    nvarchar(200) NOT NULL CONSTRAINT respondent_units_pkey PRIMARY KEY,
  bu_name    nvarchar(max) NOT NULL,
  sort_order int NOT NULL CONSTRAINT DF_respondent_units_sort_order DEFAULT 0,
  created_at datetimeoffset NOT NULL CONSTRAINT DF_respondent_units_created_at DEFAULT SYSDATETIMEOFFSET()
);
GO

-- ---------- users ----------
IF OBJECT_ID('dbo.users', 'U') IS NULL
CREATE TABLE dbo.users (
  id                nvarchar(450) NOT NULL CONSTRAINT users_pkey PRIMARY KEY,
  display_name      nvarchar(max) NOT NULL,
  role              nvarchar(64) NOT NULL,
  unit_codes        nvarchar(max) NOT NULL CONSTRAINT DF_users_unit_codes DEFAULT N'[]' CONSTRAINT CK_users_unit_codes CHECK (ISJSON(unit_codes) = 1),
  primary_unit_code nvarchar(max) NULL,
  created_at        datetimeoffset NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSDATETIMEOFFSET(),
  is_active         bit NOT NULL CONSTRAINT DF_users_is_active DEFAULT 1,
  CONSTRAINT users_role_check CHECK (role IN (N'Admin', N'Validator', N'Senior Validator', N'Responder', N'Viewer'))
);
GO

-- ---------- audit_log ----------
IF OBJECT_ID('dbo.audit_log', 'U') IS NULL
CREATE TABLE dbo.audit_log (
  id          int IDENTITY(1,1) NOT NULL CONSTRAINT audit_log_pkey PRIMARY KEY,
  entity_type nvarchar(64)  NOT NULL,           -- indexed (idx_audit_log_entity_type)
  entity_id   nvarchar(max) NOT NULL,
  action      nvarchar(max) NOT NULL,
  actor_id    nvarchar(450) NULL,               -- indexed (idx_audit_log_actor_id)
  actor_name  nvarchar(max) NULL,
  actor_role  nvarchar(max) NULL,
  old_value   nvarchar(max) NULL CONSTRAINT CK_audit_log_old_value CHECK (old_value IS NULL OR ISJSON(old_value) = 1),
  new_value   nvarchar(max) NULL CONSTRAINT CK_audit_log_new_value CHECK (new_value IS NULL OR ISJSON(new_value) = 1),
  created_at  datetimeoffset NOT NULL CONSTRAINT DF_audit_log_created_at DEFAULT SYSDATETIMEOFFSET(),
  cycle_id    int NULL,
  details     nvarchar(max) NOT NULL CONSTRAINT DF_audit_log_details DEFAULT N'{}' CONSTRAINT CK_audit_log_details CHECK (ISJSON(details) = 1)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_actor_id' AND object_id = OBJECT_ID('dbo.audit_log'))
  CREATE INDEX idx_audit_log_actor_id ON dbo.audit_log (actor_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_created_at' AND object_id = OBJECT_ID('dbo.audit_log'))
  CREATE INDEX idx_audit_log_created_at ON dbo.audit_log (created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_cycle_id' AND object_id = OBJECT_ID('dbo.audit_log'))
  CREATE INDEX idx_audit_log_cycle_id ON dbo.audit_log (cycle_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_log_entity_type' AND object_id = OBJECT_ID('dbo.audit_log'))
  CREATE INDEX idx_audit_log_entity_type ON dbo.audit_log (entity_type);
GO

-- ---------- login_history ----------
IF OBJECT_ID('dbo.login_history', 'U') IS NULL
CREATE TABLE dbo.login_history (
  id           bigint IDENTITY(1,1) NOT NULL CONSTRAINT login_history_pkey PRIMARY KEY,
  user_id      nvarchar(450) NOT NULL,          -- indexed (idx_login_history_user_id)
  display_name nvarchar(max) NULL,
  role         nvarchar(max) NULL,
  ip_address   nvarchar(max) NULL,
  user_agent   nvarchar(max) NULL,
  logged_in_at datetimeoffset NOT NULL CONSTRAINT DF_login_history_logged_in_at DEFAULT SYSDATETIMEOFFSET()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_login_history_logged_in_at' AND object_id = OBJECT_ID('dbo.login_history'))
  CREATE INDEX idx_login_history_logged_in_at ON dbo.login_history (logged_in_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_login_history_user_id' AND object_id = OBJECT_ID('dbo.login_history'))
  CREATE INDEX idx_login_history_user_id ON dbo.login_history (user_id);
GO

-- ---------- cycle_comments ----------
IF OBJECT_ID('dbo.cycle_comments', 'U') IS NULL
CREATE TABLE dbo.cycle_comments (
  id         int IDENTITY(1,1) NOT NULL CONSTRAINT cycle_comments_pkey PRIMARY KEY,
  cycle_id   int NOT NULL,
  user_id    nvarchar(max) NOT NULL,
  user_name  nvarchar(max) NOT NULL,
  user_role  nvarchar(max) NOT NULL,
  body       nvarchar(max) NOT NULL,
  created_at datetimeoffset NOT NULL CONSTRAINT DF_cycle_comments_created_at DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT cycle_comments_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES dbo.questionnaire_cycles(id) ON DELETE CASCADE
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'cycle_comments_cycle_id_idx' AND object_id = OBJECT_ID('dbo.cycle_comments'))
  CREATE INDEX cycle_comments_cycle_id_idx ON dbo.cycle_comments (cycle_id);
GO

-- ---------- notifications ----------
IF OBJECT_ID('dbo.notifications', 'U') IS NULL
CREATE TABLE dbo.notifications (
  id         int IDENTITY(1,1) NOT NULL CONSTRAINT notifications_pkey PRIMARY KEY,
  user_id    nvarchar(450) NOT NULL,
  title      nvarchar(max) NOT NULL,
  body       nvarchar(max) NOT NULL,
  cycle_id   int NULL,
  is_read    bit NOT NULL CONSTRAINT DF_notifications_is_read DEFAULT 0,
  created_at datetimeoffset NOT NULL CONSTRAINT DF_notifications_created_at DEFAULT SYSDATETIMEOFFSET(),
  link       nvarchar(max) NULL,
  CONSTRAINT notifications_user_id_fkey  FOREIGN KEY (user_id)  REFERENCES dbo.users(id) ON DELETE CASCADE,
  CONSTRAINT notifications_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES dbo.questionnaire_cycles(id) ON DELETE CASCADE
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'notifications_user_id_idx' AND object_id = OBJECT_ID('dbo.notifications'))
  CREATE INDEX notifications_user_id_idx ON dbo.notifications (user_id, is_read, created_at DESC);
GO

-- ---------- question_applicability ----------
-- UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk):
-- material_risk is the only nullable key part -> sentinel-coalesce computed key.
IF OBJECT_ID('dbo.question_applicability', 'U') IS NULL
CREATE TABLE dbo.question_applicability (
  id                int IDENTITY(1,1) NOT NULL CONSTRAINT question_applicability_pkey PRIMARY KEY,
  cycle_id          int NOT NULL,
  question_id       int NOT NULL,
  bu_code           nvarchar(200) NOT NULL,
  bu_name           nvarchar(max) NOT NULL,
  assigned_by       nvarchar(max) NULL,
  assigned_at       datetimeoffset NOT NULL CONSTRAINT DF_question_applicability_assigned_at DEFAULT SYSDATETIMEOFFSET(),
  material_risk     nvarchar(200) NULL,
  weight            decimal(10,6) NULL,
  material_risk_key AS COALESCE(material_risk, N'#NULL#') PERSISTED,
  CONSTRAINT question_applicability_cycle_id_fkey    FOREIGN KEY (cycle_id)    REFERENCES dbo.questionnaire_cycles(id) ON DELETE CASCADE,
  CONSTRAINT question_applicability_question_id_fkey FOREIGN KEY (question_id) REFERENCES dbo.questions(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'question_applicability_cycle_question_bu_risk_key' AND object_id = OBJECT_ID('dbo.question_applicability'))
  CREATE UNIQUE INDEX question_applicability_cycle_question_bu_risk_key
    ON dbo.question_applicability (cycle_id, question_id, bu_code, material_risk_key);
GO

-- ---------- responses ----------
-- UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code, material_risk).
IF OBJECT_ID('dbo.responses', 'U') IS NULL
CREATE TABLE dbo.responses (
  id                int IDENTITY(1,1) NOT NULL CONSTRAINT responses_pkey PRIMARY KEY,
  cycle_id          int NOT NULL,
  question_id       int NOT NULL,
  bu_code           nvarchar(200) NOT NULL,
  status            nvarchar(64) NOT NULL CONSTRAINT DF_responses_status DEFAULT N'draft',
  compliance_score  int NULL,
  comments          nvarchar(max) NULL,
  responder_id      nvarchar(max) NULL,
  responder_name    nvarchar(max) NULL,
  submitted_at      datetimeoffset NULL,
  return_comment    nvarchar(max) NULL,
  returned_at       datetimeoffset NULL,
  created_at        datetimeoffset NOT NULL CONSTRAINT DF_responses_created_at DEFAULT SYSDATETIMEOFFSET(),
  updated_at        datetimeoffset NOT NULL CONSTRAINT DF_responses_updated_at DEFAULT SYSDATETIMEOFFSET(),
  material_risk     nvarchar(200) NULL,
  weight            decimal(10,6) NULL,
  material_risk_key AS COALESCE(material_risk, N'#NULL#') PERSISTED,
  CONSTRAINT responses_compliance_score_check CHECK (compliance_score >= 1 AND compliance_score <= 4),
  CONSTRAINT responses_status_check CHECK (status IN (N'draft', N'in_progress', N'submitted', N'returned')),
  CONSTRAINT responses_cycle_id_fkey    FOREIGN KEY (cycle_id)    REFERENCES dbo.questionnaire_cycles(id) ON DELETE CASCADE,
  CONSTRAINT responses_question_id_fkey FOREIGN KEY (question_id) REFERENCES dbo.questions(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'responses_cycle_question_bu_risk_key' AND object_id = OBJECT_ID('dbo.responses'))
  CREATE UNIQUE INDEX responses_cycle_question_bu_risk_key
    ON dbo.responses (cycle_id, question_id, bu_code, material_risk_key);
GO

-- ---------- validations ----------
-- UNIQUE NULLS NOT DISTINCT (cycle_id, question_id, bu_code): bu_code nullable -> sentinel key.
IF OBJECT_ID('dbo.validations', 'U') IS NULL
CREATE TABLE dbo.validations (
  id                       int IDENTITY(1,1) NOT NULL CONSTRAINT validations_pkey PRIMARY KEY,
  cycle_id                 int NOT NULL,
  question_id              int NOT NULL,
  status                   nvarchar(64) NOT NULL CONSTRAINT DF_validations_status DEFAULT N'pending',
  validation_score         int NULL,
  justification            nvarchar(max) NULL,
  additional_controls      nvarchar(max) NULL,
  validated_by             nvarchar(max) NULL,
  validated_at             datetimeoffset NULL,
  workflow_history         nvarchar(max) NOT NULL CONSTRAINT DF_validations_workflow_history DEFAULT N'[]' CONSTRAINT CK_validations_workflow_history CHECK (ISJSON(workflow_history) = 1),
  created_at               datetimeoffset NOT NULL CONSTRAINT DF_validations_created_at DEFAULT SYSDATETIMEOFFSET(),
  updated_at               datetimeoffset NOT NULL CONSTRAINT DF_validations_updated_at DEFAULT SYSDATETIMEOFFSET(),
  senior_validated_by      nvarchar(max) NULL,
  senior_validated_at      datetimeoffset NULL,
  senior_rejection_comment nvarchar(max) NULL,
  bu_code                  nvarchar(200) NULL,
  bu_code_key              AS COALESCE(bu_code, N'#NULL#') PERSISTED,
  CONSTRAINT validations_validation_score_check CHECK (validation_score >= 1 AND validation_score <= 4),
  CONSTRAINT validations_status_check CHECK (status IN (N'pending', N'in_review', N'returned', N'rejected', N'pending_approval', N'closed')),
  CONSTRAINT validations_cycle_id_fkey    FOREIGN KEY (cycle_id)    REFERENCES dbo.questionnaire_cycles(id) ON DELETE CASCADE,
  CONSTRAINT validations_question_id_fkey FOREIGN KEY (question_id) REFERENCES dbo.questions(id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'validations_cycle_question_bu_key' AND object_id = OBJECT_ID('dbo.validations'))
  CREATE UNIQUE INDEX validations_cycle_question_bu_key
    ON dbo.validations (cycle_id, question_id, bu_code_key);
GO

-- ---------- ccl_item_weights ----------
IF OBJECT_ID('dbo.ccl_item_weights', 'U') IS NULL
CREATE TABLE dbo.ccl_item_weights (
  item_number int NOT NULL,
  bu_code     nvarchar(200) NOT NULL,
  weight      decimal(20,18) NOT NULL,
  updated_at  datetimeoffset NOT NULL CONSTRAINT DF_ccl_item_weights_updated_at DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT ccl_item_weights_pkey PRIMARY KEY (item_number, bu_code),
  CONSTRAINT ccl_item_weights_weight_check CHECK (weight > 0 AND weight <= 1),
  CONSTRAINT ccl_item_weights_bu_code_fkey FOREIGN KEY (bu_code) REFERENCES dbo.respondent_units(bu_code) ON UPDATE CASCADE
);
GO

-- ---------- response_attachments ----------
IF OBJECT_ID('dbo.response_attachments', 'U') IS NULL
CREATE TABLE dbo.response_attachments (
  id          int IDENTITY(1,1) NOT NULL CONSTRAINT response_attachments_pkey PRIMARY KEY,
  response_id int NOT NULL,
  file_name   nvarchar(max) NOT NULL,
  file_path   nvarchar(max) NOT NULL,
  uploaded_by nvarchar(max) NULL,
  uploaded_at datetimeoffset NOT NULL CONSTRAINT DF_response_attachments_uploaded_at DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT response_attachments_response_id_fkey FOREIGN KEY (response_id) REFERENCES dbo.responses(id) ON DELETE CASCADE
);
GO

-- ---------- validation_attachments ----------
IF OBJECT_ID('dbo.validation_attachments', 'U') IS NULL
CREATE TABLE dbo.validation_attachments (
  id            int IDENTITY(1,1) NOT NULL CONSTRAINT validation_attachments_pkey PRIMARY KEY,
  validation_id int NOT NULL,
  file_name     nvarchar(max) NOT NULL,
  file_path     nvarchar(max) NOT NULL,
  uploaded_by   nvarchar(max) NULL,
  uploaded_at   datetimeoffset NOT NULL CONSTRAINT DF_validation_attachments_uploaded_at DEFAULT SYSDATETIMEOFFSET(),
  CONSTRAINT validation_attachments_validation_id_fkey FOREIGN KEY (validation_id) REFERENCES dbo.validations(id) ON DELETE CASCADE
);
GO
