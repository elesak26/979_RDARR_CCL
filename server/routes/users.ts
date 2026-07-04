import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { logAudit } from '../audit';

const router = Router();

// unit_codes is stored as a JSON array (nvarchar) in Azure SQL — parse it back
// to string[] so the API response shape matches the old pg text[] behaviour.
function parseUnitCodes<T extends { unit_codes?: unknown }>(row: T): T {
  const uc = row?.unit_codes;
  if (typeof uc === 'string') return { ...row, unit_codes: JSON.parse(uc) };
  return row;
}

// GET /api/users — list all users (with last login)
router.get('/api/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query<{ unit_codes?: unknown }>(
      `SELECT u.id, u.display_name, u.role, u.unit_codes, u.primary_unit_code,
              u.is_active, u.created_at,
              (SELECT TOP 1 lh.logged_in_at FROM login_history lh
               WHERE lh.user_id = u.id ORDER BY lh.logged_in_at DESC) AS last_login_at
       FROM users u ORDER BY u.display_name`
    );
    res.json(result.rows.map(parseUnitCodes));
  } catch (err) {
    next(err);
  }
});

// GET /api/users/me — return current user
router.get('/api/users/me', (req: Request, res: Response) => {
  res.json(req.user ?? null);
});

// POST /api/users — create user (Admin only)
router.post('/api/users', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id, display_name, role, unit_codes = [], primary_unit_code = null } = req.body as {
      id: string;
      display_name: string;
      role: string;
      unit_codes?: string[];
      primary_unit_code?: string | null;
    };

    if (!id || !display_name || !role) {
      res.status(400).json({ error: 'id, display_name, and role are required' });
      return;
    }

    const result = await query(
      `INSERT INTO users (id, display_name, role, unit_codes, primary_unit_code)
       OUTPUT INSERTED.id, INSERTED.display_name, INSERTED.role, INSERTED.unit_codes, INSERTED.primary_unit_code, INSERTED.is_active, INSERTED.created_at
       VALUES ($1, $2, $3, $4, $5)`,
      [id, display_name, role, unit_codes, primary_unit_code]
    );
    logAudit({ action: 'user_created', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'user', entity_id: String(result.rows[0].id), details: { display_name: result.rows[0].display_name, role: result.rows[0].role } });
    res.status(201).json(parseUnitCodes(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id — update user (Admin only)
router.put('/api/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const { display_name, role, unit_codes, primary_unit_code } = req.body as {
      display_name?: string;
      role?: string;
      unit_codes?: string[];
      primary_unit_code?: string | null;
    };

    const result = await query(
      `UPDATE users
       SET
         display_name     = COALESCE($2, display_name),
         role             = COALESCE($3, role),
         unit_codes       = COALESCE($4, unit_codes),
         primary_unit_code = COALESCE($5, primary_unit_code)
       OUTPUT INSERTED.id, INSERTED.display_name, INSERTED.role, INSERTED.unit_codes, INSERTED.primary_unit_code, INSERTED.is_active, INSERTED.created_at
       WHERE id = $1`,
      [id, display_name ?? null, role ?? null, unit_codes ?? null, primary_unit_code ?? null]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    logAudit({ action: 'user_updated', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'user', entity_id: String(id), details: { display_name, role } });
    res.json(parseUnitCodes(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:id/toggle-active — enable/disable user (Admin only)
router.put('/api/users/:id/toggle-active', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    if (id === req.user.id) {
      res.status(400).json({ error: 'You cannot disable your own account' });
      return;
    }
    const result = await query(
      `UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
       OUTPUT INSERTED.id, INSERTED.display_name, INSERTED.role, INSERTED.is_active
       WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const u = result.rows[0];
    logAudit({ action: u.is_active ? 'user_enabled' : 'user_disabled', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'user', entity_id: String(id), details: { display_name: u.display_name, role: u.role } });
    res.json(u);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/login-history — login history (Admin only)
router.get('/api/users/login-history', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { user_id, role, limit = '200' } = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (user_id) { conditions.push(`lh.user_id = $${params.length + 1}`); params.push(user_id); }
    if (role)    { conditions.push(`lh.role = $${params.length + 1}`); params.push(role); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit, 10) || 200, 500));
    const result = await query(
      `SELECT lh.id, lh.user_id, lh.display_name, lh.role,
              lh.logged_in_at, lh.ip_address, lh.user_agent
       FROM login_history lh
       ${where}
       ORDER BY lh.logged_in_at DESC
       OFFSET 0 ROWS FETCH NEXT $${params.length} ROWS ONLY`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:id — delete user (Admin only)
router.delete('/api/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query('DELETE FROM users OUTPUT DELETED.id WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    logAudit({ action: 'user_deleted', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'user', entity_id: String(id), details: {} });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
