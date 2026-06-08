import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';

const router = Router();

// GET /api/audit-log — Admin only, supports ?cycle_id, ?entity_type, ?actor_id, ?from_date, ?to_date, ?limit, ?format=csv
router.get('/api/audit-log', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { cycle_id, entity_type, actor_id, actor_role, from_date, to_date, format } = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt((req.query.limit as string) || '500', 10), 2000);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (cycle_id)    { params.push(parseInt(cycle_id, 10)); conditions.push(`cycle_id = $${params.length}`); }
    if (entity_type) { params.push(entity_type);            conditions.push(`entity_type = $${params.length}`); }
    if (actor_id)    { params.push(actor_id);               conditions.push(`actor_id = $${params.length}`); }
    if (actor_role)  { params.push(actor_role);             conditions.push(`actor_role = $${params.length}`); }
    if (from_date)   { params.push(from_date);              conditions.push(`created_at >= $${params.length}`); }
    if (to_date)     { params.push(to_date);                conditions.push(`created_at <= $${params.length}`); }

    params.push(limit);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`;

    const result = await query(sql, params);
    const rows = result.rows;

    if (format === 'csv') {
      const escape = (v: unknown) => {
        if (v == null) return '';
        const s = v instanceof Date
          ? v.toISOString()
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      };
      const headers = ['id','created_at','action','actor_name','actor_role','entity_type','entity_id','cycle_id','details'];
      const lines = [
        headers.join(','),
        ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
      res.send(lines.join('\n'));
      return;
    }

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
