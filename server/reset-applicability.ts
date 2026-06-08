import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { pool, query } from './db';
import { logger } from './logger';

// unit code -> display name (from users table)
const BU_NAME: Record<string, string> = {
  '966': 'Data Governance Unit',
  '007': 'Corporate Governance Division',
  '030': 'Risk Function (030)',
  '961': 'Risk Function (961)',
  '023': 'Risk Function (023)',
  '908': 'Risk Function (908)',
  '006': 'Finance Function (006)',
  '956': 'Finance Function (956)',
  '943': 'Finance Function (943)',
  '974': 'Internal Control Function',
  '979': 'RDARR Validation Unit',
  '905': 'IT',
  '902': 'Model Validators',
  '012': 'EUC Regulation and Inventory',
  'DG MLE': 'Data Governance Cyprus',
  'Committee Secretaries': 'Committee Secretaries',
};

// item_number (= question_id) -> unit codes, parsed from the Excel file
const APPLICABILITY: Record<number, string[]> = {
  1:  ['966', '007'],
  2:  ['966', '030', '961', '023', '908', '006', '956', '943', '974'],
  3:  ['966'],
  4:  ['966'],
  5:  ['966'],
  6:  ['966'],
  7:  ['966', 'DG MLE'],
  8:  ['030', '961', '023', '908', '006', '956', '943'],
  9:  ['966'],
  10: ['966'],
  11: ['966'],
  12: ['966', '030', '961', '023', '908', '006', '956', '943'],
  13: ['966', '030', '961', '023', '908'],
  14: ['966', '030', '961', '023', '908', '006', '956', '943'],
  15: ['966'],
  16: ['966'],
  17: ['979'],
  18: ['966'],
  19: ['030', '961', '023', '908', '006', '956', '943', '966', '905'],
  20: ['DG MLE'],
  21: ['030', '961', '023', '908', '006', '956', '943', '905'],
  22: ['966'],
  23: ['966', '030', '961', '023', '908', '006', '956', '943'],
  24: ['966'],
  25: ['030', '961', '023', '908', '006', '956', '943'],
  26: ['030', '961', '023', '908', '006', '956', '943', '012', '966'],
  27: ['030', '961', '023', '908', '006', '956', '943'],
  28: ['030', '961', '023', '902'],
  29: ['030', '961', '023', '908', '006', '956', '943'],
  30: ['030', '961', '023', '908', '006', '956', '943'],
  31: ['030', '961', '023', '908', '006', '956', '943'],
  32: ['966'],
  33: ['030', '961', '023', '908', '006', '956', '943'],
  34: ['030', '961', '023', '908', '006', '956', '943'],
  35: ['030', '961', '023', '908', '006', '956', '943'],
  36: ['030', '961', '023', '908', '006', '956', '943'],
  37: ['030', '961', '023', '908', '006', '956', '943'],
  38: ['030', '961', '023', '908', '006', '956', '943'],
  39: ['030', '961', '023', '908', '006', '956', '943'],
  40: ['030', '961', '023', '908', '006', '956', '943', 'Committee Secretaries'],
};

const CYCLE_ID = 3;
const ASSIGNED_BY = 'admin-1';

async function reset() {
  logger.info('Deleting existing applicability entries for cycle 1...');
  await query('DELETE FROM question_applicability WHERE cycle_id = $1', [CYCLE_ID]);

  let inserted = 0;
  for (const [itemStr, codes] of Object.entries(APPLICABILITY)) {
    const questionId = Number(itemStr);
    for (const code of codes) {
      const buName = BU_NAME[code];
      if (!buName) {
        logger.warn({ questionId, code }, 'Unknown unit code — skipping');
        continue;
      }
      await query(
        `INSERT INTO question_applicability (cycle_id, question_id, bu_code, bu_name, assigned_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [CYCLE_ID, questionId, code, buName, ASSIGNED_BY]
      );
      inserted++;
    }
  }

  logger.info({ inserted }, 'Applicability reset complete');
}

reset()
  .catch((err) => {
    logger.fatal({ err }, 'Reset failed');
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
