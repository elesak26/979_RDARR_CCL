import { query } from './db';
import { logger } from './logger';

export interface AuditParams {
  action: string;
  actor_id?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  entity_type: 'cycle' | 'response' | 'validation' | 'attachment' | 'user' | 'applicability';
  entity_id: string;
  cycle_id?: number | null;
  details?: Record<string, unknown>;
}

export function logAudit(params: AuditParams): void {
  query(
    `INSERT INTO audit_log
       (action, actor_id, actor_name, actor_role, entity_type, entity_id, cycle_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.action,
      params.actor_id ?? null,
      params.actor_name ?? null,
      params.actor_role ?? null,
      params.entity_type,
      params.entity_id,
      params.cycle_id ?? null,
      JSON.stringify(params.details ?? {}),
    ]
  ).catch((err) => logger.error({ err }, 'audit log write failed'));
}
