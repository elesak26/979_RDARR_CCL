-- Seed: users (ported from migration 007_seed-users + updates, extracted from ccl_tmp).
-- unit_codes text[] -> JSON array (nvarchar(max)); is_active boolean -> bit.
DO $seed$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM users) THEN
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('admin-1', 'Admin User', 'Admin', '["979"]', '979', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-006', 'Finance Division (006-956)', 'Responder', '["006-956"]', '006-956', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-007', 'Corporate Governance Division', 'Responder', '["007"]', '007', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-023', 'Risk Function (023)', 'Responder', '["023"]', '023', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-030', 'Risk Function (030)', 'Responder', '["030"]', '030', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-902', 'Model Validators', 'Responder', '["902"]', '902', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-905', 'Enterprise Data, Risk & Insights Solutions', 'Responder', '["997"]', '997', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-908', 'Risk Function (908)', 'Responder', '["908"]', '908', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-956', 'Finance Function (956)', 'Responder', '["956"]', '956', false);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-961', 'Group Financial & Liquidity Risk Management', 'Responder', '["961","961-Market","961-Liquidity","961-IRRBB"]', '961', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-966', 'Data Governance Unit', 'Responder', '["966"]', '966', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-974', 'Internal Control Function', 'Responder', '["974"]', '974', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('bu-979', 'RDARR Validation Unit', 'Responder', '["979"]', '979', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('senior-validator-1', 'Senior Validator User', 'Senior Validator', '["979"]', '979', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('validator-1', 'Validator User', 'Validator', '["979"]', '979', true);
  INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES ('viewer-1', 'Viewer', 'Viewer', '[]', NULL, true);
  END IF;
END $seed$;
