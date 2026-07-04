/**
 * run-migrations — idempotent migration runner for `server/init-db/*.sql`.
 *
 * Ported from the PF worked-example (`pf-editor/server/scripts/run-migrations.ts`)
 * and adapted to RDARR, which is a CommonJS package (tsconfig module=commonjs).
 * Native `__dirname` is available under CommonJS, so no `fileURLToPath` dance is
 * needed. Paths are resolved from `process.cwd()` so the same code works both
 * when run via `tsx scripts/run-migrations.ts` (cwd = server/) and when run as the
 * compiled `node dist/scripts/run-migrations.js` inside the container (cwd = /app,
 * with init-db/ copied alongside).
 *
 * Azure SQL has no `/docker-entrypoint-initdb.d` equivalent, so this runner is the
 * ONLY way the schema + seed scripts reach the database — locally and in every
 * deployed environment.
 *
 * Modes:
 *   npm run db:migrate                    apply pending migrations
 *   npm run db:migrate:status             list pending + applied (no writes)
 *   npm run db:migrate:bootstrap          record all current init-db files as
 *                                         already applied without running them
 *
 * Idempotency contract: each file in `init-db/` MUST be safe to re-run as a no-op
 * (guarded `IF NOT EXISTS`, `MERGE`, `IF OBJECT_ID(...) IS NULL`, etc.). The runner
 * tracks `sha256(filecontent)` per filename; if a file's checksum drifts after it
 * was applied, the runner warns but does NOT auto-reapply.
 *
 * T-SQL batching: `.sql` files may contain `GO` separators (required — CREATE
 * SCHEMA/VIEW must be first-in-batch). The `mssql` driver does not understand `GO`
 * (it is a client directive), so this runner splits each file on lines matching
 * `^GO$` and executes each batch in order inside a single per-file transaction.
 *
 * Connection: reads DB_HOST/DB_PORT/DB_NAME/DB_AUTH/DB_USER/DB_PASSWORD/
 * DB_ENCRYPT/DB_TRUST_SERVER_CERT/DB_MSI_CLIENT_ID from `.env` (or process env).
 */
import sql from 'mssql';
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

function buildPoolConfig(): sql.config {
  const useMsi = process.env.DB_AUTH === 'msi';
  const base: sql.config = {
    server: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '1433', 10),
    database: process.env.DB_NAME ?? 'ccl',
    options: {
      encrypt: process.env.DB_ENCRYPT === 'false' ? false : true,
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === 'true',
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
  };
  if (useMsi) {
    base.authentication = {
      type: 'azure-active-directory-default',
      options: process.env.DB_MSI_CLIENT_ID ? { clientId: process.env.DB_MSI_CLIENT_ID } : {},
    } as sql.config['authentication'];
  } else {
    base.user = process.env.DB_USER ?? 'sa';
    base.password = process.env.DB_PASSWORD ?? '';
  }
  return base;
}

interface MigrationFile {
  filename: string;
  fullPath: string;
  sha256: string;
  contents: string;
}

function listMigrationFiles(): MigrationFile[] {
  const entries = fs
    .readdirSync(INIT_DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return entries.map((filename) => {
    const fullPath = path.join(INIT_DB_DIR, filename);
    const contents = fs.readFileSync(fullPath, 'utf-8');
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    return { filename, fullPath, sha256, contents };
  });
}

/** Split a T-SQL script into batches on `GO` separators (a `GO` alone on its own
 *  line, case-insensitive). Blank batches are dropped. */
function splitBatches(sqlText: string): string[] {
  return sqlText
    .split(/^\s*GO\s*(?:\d+)?\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

async function ensureSchemaMigrationsTable(pool: sql.ConnectionPool): Promise<void> {
  await pool.request().batch(`
    IF SCHEMA_ID('app') IS NULL EXEC('CREATE SCHEMA app');
  `);
  await pool.request().batch(`
    IF OBJECT_ID('app.schema_migrations', 'U') IS NULL
      CREATE TABLE app.schema_migrations (
        filename     NVARCHAR(260) NOT NULL PRIMARY KEY,
        sha256       NVARCHAR(64)  NOT NULL,
        applied_at   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
      );
  `);
}

async function readApplied(pool: sql.ConnectionPool): Promise<Map<string, string>> {
  const { recordset } = await pool
    .request()
    .query<{ filename: string; sha256: string }>(
      `SELECT filename, sha256 FROM app.schema_migrations`
    );
  return new Map(recordset.map((r) => [r.filename, r.sha256]));
}

async function recordApplied(req: sql.Request, filename: string, sha256: string): Promise<void> {
  await req
    .input('filename', sql.NVarChar(260), filename)
    .input('sha256', sql.NVarChar(64), sha256).batch(`
      MERGE app.schema_migrations AS t
      USING (SELECT @filename AS filename, @sha256 AS sha256) AS s
        ON t.filename = s.filename
      WHEN MATCHED THEN UPDATE SET sha256 = s.sha256, applied_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (filename, sha256) VALUES (s.filename, s.sha256);
    `);
}

async function applyMigration(pool: sql.ConnectionPool, m: MigrationFile): Promise<void> {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const batch of splitBatches(m.contents)) {
      await new sql.Request(tx).batch(batch);
    }
    await recordApplied(new sql.Request(tx), m.filename, m.sha256);
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function main(): Promise<void> {
  for (const p of ENV_CANDIDATES) loadDotEnv(p);
  const args = new Set(process.argv.slice(2));
  const statusMode = args.has('--status');
  const bootstrapMode = args.has('--bootstrap');

  const pool = await new sql.ConnectionPool(buildPoolConfig()).connect();

  try {
    await ensureSchemaMigrationsTable(pool);
    const applied = await readApplied(pool);
    const files = listMigrationFiles();

    if (statusMode) {
      console.log('migration status:');
      console.log(`  init-db files     : ${files.length}`);
      console.log(`  recorded applied  : ${applied.size}`);
      for (const f of files) {
        const recordedSha = applied.get(f.filename);
        if (!recordedSha) {
          console.log(`  - pending     ${f.filename}`);
        } else if (recordedSha !== f.sha256) {
          console.log(
            `  ! drift       ${f.filename}  (recorded ${recordedSha.slice(0, 8)} != on-disk ${f.sha256.slice(0, 8)})`
          );
        } else {
          console.log(`  ok applied    ${f.filename}`);
        }
      }
      return;
    }

    if (bootstrapMode) {
      let recorded = 0;
      for (const f of files) {
        await recordApplied(pool.request(), f.filename, f.sha256);
        recorded++;
      }
      console.log(
        `bootstrap complete — ${recorded} migration files registered as applied (no SQL executed).`
      );
      return;
    }

    let appliedCount = 0;
    let driftCount = 0;
    for (const f of files) {
      const recordedSha = applied.get(f.filename);
      if (recordedSha === f.sha256) continue;
      if (recordedSha && recordedSha !== f.sha256) {
        console.warn(
          `! drift on ${f.filename} — recorded sha256 ${recordedSha.slice(0, 8)} != on-disk ${f.sha256.slice(0, 8)}. Skipping (do not edit already-applied migrations; add a new file instead).`
        );
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
    await pool.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
