import { Pool, QueryResultRow } from 'pg';
import { logger } from './logger';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

function buildPoolConfig() {
  const cs = process.env.DB_CONNECTION_STRING?.trim();
  // DB_SSL=require  → enforce TLS, verify server certificate (production default)
  // DB_SSL=allow    → use TLS if available, skip cert verification
  // DB_SSL=disable  → no TLS (local dev only)
  const sslMode = process.env.DB_SSL ?? (process.env.NODE_ENV === 'production' ? 'require' : 'disable');
  const ssl = sslMode === 'disable' ? false
    : sslMode === 'allow'   ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' as const }
    : { rejectUnauthorized: true,  minVersion: 'TLSv1.2' as const }; // 'require'

  if (cs) return { connectionString: cs, ssl: ssl || undefined };
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'ccl',
    user: process.env.DB_USER || 'ccl',
    password: process.env.DB_PASSWORD || '',
    max: parseInt(process.env.DB_POOL_MAX || (process.env.NODE_ENV === 'production' ? '20' : '10'), 10),
    idleTimeoutMillis: 30_000,
    ssl: ssl || undefined,
  };
}

export const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => logger.error({ err }, 'Unexpected pg pool error'));

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    logger.warn({ duration, text: text.slice(0, 80) }, 'Slow query');
  }
  return { rows: res.rows, rowCount: res.rowCount };
}
