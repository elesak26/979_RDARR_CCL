import { Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { logger } from '../logger';

export interface AuthUser {
  id: string;
  display_name: string;
  role: string;
  unit_codes: string[];
  primary_unit_code: string | null;
  is_active: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const DISABLE_LOGIN = process.env.DISABLE_LOGIN === 'true';

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (DISABLE_LOGIN) {
    // Dev mode: pick user from X-User-Id header, default to first admin
    const userId = req.headers['x-user-id'] as string | undefined;

    // unit_codes is stored as a JSON array (nvarchar) in Azure SQL — parse it
    // back to string[] so AuthUser (and downstream authz) sees a real array.
    function normalizeUser(row: (Omit<AuthUser, 'unit_codes'> & { unit_codes: unknown }) | undefined): AuthUser | null {
      if (!row) return null;
      const uc = row.unit_codes;
      const unit_codes: string[] = Array.isArray(uc) ? uc : typeof uc === 'string' ? JSON.parse(uc) : [];
      return { ...row, unit_codes };
    }

    async function resolveUser(id: string): Promise<AuthUser | null> {
      const result = await query<Omit<AuthUser, 'unit_codes'> & { unit_codes: unknown }>(
        'SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE id = $1',
        [id]
      );
      return normalizeUser(result.rows[0]);
    }

    async function recordLogin(user: AuthUser) {
      // Only record once per session to avoid per-request noise — skip for health/static
      if (req.path === '/health') return;
      try {
        await query(
          `INSERT INTO login_history (user_id, display_name, role, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            user.id,
            user.display_name,
            user.role,
            req.ip ?? null,
            req.headers['user-agent'] ?? null,
          ]
        );
      } catch (err) {
        logger.warn({ err }, 'authMiddleware: failed to record login history');
      }
    }

    if (userId) {
      try {
        const user = await resolveUser(userId);
        if (user) {
          if (user.is_active === false) {
            res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
            return;
          }
          req.user = user;
          await recordLogin(user);
          return next();
        }
      } catch (err) {
        logger.warn({ err }, 'authMiddleware: failed to fetch user');
      }
    }
    // Fallback: first active admin user
    try {
      const result = await query<Omit<AuthUser, 'unit_codes'> & { unit_codes: unknown }>(
        "SELECT TOP 1 id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE role = 'Admin' AND is_active = 1"
      );
      const adminUser = normalizeUser(result.rows[0]);
      if (adminUser) {
        req.user = adminUser;
        await recordLogin(adminUser);
        return next();
      }
    } catch (err) {
      logger.warn({ err }, 'authMiddleware: fallback user fetch failed');
    }
    // No users yet (pre-seed) — allow through with a placeholder
    req.user = { id: 'system', display_name: 'System', role: 'Admin', unit_codes: [], primary_unit_code: null, is_active: true };
    return next();
  }

  // Production: OAuth2 — to be wired later
  res.status(401).json({ error: 'Unauthorized' });
}
