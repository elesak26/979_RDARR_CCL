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

    async function resolveUser(id: string): Promise<AuthUser | null> {
      const result = await query<AuthUser>(
        'SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE id = $1',
        [id]
      );
      return result.rows[0] ?? null;
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
      const result = await query<AuthUser>(
        "SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE role = 'Admin' AND is_active = true LIMIT 1"
      );
      if (result.rows.length > 0) {
        req.user = result.rows[0];
        await recordLogin(result.rows[0]);
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
