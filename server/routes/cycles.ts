import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { query } from '../db';
import { logAudit } from '../audit';
import { notifyRole } from '../notify';

interface ChecklistRow {
  itemNumber: number;
  buCodes: string[];
  materialRisk: string | null;
}

function parseChecklistXlsx(filePath: string): ChecklistRow[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Compliance Checklist'];
  if (!ws) throw new Error('XLSX is missing the "Compliance Checklist" sheet');

  const raw = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null });

  // Find header row (contains "Item #")
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(20, raw.length); i++) {
    if (raw[i] && raw[i][0] === 'Item #') { hdrIdx = i; break; }
  }
  if (hdrIdx === -1) throw new Error('Cannot find header row ("Item #") in Compliance Checklist sheet');

  const COL_ITEM = 0;
  const COL_UNITS = 10;
  const COL_RISK = 12;

  const results: ChecklistRow[] = [];
  for (let i = hdrIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.every(c => c === null)) continue;
    const itemRaw = row[COL_ITEM];
    if (itemRaw === null || itemRaw === undefined) continue;
    const itemNumber = typeof itemRaw === 'number' ? itemRaw : parseInt(String(itemRaw), 10);
    if (!Number.isFinite(itemNumber)) continue;

    const unitsRaw = row[COL_UNITS] as string | null;
    if (!unitsRaw) continue;
    const buCodes = String(unitsRaw)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (buCodes.length === 0) continue;

    const riskRaw = row[COL_RISK] as string | null;
    const materialRisk = riskRaw ? String(riskRaw).trim() || null : null;

    results.push({ itemNumber, buCodes, materialRisk });
  }
  return results;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('Could not create UPLOAD_DIR ' + UPLOAD_DIR, e); }

const checklistStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const checklistUpload = multer({ storage: checklistStorage, limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

// Question-to-BU mapping derived from 0NBG_RDARR Compliance Checklist_addons_v3.xlsx
// Key = item_number, value = list of BU codes assigned to that question
const QUESTION_BU_MAP: Record<number, string[]> = {
   1: ['966', '007-52'],
   2: ['966', '030', '961', '023', '908', '006', '956', '974'],
   3: ['966'],
   4: ['966'],
   5: ['966'],
   6: ['966'],
   7: ['966', 'DG MLE'],
   8: ['030', '961', '023', '908', '006', '956'],
   9: ['966'],
  10: ['966'],
  11: ['966'],
  12: ['966', '030', '961', '023', '908', '006', '956'],
  13: ['966', '030', '961', '023', '908'],
  14: ['966', '030', '961', '023', '908', '006', '956'],
  15: ['966'],
  16: ['966'],
  17: ['979'],
  18: ['966'],
  19: ['030', '961', '023', '908', '006', '956', '966', '905'],
  20: ['DG MLE'],
  21: ['030', '961', '023', '908', '006', '956', '905'],
  22: ['966'],
  23: ['966', '030', '961', '023', '908', '006', '956'],
  24: ['966'],
  25: ['030', '961', '023', '908', '006', '956'],
  26: ['966'],
  27: ['030', '961', '023', '908', '006', '956'],
  28: ['030', '961', '023', '902'],
  29: ['030', '961', '023', '908', '006', '956'],
  30: ['030', '961', '023', '908', '006', '956'],
  31: ['030', '961', '023', '908', '006', '956'],
  32: ['966'],
  33: ['030', '961', '023', '908', '006', '956'],
  34: ['030', '961', '023', '908', '006', '956'],
  35: ['030', '961', '023', '908', '006', '956'],
  36: ['030', '961', '023', '908', '006', '956'],
  37: ['030', '961', '023', '908', '006', '956'],
  38: ['030', '961', '023', '908', '006', '956'],
  39: ['030', '961', '023', '908', '006', '956'],
  40: ['030', '961', '023', '908', '006', '956', 'Committee Secretaries'],
};

// GET /api/cycles — list all cycles
router.get('/api/cycles', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT id, name, year, status, created_by, published_at, distributed_at, closed_at, rejection_comment, checklist_file, checklist_original_name, description, created_at, updated_at
       FROM questionnaire_cycles
       ORDER BY year DESC, id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/cycles/:id — get one cycle with counts
router.get('/api/cycles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const cycleResult = await query(
      `SELECT id, name, year, status, created_by, published_at, distributed_at, closed_at, rejection_comment, checklist_file, checklist_original_name, description, created_at, updated_at
       FROM questionnaire_cycles
       WHERE id = $1`,
      [id]
    );
    if (cycleResult.rows.length === 0) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }

    const countsResult = await query<{ total_submitted: string }>(
      `SELECT COUNT(id) FILTER (WHERE status = 'submitted')::text AS total_submitted
       FROM responses WHERE cycle_id = $1`,
      [id]
    );

    res.json({
      ...cycleResult.rows[0],
      total_submitted: parseInt(countsResult.rows[0]?.total_submitted ?? '0', 10),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/cycles — create cycle (Admin)
router.post('/api/cycles', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { name, year, description } = req.body as { name: string; year: number; description?: string };
    if (!name || !year) {
      res.status(400).json({ error: 'name and year are required' });
      return;
    }
    const duplicate = await query(
      `SELECT id FROM questionnaire_cycles WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND year = $2`,
      [name, year]
    );
    if (duplicate.rowCount && duplicate.rowCount > 0) {
      res.status(409).json({ error: `A cycle named "${name.trim()}" already exists for ${year}` });
      return;
    }
    const result = await query(
      `INSERT INTO questionnaire_cycles (name, year, description, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, year, description?.trim() || null, req.user?.id ?? null]
    );
    logAudit({ action: 'cycle_created', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(result.rows[0].id), cycle_id: result.rows[0].id as number, details: { name: result.rows[0].name, year: result.rows[0].year } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/submit — draft → pending_approval (Validator)
router.put('/api/cycles/:id/submit', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const check = await query<{ checklist_file: string | null }>(
      `SELECT checklist_file FROM questionnaire_cycles WHERE id = $1 AND status = 'draft'`,
      [id]
    );
    if (check.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not in draft status' });
      return;
    }
    if (!check.rows[0].checklist_file) {
      res.status(400).json({ error: 'A checklist file must be uploaded before submitting for approval' });
      return;
    }
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'pending_approval', rejection_comment = NULL, updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not in draft status' });
      return;
    }
    logAudit({ action: 'cycle_submitted_for_approval', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: {} });
    const cycle0 = result.rows[0] as { name: string };
    notifyRole('Senior Validator',
      `Cycle "${cycle0.name}" pending your approval`,
      `The Validator has submitted cycle "${cycle0.name}" for approval. Please review and approve or reject it.`,
      parseInt(String(id), 10)
    ).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/approve — pending_approval → published (Senior Validator)
router.put('/api/cycles/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Senior Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'published', published_at = now(), rejection_comment = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending_approval'
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not pending approval' });
      return;
    }
    logAudit({ action: 'cycle_approved', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: {} });
    const cycle1 = result.rows[0] as { name: string };
    notifyRole('Validator',
      `Cycle "${cycle1.name}" approved — ready to distribute`,
      `The Senior Validator has approved cycle "${cycle1.name}". You can now distribute the checklist to respondents.`,
      parseInt(String(id), 10)
    ).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/reject — pending_approval → draft (Senior Validator, comment required)
router.put('/api/cycles/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Senior Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'draft', rejection_comment = NULL, published_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending_approval'
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not pending approval' });
      return;
    }
    logAudit({ action: 'cycle_rejected', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: {} });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/distribute — published → distributed (Validator)
router.put('/api/cycles/:id/distribute', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;

    // Verify cycle exists and is published
    const cycleResult = await query(
      `SELECT id FROM questionnaire_cycles WHERE id = $1 AND status = 'published'`,
      [id]
    );
    if (cycleResult.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not in published status' });
      return;
    }

    // Seed question_applicability — prefer the uploaded checklist XLSX, fall back to hardcoded map
    const applicabilityCheck = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM question_applicability WHERE cycle_id = $1`,
      [id]
    );
    if (parseInt(applicabilityCheck.rows[0].cnt, 10) === 0) {
      const questionsResult = await query<{ id: number; item_number: number; material_risk: string | null }>(
        `SELECT id, item_number, material_risk FROM questions ORDER BY item_number`
      );
      const questionMap = new Map<number, { id: number; material_risk: string | null }>();
      for (const q of questionsResult.rows) questionMap.set(q.item_number, { id: q.id, material_risk: q.material_risk });

      const rows: { question_id: number; bu_code: string; material_risk: string | null }[] = [];

      // Try to parse the uploaded checklist XLSX for this cycle
      const cycleFileResult = await query<{ checklist_file: string | null }>(
        `SELECT checklist_file FROM questionnaire_cycles WHERE id = $1`,
        [id]
      );
      const checklistFile = cycleFileResult.rows[0]?.checklist_file ?? null;
      let usedXlsx = false;

      if (checklistFile) {
        try {
          const filePath = path.join(UPLOAD_DIR, checklistFile);
          const xlsxRows = parseChecklistXlsx(filePath);
          for (const { itemNumber, buCodes, materialRisk } of xlsxRows) {
            const qInfo = questionMap.get(itemNumber);
            if (!qInfo) continue;
            // If the XLSX specifies a material risk, create one row per risk token
            const risks = materialRisk
              ? materialRisk.split('|').map(r => r.trim()).filter(Boolean)
              : [];
            for (const buCode of buCodes) {
              if (buCode === '961' && risks.length > 0) {
                for (const risk of risks) {
                  rows.push({ question_id: qInfo.id, bu_code: buCode, material_risk: risk });
                }
              } else {
                rows.push({ question_id: qInfo.id, bu_code: buCode, material_risk: null });
              }
            }
          }
          usedXlsx = rows.length > 0;
        } catch (_err) {
          // XLSX parse failed — fall through to hardcoded map
        }
      }

      if (!usedXlsx) {
        // Fallback: hardcoded QUESTION_BU_MAP
        for (const [itemNumber, buCodes] of Object.entries(QUESTION_BU_MAP)) {
          const qInfo = questionMap.get(Number(itemNumber));
          if (!qInfo) continue;
          const risks = qInfo.material_risk
            ? qInfo.material_risk.split(',').map(r => r.trim()).filter(Boolean)
            : [];
          for (const buCode of buCodes) {
            if (buCode === '961' && risks.length > 0) {
              for (const risk of risks) {
                rows.push({ question_id: qInfo.id, bu_code: buCode, material_risk: risk });
              }
            } else {
              rows.push({ question_id: qInfo.id, bu_code: buCode, material_risk: null });
            }
          }
        }
      }

      if (rows.length === 0) {
        res.status(500).json({ error: 'Cannot distribute: no applicability rows could be derived from the checklist or question map.' });
        return;
      }

      for (const row of rows) {
        await query(
          `INSERT INTO question_applicability (cycle_id, question_id, bu_code, bu_name, assigned_by, material_risk)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (cycle_id, question_id, bu_code, material_risk) DO NOTHING`,
          [id, row.question_id, row.bu_code, row.bu_code, req.user?.id ?? null, row.material_risk ?? null]
        );
      }
    }

    // Transition cycle status
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'distributed', distributed_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Create draft response rows for every (question, BU, material_risk) applicability entry
    const insertResult = await query<{ cnt: string }>(
      `INSERT INTO responses (cycle_id, question_id, bu_code, material_risk)
       SELECT qa.cycle_id, qa.question_id, qa.bu_code, qa.material_risk
       FROM question_applicability qa
       WHERE qa.cycle_id = $1
       ON CONFLICT (cycle_id, question_id, bu_code, material_risk) DO NOTHING
       RETURNING id`,
      [id]
    );

    logAudit({ action: 'cycle_distributed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { responses_created: insertResult.rowCount } });
    const cycle2 = result.rows[0] as { name: string };
    notifyRole('Validator',
      `Cycle "${cycle2.name}" has been distributed`,
      `Cycle "${cycle2.name}" is now in validation. Items are ready to be assessed by respondents.`,
      parseInt(String(id), 10)
    ).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/close — distributed → closed (Admin)
router.put('/api/cycles/:id/close', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'closed', closed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'distributed'
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not in distributed status' });
      return;
    }
    logAudit({ action: 'cycle_closed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: {} });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/cycles/:id — delete a draft or published cycle (Admin only)
router.delete('/api/cycles/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query(
      `DELETE FROM questionnaire_cycles
       WHERE id = $1 AND status IN ('draft', 'published')
       RETURNING id, name`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or cannot be deleted in its current status' });
      return;
    }
    logAudit({ action: 'cycle_deleted', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { name: result.rows[0].name } });
    res.json({ deleted: true, id: result.rows[0].id, name: result.rows[0].name });
  } catch (err) {
    next(err);
  }
});

// POST /api/cycles/:id/checklist — upload checklist file (Admin or Validator on draft cycles)
router.post(
  '/api/cycles/:id/checklist',
  checklistUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const { id } = req.params;

      // Verify the cycle exists and Validator status constraint before touching files
      const existing = await query<{ checklist_file: string | null; status: string }>(
        `SELECT checklist_file, status FROM questionnaire_cycles WHERE id = $1`,
        [id]
      );
      if (existing.rows.length === 0) {
        res.status(404).json({ error: 'Cycle not found' });
        return;
      }
      if (existing.rows[0].status !== 'draft') {
        res.status(400).json({ error: 'Checklist can only be uploaded on draft cycles' });
        return;
      }

      // Remove old file from disk now that we know the update will proceed
      const old = existing.rows[0].checklist_file;
      if (old) {
        const oldPath = path.join(UPLOAD_DIR, old);
        fs.unlink(oldPath, () => {});
      }

      const result = await query(
        `UPDATE questionnaire_cycles SET checklist_file = $1, checklist_original_name = $2, updated_at = now() WHERE id = $3 RETURNING *`,
        [req.file.filename, req.file.originalname, id]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Cycle not found' });
        return;
      }
      logAudit({ action: 'checklist_uploaded', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { file_name: req.file.originalname } });
      res.json({ ok: true, checklist_file: req.file.filename, original_name: req.file.originalname });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:id/checklist — download checklist file (authenticated)
router.get('/api/cycles/:id/checklist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await query<{ checklist_file: string | null; name: string }>(
      `SELECT checklist_file, name FROM questionnaire_cycles WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
    const { checklist_file, name: cycleName } = result.rows[0];
    if (!checklist_file) {
      res.status(404).json({ error: 'No checklist uploaded for this cycle' });
      return;
    }
    const filePath = path.join(UPLOAD_DIR, checklist_file);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    // Derive original name from stored filename (strip timestamp prefix)
    const originalName = checklist_file.replace(/^\d+_/, '').replace(/_/g, ' ');
    res.download(filePath, originalName || `${cycleName}_checklist.xlsx`);
  } catch (err) {
    next(err);
  }
});

// GET /api/cycles/:id/comments — list comments (Validator, Senior Validator, Admin)
router.get('/api/cycles/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  const role = req.user?.role;
  if (role !== 'Validator' && role !== 'Senior Validator' && role !== 'Admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const result = await query<{
      id: number; user_id: string; user_name: string; user_role: string; body: string; created_at: string;
    }>(
      `SELECT id, user_id, user_name, user_role, body, created_at
       FROM cycle_comments WHERE cycle_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/cycles/:id/comments — post a comment (Validator or Senior Validator, pending_approval only)
router.post('/api/cycles/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  const role = req.user?.role;
  if (role !== 'Validator' && role !== 'Senior Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;
    const { body } = req.body as { body: string };
    if (!body?.trim()) {
      res.status(400).json({ error: 'Comment body is required' });
      return;
    }
    const cycleResult = await query<{ status: string }>(
      `SELECT status FROM questionnaire_cycles WHERE id = $1`,
      [id]
    );
    if (cycleResult.rows.length === 0) {
      res.status(404).json({ error: 'Cycle not found' });
      return;
    }
    if (!['draft', 'pending_approval'].includes(cycleResult.rows[0].status)) {
      res.status(400).json({ error: 'Comments can only be posted on draft or pending approval cycles' });
      return;
    }
    const result = await query<{
      id: number; user_id: string; user_name: string; user_role: string; body: string; created_at: string;
    }>(
      `INSERT INTO cycle_comments (cycle_id, user_id, user_name, user_role, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, user_name, user_role, body, created_at`,
      [id, req.user?.id, req.user?.display_name, role, body.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
