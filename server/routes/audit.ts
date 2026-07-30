import { Router, Request, Response, NextFunction } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db';
import { sendDownload } from '../lib/fileStore';

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

    await sendDownload(res, fileRow.file_path, fileRow.file_name);
  } catch (err) {
    next(err);
  }
});

// GET /api/audit-log/export/excel — Admin only, same filters as JSON endpoint, returns .xlsx
router.get('/api/audit-log/export/excel', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { cycle_id, entity_type, actor_id, actor_role, from_date, to_date } = req.query as Record<string, string | undefined>;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (cycle_id)    { params.push(parseInt(cycle_id, 10)); conditions.push(`al.cycle_id = $${params.length}`); }
    if (entity_type) { params.push(entity_type);            conditions.push(`al.entity_type = $${params.length}`); }
    if (actor_id)    { params.push(actor_id);               conditions.push(`al.actor_id = $${params.length}`); }
    if (actor_role)  { params.push(actor_role);             conditions.push(`al.actor_role = $${params.length}`); }
    if (from_date)   { params.push(from_date);              conditions.push(`al.created_at >= $${params.length}`); }
    if (to_date)     { params.push(to_date);                conditions.push(`al.created_at <= $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
      SELECT al.*, qc.name AS cycle_name
      FROM audit_log al
      LEFT JOIN questionnaire_cycles qc ON qc.id = al.cycle_id
      ${where}
      ORDER BY al.created_at ASC`;

    const result = await query(sql, params);

    interface AuditRow {
      id: number;
      created_at: string;
      action: string;
      actor_id: string | null;
      actor_name: string | null;
      actor_role: string | null;
      entity_type: string | null;
      entity_id: string | null;
      cycle_id: number | null;
      cycle_name: string | null;
      details: Record<string, unknown>;
    }

    const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
    const rows: AuditRow[] = result.rows.map(r => ({
      ...r,
      details: r.details != null ? parseJson(r.details) : {},
    } as AuditRow));

    const SCORE_LABELS: Record<number, string> = {
      1: '1 – Non-compliant', 2: '2 – Partially compliant',
      3: '3 – Largely compliant', 4: '4 – Fully compliant',
    };
    const scoreLabel = (v: unknown) => v != null ? (SCORE_LABELS[Number(v)] ?? String(v)) : '';
    const str = (v: unknown) => (v != null ? String(v) : '');
    const ts = (v: unknown) => v ? new Date(String(v)).toLocaleString('el-GR') : '';

    const ACTION_LABELS: Record<string, string> = {
      response_saved:                    'Score saved',
      response_submitted:                'Assessment submitted',
      response_returned:                 'Assessment returned to respondent',
      validation_updated:                'Validation score saved',
      validation_submitted_for_approval: 'Submitted for SV approval',
      validation_approved:               'Validation approved',
      validation_rejected:               'Validation rejected',
      validation_attachment_uploaded:    'Evidence file uploaded',
      attachment_uploaded:               'File uploaded',
      attachment_deleted:                'File deleted',
      cycle_created:                     'Cycle created',
      cycle_submitted_for_approval:      'Cycle submitted for approval',
      cycle_approved:                    'Cycle approved',
      cycle_rejected:                    'Cycle rejected',
      cycle_distributed:                 'Cycle distributed',
      cycle_closed:                      'Cycle closed',
      cycle_deleted:                     'Cycle deleted',
      checklist_uploaded:                'Checklist uploaded',
      user_created:                      'User created',
      user_updated:                      'User updated',
      user_enabled:                      'User enabled',
      user_disabled:                     'User disabled',
      user_deleted:                      'User deleted',
    };

    const subject = (d: Record<string, unknown>) => [
      d.bu_code    ? `BU ${d.bu_code}`    : null,
      d.item_number != null ? `Item ${d.item_number}` : d.question_id ? `Q${d.question_id}` : null,
      d.bu_name    ? `(${d.bu_name})`     : null,
      d.display_name ? str(d.display_name) : null,
    ].filter(Boolean).join(' ') || '';

    const comment = (d: Record<string, unknown>) =>
      str(d.comments ?? d.return_comment ?? d.rejection_comment ?? d.justification ?? '');

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Full Log ────────────────────────────────────────────────────
    const fullHeaders = [
      'Timestamp', 'Event', 'Actor', 'Role', 'Cycle',
      'Subject', 'Score', 'Comment / Justification', 'Additional Controls', 'File',
    ];
    const fullData = rows.map(r => {
      const d = r.details as Record<string, unknown>;
      const scoreVal = d.new_score ?? d.old_score ?? null;
      return [
        ts(r.created_at),
        ACTION_LABELS[r.action] ?? r.action,
        str(r.actor_name ?? r.actor_id),
        str(r.actor_role),
        str(r.cycle_name ?? r.cycle_id),
        subject(d),
        scoreVal != null ? scoreLabel(scoreVal) : '',
        comment(d),
        str(d.additional_controls ?? ''),
        str(d.file_name ?? ''),
      ];
    });
    const wsAll = XLSX.utils.aoa_to_sheet([fullHeaders, ...fullData]);
    wsAll['!cols'] = [
      { wch: 20 }, { wch: 32 }, { wch: 26 }, { wch: 18 }, { wch: 28 },
      { wch: 28 }, { wch: 26 }, { wch: 50 }, { wch: 40 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, wsAll, 'Full Log');

    // ── Sheet 2: Self Assessments (Responder) ────────────────────────────────
    const selfRows = rows.filter(r =>
      r.actor_role === 'Responder' &&
      (r.action === 'response_submitted' || r.action === 'response_saved' || r.action === 'attachment_uploaded')
    );
    const selfHeaders = ['Timestamp', 'Event', 'Respondent', 'Cycle', 'BU Code', 'Item No.', 'Self Assessment Score', 'Comments', 'File'];
    const selfData = selfRows.map(r => {
      const d = r.details as Record<string, unknown>;
      const scoreVal = d.new_score ?? d.compliance_score ?? null;
      return [
        ts(r.created_at),
        ACTION_LABELS[r.action] ?? r.action,
        str(r.actor_name ?? r.actor_id),
        str(r.cycle_name ?? r.cycle_id),
        str(d.bu_code ?? ''),
        d.item_number != null ? str(d.item_number) : d.question_id ? `Q${d.question_id}` : '',
        scoreVal != null ? scoreLabel(scoreVal) : '',
        str(d.comments ?? ''),
        str(d.file_name ?? ''),
      ];
    });
    const wsSelf = XLSX.utils.aoa_to_sheet([selfHeaders, ...selfData]);
    wsSelf['!cols'] = [
      { wch: 20 }, { wch: 26 }, { wch: 28 }, { wch: 28 },
      { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 50 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSelf, 'Self Assessments');

    // ── Sheet 3: Validator Activity ──────────────────────────────────────────
    const valRows = rows.filter(r =>
      r.actor_role === 'Validator' &&
      [
        'validation_updated', 'validation_submitted_for_approval',
        'validation_attachment_uploaded', 'response_returned',
      ].includes(r.action)
    );
    const valHeaders = [
      'Timestamp', 'Event', 'Validator', 'Cycle', 'BU Code', 'Item No.',
      'Validation Score', 'Justification', 'Additional Controls', 'Return Comment', 'File',
    ];
    const valData = valRows.map(r => {
      const d = r.details as Record<string, unknown>;
      const scoreVal = d.new_score ?? null;
      return [
        ts(r.created_at),
        ACTION_LABELS[r.action] ?? r.action,
        str(r.actor_name ?? r.actor_id),
        str(r.cycle_name ?? r.cycle_id),
        str(d.bu_code ?? ''),
        d.item_number != null ? str(d.item_number) : d.question_id ? `Q${d.question_id}` : '',
        scoreVal != null ? scoreLabel(scoreVal) : '',
        str(d.justification ?? ''),
        str(d.additional_controls ?? ''),
        str(d.return_comment ?? ''),
        str(d.file_name ?? ''),
      ];
    });
    const wsVal = XLSX.utils.aoa_to_sheet([valHeaders, ...valData]);
    wsVal['!cols'] = [
      { wch: 20 }, { wch: 32 }, { wch: 26 }, { wch: 28 }, { wch: 14 }, { wch: 12 },
      { wch: 26 }, { wch: 50 }, { wch: 40 }, { wch: 40 }, { wch: 30 },
    ];
    XLSX.utils.book_append_sheet(wb, wsVal, 'Validator Activity');

    // ── Sheet 4: SV Decisions ────────────────────────────────────────────────
    const svRows = rows.filter(r =>
      r.actor_role === 'Senior Validator' &&
      ['validation_approved', 'validation_rejected'].includes(r.action)
    );
    const svHeaders = [
      'Timestamp', 'Decision', 'Senior Validator', 'Cycle', 'BU Code', 'Item No.',
      'Validation Score', 'Rejection Comment',
    ];
    const svData = svRows.map(r => {
      const d = r.details as Record<string, unknown>;
      const scoreVal = d.new_score ?? null;
      return [
        ts(r.created_at),
        ACTION_LABELS[r.action] ?? r.action,
        str(r.actor_name ?? r.actor_id),
        str(r.cycle_name ?? r.cycle_id),
        str(d.bu_code ?? ''),
        d.item_number != null ? str(d.item_number) : d.question_id ? `Q${d.question_id}` : '',
        scoreVal != null ? scoreLabel(scoreVal) : '',
        str(d.rejection_comment ?? ''),
      ];
    });
    const wsSV = XLSX.utils.aoa_to_sheet([svHeaders, ...svData]);
    wsSV['!cols'] = [
      { wch: 20 }, { wch: 22 }, { wch: 28 }, { wch: 28 },
      { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 50 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSV, 'SV Decisions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const cyclePart = cycle_id ? `_cycle${cycle_id}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="RVMT_Audit_Log${cyclePart}.xlsx"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

export default router;
