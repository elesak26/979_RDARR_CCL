import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { query } from '../db';
import { logAudit } from '../audit';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
      `SELECT id, name, year, status, created_by, published_at, distributed_at, closed_at, rejection_comment, checklist_file, created_at, updated_at
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
      `SELECT id, name, year, status, created_by, published_at, distributed_at, closed_at, rejection_comment, checklist_file, created_at, updated_at
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
    const { name, year } = req.body as { name: string; year: number };
    if (!name || !year) {
      res.status(400).json({ error: 'name and year are required' });
      return;
    }
    const result = await query(
      `INSERT INTO questionnaire_cycles (name, year, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, year, req.user?.id ?? null]
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
    const { comment } = req.body as { comment?: string };
    if (!comment?.trim()) {
      res.status(400).json({ error: 'A rejection comment is required' });
      return;
    }
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'draft', rejection_comment = $2, published_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending_approval'
       RETURNING *`,
      [id, comment.trim()]
    );
    if (result.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not pending approval' });
      return;
    }
    logAudit({ action: 'cycle_rejected', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { comment: comment.trim() } });
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

    // Auto-seed question_applicability from the xlsx mapping if not yet populated
    const applicabilityCheck = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM question_applicability WHERE cycle_id = $1`,
      [id]
    );
    if (parseInt(applicabilityCheck.rows[0].cnt, 10) === 0) {
      // Fetch all questions so we can map item_number → question id
      const questionsResult = await query<{ id: number; item_number: number }>(
        `SELECT id, item_number FROM questions ORDER BY item_number`
      );
      const questionMap = new Map<number, number>();
      for (const q of questionsResult.rows) questionMap.set(q.item_number, q.id);

      // Build insert rows from the xlsx-derived mapping
      const rows: { question_id: number; bu_code: string }[] = [];
      for (const [itemNumber, buCodes] of Object.entries(QUESTION_BU_MAP)) {
        const questionId = questionMap.get(Number(itemNumber));
        if (!questionId) continue;
        for (const buCode of buCodes) {
          rows.push({ question_id: questionId, bu_code: buCode });
        }
      }

      if (rows.length === 0) {
        res.status(500).json({ error: 'Cannot distribute: no questions found in database to map.' });
        return;
      }

      // Bulk insert applicability entries
      for (const row of rows) {
        await query(
          `INSERT INTO question_applicability (cycle_id, question_id, bu_code, bu_name, assigned_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (cycle_id, question_id, bu_code) DO NOTHING`,
          [id, row.question_id, row.bu_code, row.bu_code, req.user?.id ?? null]
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

    // Create draft response rows for every (question, BU) applicability entry
    const insertResult = await query<{ cnt: string }>(
      `INSERT INTO responses (cycle_id, question_id, bu_code)
       SELECT qa.cycle_id, qa.question_id, qa.bu_code
       FROM question_applicability qa
       WHERE qa.cycle_id = $1
       ON CONFLICT (cycle_id, question_id, bu_code) DO NOTHING
       RETURNING id`,
      [id]
    );

    logAudit({ action: 'cycle_distributed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { responses_created: insertResult.rowCount } });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/close — distributed → closed (Admin)
router.put('/api/cycles/:id/close', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Admin') {
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

// POST /api/cycles/:id/checklist — upload checklist file (Admin only)
router.post(
  '/api/cycles/:id/checklist',
  checklistUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const { id } = req.params;
      // Delete old file if present
      const existing = await query<{ checklist_file: string | null }>(
        `SELECT checklist_file FROM questionnaire_cycles WHERE id = $1`,
        [id]
      );
      const old = existing.rows[0]?.checklist_file;
      if (old) {
        const oldPath = path.join(UPLOAD_DIR, old);
        fs.unlink(oldPath, () => {});
      }
      const result = await query(
        `UPDATE questionnaire_cycles SET checklist_file = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [req.file.filename, id]
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

export default router;
