import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');

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
    const where = conditions.length ? 'WHERE ' + conditions.map(c => `al.${c}`).join(' AND ') : '';
    const sql = `
      SELECT al.*, qc.name AS cycle_name
      FROM audit_log al
      LEFT JOIN questionnaire_cycles qc ON qc.id = al.cycle_id
      ${where}
      ORDER BY al.created_at DESC
      OFFSET 0 ROWS FETCH NEXT $${params.length} ROWS ONLY`;

    const result = await query(sql, params);
    // jsonb columns (old_value/new_value/details) come back as JSON strings in
    // Azure SQL — parse them so the API response matches the old pg object shape.
    const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const rows = result.rows.map((r): Record<string, unknown> => ({
      ...r,
      old_value: r.old_value != null ? parseJson(r.old_value) : r.old_value,
      new_value: r.new_value != null ? parseJson(r.new_value) : r.new_value,
      details: r.details != null ? parseJson(r.details) : r.details,
    }));

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
      const headers = ['id','created_at','action','actor_name','actor_role','entity_type','entity_id','cycle_name','details'];
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

// GET /api/audit-log/:entryId/file — Admin only, download the file attached to an audit entry
router.get('/api/audit-log/:entryId/file', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { entryId } = req.params;
    const result = await query<{ action: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
      `SELECT action, entity_type, entity_id, details FROM audit_log WHERE id = $1`,
      [parseInt(Array.isArray(entryId) ? entryId[0] : entryId, 10)]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Audit entry not found' });
      return;
    }
    const row = result.rows[0];
    const details = (typeof row.details === 'string' ? row.details : row.details) ?? {};
    const fileName = details.file_name as string | undefined;
    if (!fileName) {
      res.status(404).json({ error: 'No file attached to this entry' });
      return;
    }

    // Look up the physical file from the appropriate table
    let fileRow: { file_name: string; file_path: string } | undefined;

    if (row.action === 'validation_attachment_uploaded') {
      // entity_id is the validation_id — look up the most recent attachment with this name on this validation
      const r = await query<{ file_name: string; file_path: string }>(
        `SELECT file_name, file_path FROM validation_attachments
         WHERE validation_id = $1 AND file_name = $2
         ORDER BY uploaded_at DESC`,
        [parseInt(row.entity_id, 10), fileName]
      );
      fileRow = r.rows[0];
    } else {
      // response attachment or other — entity_id is the response_id
      const r = await query<{ file_name: string; file_path: string }>(
        `SELECT file_name, file_path FROM response_attachments
         WHERE response_id = $1 AND file_name = $2
         ORDER BY uploaded_at DESC`,
        [parseInt(row.entity_id, 10), fileName]
      );
      fileRow = r.rows[0];
    }

    if (!fileRow) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const full = path.join(UPLOAD_DIR, fileRow.file_path);
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: 'File missing on disk' });
      return;
    }

    res.download(full, fileRow.file_name);
  } catch (err) {
    next(err);
  }
});

export default router;
