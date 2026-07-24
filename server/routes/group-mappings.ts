import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { ROLE_VALUES, isRole, invalidateGroupMappings, mappingActive } from '../lib/groupRoles';

/**
 * AD group → local role mappings (spec item 4). Backs the mapping table the auth
 * middleware reads when AUTH_PROVIDER=entra. Every write invalidates the
 * middleware's in-memory cache so the change takes effect on the next request.
 *
 * Management is restricted to GLOBAL admins (the env allowlist), not merely to
 * the Admin role: the mapping decides everyone's role, so letting a business
 * user who holds Admin *through a group* edit it would let them escalate
 * themselves or others. In persona mode (DEV/QA) there are no global admins and
 * the mapping is inert, so the admin persona manages it for testing as before.
 */
const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  // Under Entra login the mapping is a live security control — require a global
  // admin. Outside it (persona/dev), any Admin may manage the inert table.
  if (mappingActive() && req.user?.is_global_admin !== true) {
    res.status(403).json({ error: 'Only a global administrator may manage group-role mappings.' });
    return false;
  }
  return true;
}

// GET /api/group-mappings — list all mappings (Admin)
router.get('/api/group-mappings', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await query(
      'SELECT id, ad_group, role, created_at, created_by FROM group_role_mappings ORDER BY role, ad_group'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/group-mappings/roles — the roles a mapping may target (Admin)
router.get('/api/group-mappings/roles', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(ROLE_VALUES);
});

// POST /api/group-mappings — create a mapping (Admin)
router.post('/api/group-mappings', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireAdmin(req, res)) return;
  try {
    const ad_group = String((req.body?.ad_group ?? '')).trim();
    const role = String((req.body?.role ?? '')).trim();
    if (!ad_group || !role) {
      res.status(400).json({ error: 'ad_group and role are required' });
      return;
    }
    if (!isRole(role)) {
      res.status(400).json({ error: `role must be one of: ${ROLE_VALUES.join(', ')}` });
      return;
    }
    // Case-insensitive uniqueness matches how the middleware looks groups up.
    const dup = await query('SELECT 1 FROM group_role_mappings WHERE LOWER(ad_group) = LOWER($1)', [ad_group]);
    if (dup.rows.length) {
      res.status(409).json({ error: 'That AD group is already mapped. Edit the existing mapping instead.' });
      return;
    }
    const result = await query(
      `INSERT INTO group_role_mappings (ad_group, role, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, ad_group, role, created_at, created_by`,
      [ad_group, role, req.user?.id ?? null]
    );
    invalidateGroupMappings();
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/group-mappings/:id — change the role a group maps to (Admin)
router.put('/api/group-mappings/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = req.params.id; const id = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
    const role = String((req.body?.role ?? '')).trim();
    if (!isRole(role)) {
      res.status(400).json({ error: `role must be one of: ${ROLE_VALUES.join(', ')}` });
      return;
    }
    const result = await query(
      `UPDATE group_role_mappings SET role = $1 WHERE id = $2
       RETURNING id, ad_group, role, created_at, created_by`,
      [role, id]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }
    invalidateGroupMappings();
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/group-mappings/:id — remove a mapping (Admin)
router.delete('/api/group-mappings/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireAdmin(req, res)) return;
  try {
    const raw = req.params.id; const id = parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
    const result = await query('DELETE FROM group_role_mappings WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }
    invalidateGroupMappings();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
