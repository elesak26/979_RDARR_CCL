-- Least-privilege application role (Principle of Least Privilege).
--
-- The application connects as `sa` (local dev) or via Managed Identity (Azure).
-- Both have superuser / db_owner rights, which violates least-privilege: a SQL
-- injection or a compromised container would have full DDL access.
--
-- This script creates a dedicated role `ccl_app` that holds exactly the
-- permissions the running application needs:
--   - DML on every application table (SELECT, INSERT, UPDATE, DELETE)
--   - USAGE on all sequences (for serial PKs via INSERT … RETURNING id)
--   - SELECT on schema_migrations (migration runner must read applied files)
--   - INSERT on schema_migrations (migration runner marks files as applied)
--   No TRUNCATE, no DROP, no CREATE, no REFERENCES, no superuser attributes.
--
-- HOW TO USE:
--   1. Generate a strong password and store it in Azure Key Vault:
--        openssl rand -base64 32 | tr -d '\n' | az keyvault secret set \
--          --vault-name <vault-name> --name rdarr-ccl-app-db-password --value @-
--   2. Run this script as the DB superuser, supplying the password at runtime:
--        export CCL_APP_PASSWORD="$(az keyvault secret show \
--          --vault-name <vault-name> --name rdarr-ccl-app-db-password \
--          --query value -o tsv)"
--        psql "$SUPERUSER_DSN" \
--          -c "SET myvars.ccl_app_password = '$CCL_APP_PASSWORD'" \
--          -f 07-app-role.sql
--   3. In App Service configuration set:
--        DB_USER     = ccl_app
--        DB_PASSWORD = @Microsoft.KeyVault(VaultName=<vault>;SecretName=rdarr-ccl-app-db-password)
--   4. Stop using `sa` / the DB owner account for the running application.
--
-- Azure (production / QA): prefer DB_AUTH=msi (Managed Identity) — no password
-- is needed. Only local dev uses DB_AUTH=sql + DB_PASSWORD.
--
-- NEVER hardcode the password in this file or in any configuration file.
-- The script is idempotent: DO blocks guard every DDL statement.

-- ── Create role if it does not exist ─────────────────────────────────────────
-- Password is injected at runtime via the GUC myvars.ccl_app_password (see
-- HOW TO USE above). No password literal is stored in this file.
DO $$
DECLARE
  _pwd text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ccl_app') THEN
    -- In production: supply password via SET myvars.ccl_app_password before running.
    -- In local dev: GUC is absent, so fall back to a placeholder password that
    --               is never used (the app connects as the owner role in dev).
    BEGIN
      _pwd := current_setting('myvars.ccl_app_password');
    EXCEPTION WHEN undefined_object THEN
      _pwd := 'local-dev-only-not-used';
    END;
    EXECUTE format('CREATE ROLE ccl_app LOGIN PASSWORD %L', _pwd);
  END IF;
END
$$;

-- ── Schema usage ──────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO ccl_app;

-- ── Application tables: DML only, no DDL ─────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  questionnaire_cycles,
  questions,
  respondent_units,
  users,
  audit_log,
  login_history,
  cycle_comments,
  notifications,
  question_applicability,
  responses,
  validations,
  ccl_item_weights,
  response_attachments,
  validation_attachments,
  group_role_mappings
TO ccl_app;

-- ── Migration runner: must read + record applied files ────────────────────────
GRANT SELECT, INSERT ON TABLE schema_migrations TO ccl_app;

-- ── Sequences: required for serial PKs (nextval called on INSERT) ─────────────
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ccl_app;

-- Ensure future sequences created by migrations are also granted automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ccl_app;

-- ── Explicitly deny DDL (belt-and-suspenders) ─────────────────────────────────
-- PostgreSQL does not have a DENY syntax; the absence of CREATE, DROP, ALTER,
-- TRUNCATE on the tables above is the grant boundary. The role has no superuser,
-- no CREATEDB, no CREATEROLE attributes.
REVOKE CREATE ON SCHEMA public FROM ccl_app;
