import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

import { pool, query } from './db';
import { logger } from './logger';

interface SeedUser {
  id: string;
  display_name: string;
  role: string;
  unit_codes: string[];
  primary_unit_code: string | null;
}

const users: SeedUser[] = [
  {
    id: 'admin-1',
    display_name: 'Admin User',
    role: 'Admin',
    unit_codes: ['979'],
    primary_unit_code: '979',
  },
  {
    id: 'validator-1',
    display_name: 'Validator User',
    role: 'Validator',
    unit_codes: ['979'],
    primary_unit_code: '979',
  },
  { id: 'bu-966',                   display_name: 'Data Governance Unit',          role: 'Responder', unit_codes: ['966'],                   primary_unit_code: '966' },
  { id: 'bu-007',                   display_name: 'Corporate Governance Division', role: 'Responder', unit_codes: ['007'],                   primary_unit_code: '007' },
  { id: 'bu-030',                   display_name: 'Risk Function (030)',            role: 'Responder', unit_codes: ['030'],                   primary_unit_code: '030' },
  { id: 'bu-961',                   display_name: 'Group Financial & Liquidity Risk Management Division', role: 'Responder', unit_codes: ['961', '961-IRRBB', '961-Liquidity', '961-Market'], primary_unit_code: '961' },
  { id: 'bu-023',                   display_name: 'Risk Function (023)',            role: 'Responder', unit_codes: ['023'],                   primary_unit_code: '023' },
  { id: 'bu-908',                   display_name: 'Risk Function (908)',            role: 'Responder', unit_codes: ['908'],                   primary_unit_code: '908' },
  { id: 'bu-006',                   display_name: 'Finance Division (006-956)',     role: 'Responder', unit_codes: ['006-956'],                primary_unit_code: '006-956' },
  { id: 'bu-943',                   display_name: 'Finance Function (943)',         role: 'Responder', unit_codes: ['943'],                   primary_unit_code: '943' },
  { id: 'bu-974',                   display_name: 'Internal Control Function',      role: 'Responder', unit_codes: ['974'],                   primary_unit_code: '974' },
  { id: 'bu-979',                   display_name: 'RDARR Validation Unit',          role: 'Responder', unit_codes: ['979'],                   primary_unit_code: '979' },
  { id: 'bu-905',                   display_name: 'IT',                             role: 'Responder', unit_codes: ['905'],                   primary_unit_code: '905' },
  { id: 'bu-902',                   display_name: 'Model Validators',               role: 'Responder', unit_codes: ['902'],                   primary_unit_code: '902' },
  { id: 'bu-012',                   display_name: 'EUC Regulation and Inventory',   role: 'Responder', unit_codes: ['012'],                   primary_unit_code: '012' },
  { id: 'bu-dg-mle',                display_name: 'Data Governance Cyprus',        role: 'Responder', unit_codes: ['DG MLE'],                primary_unit_code: 'DG MLE' },
  { id: 'bu-committee-secretaries', display_name: 'Committee Secretaries',          role: 'Responder', unit_codes: ['Committee Secretaries'], primary_unit_code: 'Committee Secretaries' },
  {
    id: 'viewer-1',
    display_name: 'Viewer',
    role: 'Viewer',
    unit_codes: [],
    primary_unit_code: null,
  },
];

async function seed() {
  logger.info('Starting user seed...');

  for (const user of users) {
    try {
      await query(
        `MERGE dbo.users AS tgt
         USING (SELECT $1 AS id, $2 AS display_name, $3 AS role, $4 AS unit_codes, $5 AS primary_unit_code) AS src
           ON tgt.id = src.id
         WHEN MATCHED THEN UPDATE SET
           display_name      = src.display_name,
           role              = src.role,
           unit_codes        = src.unit_codes,
           primary_unit_code = src.primary_unit_code
         WHEN NOT MATCHED THEN
           INSERT (id, display_name, role, unit_codes, primary_unit_code)
           VALUES (src.id, src.display_name, src.role, src.unit_codes, src.primary_unit_code);`,
        [user.id, user.display_name, user.role, user.unit_codes, user.primary_unit_code]
      );
      logger.info({ id: user.id, role: user.role }, `Upserted user: ${user.display_name}`);
    } catch (err) {
      logger.error({ err, id: user.id }, `Failed to upsert user: ${user.display_name}`);
      throw err;
    }
  }

  logger.info({ count: users.length }, 'User seed complete');
}

seed()
  .catch((err) => {
    logger.fatal({ err }, 'Seed failed');
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
