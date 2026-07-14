/**
 * run-migrations — idempotent migration runner for server/init-db/*.sql (PostgreSQL).
 *
 * Modes:
 *   npm run db:migrate              apply pending migrations
 *   npm run db:migrate:status       list pending + applied (no writes)
 *   npm run db:migrate:bootstrap    record all current init-db files as applied without running them
 *
 * Idempotency: each SQL file must be safe to re-run (CREATE TABLE IF NOT EXISTS, etc.).
 * Tracks sha256(content) per filename in public.schema_migrations.
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const CWD = process.cwd();
const INIT_DB_DIR = path.join(CWD, 'init-db');
const ENV_CANDIDATES = [path.join(CWD, '.env'), path.join(CWD, '..', '.env')];

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function buildPool(): Pool {
  const cs = process.env.DB_CONNECTION_STRING?.trim();
  if (cs) return new Pool({ connectionString: cs });
  return new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    database: process.env.DB_NAME ?? 'ccl',
    user: process.env.DB_USER ?? 'ccl',
    password: process.env.DB_PASSWORD ?? '',
    max: 4,
  });
}

interface MigrationFile {
  filename: string;
  fullPath: string;
  sha256: string;
  contents: string;
}

function listMigrationFiles(): MigrationFile[] {
  return fs
    .readdirSync(INIT_DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const fullPath = path.join(INIT_DB_DIR, filename);
      const contents = fs.readFileSync(fullPath, 'utf-8');
      const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
      return { filename, fullPath, sha256, contents };
    });
}

async function ensureSchemaMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT NOT NULL PRIMARY KEY,
      sha256     TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(pool: Pool): Promise<Map<string, string>> {
  const res = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM schema_migrations'
  );
  return new Map(res.rows.map((r) => [r.filename, r.sha256]));
}

async function recordApplied(pool: Pool, filename: string, sha256: string): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations (filename, sha256)
     VALUES ($1, $2)
     ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`,
    [filename, sha256]
  );
}

async function applyMigration(pool: Pool, m: MigrationFile): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(m.contents);
    await client.query(
      `INSERT INTO schema_migrations (filename, sha256)
       VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`,
      [m.filename, m.sha256]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  for (const p of ENV_CANDIDATES) loadDotEnv(p);
  const args = new Set(process.argv.slice(2));
  const statusMode = args.has('--status');
  const bootstrapMode = args.has('--bootstrap');

  const pool = buildPool();

  try {
    await ensureSchemaMigrationsTable(pool);
    const applied = await readApplied(pool);
    const files = listMigrationFiles();

    if (statusMode) {
      console.log('migration status:');
      console.log(`  init-db files    : ${files.length}`);
      console.log(`  recorded applied : ${applied.size}`);
      for (const f of files) {
        const recordedSha = applied.get(f.filename);
        if (!recordedSha) console.log(`  - pending   ${f.filename}`);
        else if (recordedSha !== f.sha256) console.log(`  ! drift     ${f.filename}`);
        else console.log(`  ok applied  ${f.filename}`);
      }
      return;
    }

    if (bootstrapMode) {
      for (const f of files) await recordApplied(pool, f.filename, f.sha256);
      console.log(`bootstrap complete — ${files.length} files registered.`);
      return;
    }

    let appliedCount = 0;
    let driftCount = 0;
    for (const f of files) {
      const recordedSha = applied.get(f.filename);
      if (recordedSha === f.sha256) continue;
      if (recordedSha && recordedSha !== f.sha256) {
        console.warn(`! drift on ${f.filename} — skipping (add a new file instead).`);
        driftCount++;
        continue;
      }
      console.log(`-> applying ${f.filename}`);
      await applyMigration(pool, f);
      appliedCount++;
    }
    console.log(
      `done — applied ${appliedCount} migrations (${files.length - appliedCount - driftCount} already up to date${driftCount > 0 ? `, ${driftCount} drifted` : ''}).`
    );
    if (driftCount > 0) process.exit(2);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
