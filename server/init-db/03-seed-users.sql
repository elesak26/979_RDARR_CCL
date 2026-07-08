-- Seed: users (ported from migration 007_seed-users + updates, extracted from ccl_tmp).
-- unit_codes text[] -> JSON array (nvarchar(max)); is_active boolean -> bit.
GO
IF NOT EXISTS (SELECT 1 FROM dbo.users)
BEGIN
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'admin-1', N'Admin User', N'Admin', N'["979"]', N'979', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-006', N'Finance Division (006-956)', N'Responder', N'["006-956"]', N'006-956', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-007', N'Corporate Governance Division', N'Responder', N'["007"]', N'007', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-023', N'Risk Function (023)', N'Responder', N'["023"]', N'023', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-030', N'Risk Function (030)', N'Responder', N'["030"]', N'030', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-902', N'Model Validators', N'Responder', N'["902"]', N'902', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-905', N'Enterprise Data, Risk & Insights Solutions', N'Responder', N'["997"]', N'997', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-908', N'Risk Function (908)', N'Responder', N'["908"]', N'908', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-956', N'Finance Function (956)', N'Responder', N'["956"]', N'956', 0);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-961', N'Group Financial & Liquidity Risk Management', N'Responder', N'["961","961-Market","961-Liquidity","961-IRRBB"]', N'961', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-966', N'Data Governance Unit', N'Responder', N'["966"]', N'966', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-974', N'Internal Control Function', N'Responder', N'["974"]', N'974', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'bu-979', N'RDARR Validation Unit', N'Responder', N'["979"]', N'979', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'senior-validator-1', N'Senior Validator User', N'Senior Validator', N'["979"]', N'979', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'validator-1', N'Validator User', N'Validator', N'["979"]', N'979', 1);
  INSERT INTO dbo.users (id, display_name, role, unit_codes, primary_unit_code, is_active) VALUES (N'viewer-1', N'Viewer', N'Viewer', N'[]', NULL, 1);
END
GO
