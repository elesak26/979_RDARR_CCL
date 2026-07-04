/* One-shot generator: reads the 4 reference/seed tables from the Postgres
 * reference DB (ccl_tmp) and emits T-SQL seed files into init-db/. Run once via
 * `tsx scripts/gen-seeds.ts`. Not part of the app runtime. */
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.join(process.cwd(), 'init-db');

function q(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `N'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `N'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'ccl_tmp',
    user: 'pf_admin',
    password: 'pf_secret_2026',
  });
  await client.connect();

  // ---- 02-seed-questions.sql (IDENTITY_INSERT) ----
  {
    const cols = [
      'id', 'item_number', 'thematic_area', 'requirement', 'bcbs_principle_number',
      'bcbs_principle_name', 'ecb_reference', 'expectations', 'score_1_desc',
      'score_2_desc', 'score_3_desc', 'score_4_desc', 'respondents_hint',
      'supportive_material', 'related_kpis', 'material_risk',
    ];
    const { rows } = await client.query(`SELECT ${cols.join(',')} FROM questions ORDER BY id`);
    const lines: string[] = [];
    lines.push('-- Seed: questions (ported from migration 002_seed-questions + reconciliations, extracted from ccl_tmp).');
    lines.push('SET QUOTED_IDENTIFIER ON;');
    lines.push('SET ANSI_NULLS ON;');
    lines.push('GO');
    lines.push('IF NOT EXISTS (SELECT 1 FROM dbo.questions)');
    lines.push('BEGIN');
    lines.push('  SET IDENTITY_INSERT dbo.questions ON;');
    for (const r of rows) {
      const vals = cols.map((c) => q(r[c])).join(', ');
      lines.push(`  INSERT INTO dbo.questions (${cols.join(', ')}) VALUES (${vals});`);
    }
    lines.push('  SET IDENTITY_INSERT dbo.questions OFF;');
    lines.push('END');
    lines.push('GO');
    fs.writeFileSync(path.join(OUT_DIR, '02-seed-questions.sql'), lines.join('\n') + '\n');
    console.log(`02-seed-questions.sql: ${rows.length} rows`);
  }

  // ---- 03-seed-users.sql (unit_codes text[] -> JSON) ----
  {
    const { rows } = await client.query(
      `SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users ORDER BY id`
    );
    const cols = ['id', 'display_name', 'role', 'unit_codes', 'primary_unit_code', 'is_active'];
    const lines: string[] = [];
    lines.push('-- Seed: users (ported from migration 007_seed-users + updates, extracted from ccl_tmp).');
    lines.push('-- unit_codes text[] -> JSON array (nvarchar(max)); is_active boolean -> bit.');
    lines.push('GO');
    lines.push('IF NOT EXISTS (SELECT 1 FROM dbo.users)');
    lines.push('BEGIN');
    for (const r of rows) {
      const vals = [q(r.id), q(r.display_name), q(r.role), q(r.unit_codes), q(r.primary_unit_code), q(r.is_active)].join(', ');
      lines.push(`  INSERT INTO dbo.users (${cols.join(', ')}) VALUES (${vals});`);
    }
    lines.push('END');
    lines.push('GO');
    fs.writeFileSync(path.join(OUT_DIR, '03-seed-users.sql'), lines.join('\n') + '\n');
    console.log(`03-seed-users.sql: ${rows.length} rows`);
  }

  // ---- 04-seed-reference.sql (respondent_units then ccl_item_weights) ----
  {
    const ru = await client.query(
      `SELECT bu_code, bu_name, sort_order FROM respondent_units ORDER BY sort_order, bu_code`
    );
    const w = await client.query(
      `SELECT item_number, bu_code, weight FROM ccl_item_weights ORDER BY item_number, bu_code`
    );
    const lines: string[] = [];
    lines.push('-- Seed: reference tables respondent_units + ccl_item_weights (extracted from ccl_tmp).');
    lines.push('-- respondent_units first (ccl_item_weights.bu_code FK references it).');
    lines.push('GO');
    lines.push('IF NOT EXISTS (SELECT 1 FROM dbo.respondent_units)');
    lines.push('BEGIN');
    for (const r of ru.rows) {
      lines.push(`  INSERT INTO dbo.respondent_units (bu_code, bu_name, sort_order) VALUES (${q(r.bu_code)}, ${q(r.bu_name)}, ${q(r.sort_order)});`);
    }
    lines.push('END');
    lines.push('GO');
    lines.push('IF NOT EXISTS (SELECT 1 FROM dbo.ccl_item_weights)');
    lines.push('BEGIN');
    for (const r of w.rows) {
      // weight comes back as string from pg numeric — emit as raw numeric literal.
      lines.push(`  INSERT INTO dbo.ccl_item_weights (item_number, bu_code, weight) VALUES (${r.item_number}, ${q(r.bu_code)}, ${r.weight});`);
    }
    lines.push('END');
    lines.push('GO');
    fs.writeFileSync(path.join(OUT_DIR, '04-seed-reference.sql'), lines.join('\n') + '\n');
    console.log(`04-seed-reference.sql: ${ru.rows.length} units, ${w.rows.length} weights`);
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
