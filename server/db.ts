import sql from 'mssql';
import { logger } from './logger';

/*
 * PostgreSQL → Azure SQL Database migration (see ~/_azuresql-migration/CONTRACT.md).
 *
 * This module is a thin `pg`-compatible shim over the `mssql` (tedious) driver so
 * the existing raw-SQL call sites keep working with minimal edits. It:
 *   1. rewrites `$1..$n` positional params → `@p1..@pn` and binds them,
 *   2. returns the pg result shape `{ rows, rowCount }`,
 *   3. maps SQL Server error numbers → the Postgres SQLSTATE strings the code
 *      already catches (2627/2601→'23505', 547→'23503', 515→'23502').
 *
 * RDARR uses NO transactions and never calls `pool.connect()` (verified), so the
 * ShimClient/transaction path from the PF worked-example is intentionally omitted.
 * Only genuinely dialect-specific statements (arrays, JSONB, upserts, RETURNING,
 * FILTER) are hand-ported per the T-SQL cheatsheet — NOT here.
 *
 * Config: DB_CONNECTION_STRING (Azure SQL / Key Vault ADO.NET format) when set,
 * else discrete DB_* env vars (LFT format) + DB_AUTH=sql|msi toggle.
 * UTC: tedious `useUTC:true` reproduces the retired pg TIMESTAMP UTC behaviour.
 */

/** Parse an ADO.NET / Key-Vault SQL connection string into the discrete
 *  fields buildPoolConfig consumes. Mirrors the LoanFileTransfer / nbg-bia
 *  parser for cross-app consistency. Only DB_CONNECTION_STRING drives this;
 *  when it is unset the discrete DB_* env vars are used unchanged. */
function parseSqlConnectionString(cs: string): Partial<{
  host: string; port: number; name: string; user: string; password: string; encrypt: boolean; trustServerCertificate: boolean;
}> {
  const out: { host?: string; port?: number; name?: string; user?: string; password?: string; encrypt?: boolean; trustServerCertificate?: boolean } = {};
  const truthy = (v: string): boolean => /^(true|yes|1)$/i.test(v.trim());
  for (const part of cs.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    switch (key) {
      case 'server':
      case 'data source': { const [h, p] = val.replace(/^tcp:/i, '').split(','); if (h) out.host = h.trim(); if (p) out.port = parseInt(p.trim(), 10); break; }
      case 'initial catalog':
      case 'database': out.name = val; break;
      case 'user id':
      case 'user':
      case 'uid': out.user = val; break;
      case 'password':
      case 'pwd': out.password = val; break;
      case 'encrypt': out.encrypt = truthy(val); break;
      case 'trustservercertificate': out.trustServerCertificate = truthy(val); break;
      default: break;
    }
  }
  return out;
}

/** Build the mssql pool config. Prefers DB_CONNECTION_STRING (Azure SQL / Key
 *  Vault ADO.NET format) when set, else the discrete DB_* env vars (LFT format)
 *  + DB_AUTH=sql|msi toggle. Read lazily (at first connect) so a caller that
 *  loads `.env` after importing this module — seed scripts, the migration
 *  runner — still sees the values. */
function buildPoolConfig(): sql.config {
  const useMsi = process.env.DB_AUTH === 'msi';
  const parsed = process.env.DB_CONNECTION_STRING?.trim()
    ? parseSqlConnectionString(process.env.DB_CONNECTION_STRING.trim())
    : {};
  const password = parsed.password ?? (process.env.DB_PASSWORD || '');
  if (process.env.NODE_ENV === 'production' && !useMsi && !password) {
    throw new Error('A DB password is required in production (DB_AUTH=sql): set DB_CONNECTION_STRING or DB_PASSWORD');
  }
  return {
    server: parsed.host || process.env.DB_HOST || 'localhost',
    port: parsed.port || parseInt(process.env.DB_PORT || '1433', 10),
    database: parsed.name || process.env.DB_NAME || 'ccl',
    ...(useMsi
      ? {
          authentication: {
            type: 'azure-active-directory-default',
            options: process.env.DB_MSI_CLIENT_ID ? { clientId: process.env.DB_MSI_CLIENT_ID } : {},
          },
        }
      : { user: parsed.user || process.env.DB_USER || 'sa', password }),
    options: {
      // Azure SQL mandates TLS; a connection string's Encrypt= wins when present.
      encrypt: parsed.encrypt ?? (process.env.DB_ENCRYPT === 'false' ? false : true),
      trustServerCertificate: parsed.trustServerCertificate ?? (process.env.DB_TRUST_SERVER_CERT === 'true'),
      // Store/read datetime2/datetimeoffset as UTC in both directions.
      useUTC: true,
      requestTimeout: 30_000,
    },
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || (process.env.NODE_ENV === 'production' ? '20' : '10'), 10),
      min: parseInt(process.env.DB_POOL_MIN || '0', 10),
      idleTimeoutMillis: 30_000,
    },
  };
}

/** `$1..$n` → `@p1..@pn`. Positional params are unambiguous. */
function convertPlaceholders(text: string): string {
  return text.replace(/\$(\d+)/g, (_m, n) => '@p' + n);
}

/** Bind a JS value; null/undefined needs an explicit type for tedious. Arrays
 *  (pg passed JS arrays for text[] columns) must be JSON-stringified at the call
 *  site per the CONTRACT — a raw array reaching here is stringified defensively. */
function bindParam(req: sql.Request, name: string, value: unknown): void {
  if (value === null || value === undefined) {
    req.input(name, sql.NVarChar, null);
  } else if (Array.isArray(value)) {
    req.input(name, sql.NVarChar(sql.MAX), JSON.stringify(value));
  } else {
    req.input(name, value as never);
  }
}

/** Map SQL Server error numbers to the pg SQLSTATE strings existing catch
 *  blocks compare against, so `err.code === '23505'` keeps working. */
function mapError(err: unknown): unknown {
  const e = err as { number?: number; code?: string };
  if (e && typeof e.number === 'number') {
    if (e.number === 2627 || e.number === 2601) e.code = '23505'; // unique_violation
    else if (e.number === 547) e.code = '23503'; // foreign_key_violation
    else if (e.number === 515) e.code = '23502'; // not_null_violation
  }
  return err;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

async function runQuery<T = Record<string, unknown>>(
  req: sql.Request,
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  if (params) params.forEach((v, i) => bindParam(req, 'p' + (i + 1), v));
  try {
    const res = await req.query<T>(convertPlaceholders(text));
    const rows = (res.recordset as unknown as T[]) ?? [];
    const rowCount = res.recordset
      ? res.recordset.length
      : (res.rowsAffected?.reduce((a, b) => a + b, 0) ?? 0);
    return { rows, rowCount };
  } catch (err) {
    throw mapError(err);
  }
}

let poolPromise: Promise<sql.ConnectionPool> | null = null;

function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildPoolConfig())
      .connect()
      .then((p) => {
        p.on('error', (err) => logger.error({ err }, 'Unexpected MSSQL pool error'));
        return p;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/** pg `Pool`-compatible surface used across the codebase (query/end/on). */
export const pool = {
  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    const p = await getPool();
    return runQuery<T>(p.request(), text, params);
  },
  // pool errors are logged inside getPool(); accept for drop-in compatibility.
  on(_event: string, _cb: (...args: unknown[]) => void): void {},
  async end(): Promise<void> {
    if (poolPromise) {
      const p = await poolPromise.catch(() => null);
      if (p) await p.close();
      poolPromise = null;
    }
  },
};

/** Central query helper — same public surface as the retired pg version,
 *  including the slow-query (>1s) warning log. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    logger.warn({ duration, text: text.slice(0, 80) }, 'Slow query');
  }
  return res;
}
