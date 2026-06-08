/**
 * Migration 007 – Seed application users.
 *
 * Ported from server/seed-data.ts so the database is fully provisioned by
 * migrations alone — the production Docker image does not carry tsx, and
 * seed-data.ts is an ESM script excluded from the tsc build. Running this as a
 * migration keeps the container self-bootstrapping on a fresh Azure PostgreSQL.
 *
 * Idempotent: ON CONFLICT (id) DO UPDATE.
 *
 * NOTE: adds a 'Senior Validator' user (senior-validator-1) which the original
 * seed-data.ts lacked — the two-tier approval workflow (cycle/validation
 * approve+reject) is otherwise untestable since no user holds that role.
 */

const users = [
  { id: 'admin-1',                  display_name: 'Admin User',                    role: 'Admin',            unit_codes: ['979'],                    primary_unit_code: '979' },
  { id: 'validator-1',              display_name: 'Validator User',                role: 'Validator',        unit_codes: ['979'],                    primary_unit_code: '979' },
  { id: 'senior-validator-1',       display_name: 'Senior Validator User',         role: 'Senior Validator', unit_codes: ['979'],                    primary_unit_code: '979' },
  { id: 'bu-966',                   display_name: 'Data Governance Unit',          role: 'Responder',        unit_codes: ['966'],                    primary_unit_code: '966' },
  { id: 'bu-007',                   display_name: 'Corporate Governance Division', role: 'Responder',        unit_codes: ['007'],                    primary_unit_code: '007' },
  { id: 'bu-030',                   display_name: 'Risk Function (030)',           role: 'Responder',        unit_codes: ['030'],                    primary_unit_code: '030' },
  { id: 'bu-961',                   display_name: 'Risk Function (961)',           role: 'Responder',        unit_codes: ['961'],                    primary_unit_code: '961' },
  { id: 'bu-023',                   display_name: 'Risk Function (023)',           role: 'Responder',        unit_codes: ['023'],                    primary_unit_code: '023' },
  { id: 'bu-908',                   display_name: 'Risk Function (908)',           role: 'Responder',        unit_codes: ['908'],                    primary_unit_code: '908' },
  { id: 'bu-006',                   display_name: 'Finance Function (006)',        role: 'Responder',        unit_codes: ['006'],                    primary_unit_code: '006' },
  { id: 'bu-956',                   display_name: 'Finance Function (956)',        role: 'Responder',        unit_codes: ['956'],                    primary_unit_code: '956' },
  { id: 'bu-943',                   display_name: 'Finance Function (943)',        role: 'Responder',        unit_codes: ['943'],                    primary_unit_code: '943' },
  { id: 'bu-974',                   display_name: 'Internal Control Function',     role: 'Responder',        unit_codes: ['974'],                    primary_unit_code: '974' },
  { id: 'bu-979',                   display_name: 'RDARR Validation Unit',         role: 'Responder',        unit_codes: ['979'],                    primary_unit_code: '979' },
  { id: 'bu-905',                   display_name: 'IT',                            role: 'Responder',        unit_codes: ['905'],                    primary_unit_code: '905' },
  { id: 'bu-902',                   display_name: 'Model Validators',              role: 'Responder',        unit_codes: ['902'],                    primary_unit_code: '902' },
  { id: 'bu-012',                   display_name: 'EUC Regulation and Inventory',  role: 'Responder',        unit_codes: ['012'],                    primary_unit_code: '012' },
  { id: 'bu-dg-mle',                display_name: 'Data Governance Cyprus',        role: 'Responder',        unit_codes: ['DG MLE'],                 primary_unit_code: 'DG MLE' },
  { id: 'bu-committee-secretaries', display_name: 'Committee Secretaries',         role: 'Responder',        unit_codes: ['Committee Secretaries'],  primary_unit_code: 'Committee Secretaries' },
  { id: 'viewer-1',                 display_name: 'Viewer',                        role: 'Viewer',           unit_codes: [],                         primary_unit_code: null },
];

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function arr(a) {
  if (!a || a.length === 0) return `ARRAY[]::text[]`;
  return `ARRAY[${a.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}

exports.up = (pgm) => {
  const rows = users
    .map((u) => `(${q(u.id)}, ${q(u.display_name)}, ${q(u.role)}, ${arr(u.unit_codes)}, ${q(u.primary_unit_code)})`)
    .join(',\n    ');

  pgm.sql(`
    INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code)
    VALUES
    ${rows}
    ON CONFLICT (id) DO UPDATE
      SET display_name      = EXCLUDED.display_name,
          role              = EXCLUDED.role,
          unit_codes        = EXCLUDED.unit_codes,
          primary_unit_code = EXCLUDED.primary_unit_code;
  `);
};

exports.down = (pgm) => {
  const ids = users.map((u) => `'${u.id}'`).join(', ');
  pgm.sql(`DELETE FROM users WHERE id IN (${ids});`);
};
