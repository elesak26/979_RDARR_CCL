import { Pool } from 'pg';
import { logger } from './logger';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  logger.fatal('DATABASE_URL is not set');
  process.exit(1);
}

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    logger.warn({ duration, text: text.slice(0, 80) }, 'Slow query');
  }
  return res as { rows: T[]; rowCount: number | null };
}
