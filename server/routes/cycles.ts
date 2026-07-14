import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { query } from '../db';
import { logAudit } from '../audit';
import { notifyRole } from '../notify';

interface ChecklistEntry {
  buCode: string;
  materialRisk: string | null;
  weight: number | null; // 0–1 decimal, e.g. 0.40 for "40%"
}

interface ChecklistRow {
  itemNumber: number;
  entries: ChecklistEntry[];
}

/**
 * Parse column K entries of the form:
 *   "966: Operational Risk: 40% | 007: Operational Risk: 60%"
 * Each pipe-separated token is "BU_CODE: Material Risk Label: Weight%"
 * Returns one ChecklistEntry per token.
 */
function parseColumnK(raw: string): ChecklistEntry[] {
  return raw
    .split('|')
    .map(token => token.replace(/[\r\n]/g, ' ').trim())
    .filter(Boolean)
    .map(token => {
      // Split on ':' — first segment is BU code, last is weight%, middle is risk label
      const parts = token.split(':').map(p => p.trim());
      if (parts.length < 2) return { buCode: token, materialRisk: null, weight: null };

      const buCode = parts[0];
      const weightStr = parts[parts.length - 1]; // e.g. "40%"
      const weightMatch = weightStr.match(/([\d.]+)\s*%/);
      const weight = weightMatch ? parseFloat(weightMatch[1]) / 100 : null;

      // Middle parts (between BU code and weight) form the material risk label
      const riskParts = parts.slice(1, parts.length - 1);
      const materialRisk = riskParts.length > 0 ? riskParts.join(':').trim() || null : null;

      return { buCode, materialRisk, weight };
    })
    .filter(e => e.buCode.length > 0);
}

function parseChecklistXlsx(filePath: string): ChecklistRow[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Compliance Checklist'];
  if (!ws) throw new Error('XLSX is missing the "Compliance Checklist" sheet');

  // Build a row→col→value map by iterating actual cell keys only.
  // This avoids sheet_to_json which allocates a full array up to !ref's last row —
  // some files have a stray cell at row 1M that extends !ref to the sheet limit.
  const COL_ITEM = 0;   // A
  const COL_UNITS = 10; // K

  const cellMap = new Map<number, Map<number, string | number>>();
  for (const key of Object.keys(ws)) {
    if (key.startsWith('!')) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (c !== COL_ITEM && c !== COL_UNITS) continue;
    const v = ws[key]?.v;
    if (v === null || v === undefined || v === '') continue;
    if (!cellMap.has(r)) cellMap.set(r, new Map());
    cellMap.get(r)!.set(c, v as string | number);
  }

  // Find header row (row where col A === 'Item #'), search first 20 rows
  const sortedRows = [...cellMap.keys()].sort((a, b) => a - b);
  let hdrRow = -1;
  for (const r of sortedRows.slice(0, 20)) {
    if (cellMap.get(r)?.get(COL_ITEM) === 'Item #') { hdrRow = r; break; }
  }
  if (hdrRow === -1) throw new Error('Cannot find header row ("Item #") in Compliance Checklist sheet');

  const results: ChecklistRow[] = [];
  for (const r of sortedRows) {
    if (r <= hdrRow) continue;
    const row = cellMap.get(r)!;
    const itemRaw = row.get(COL_ITEM);
    if (itemRaw === undefined) continue;
    const itemNumber = typeof itemRaw === 'number' ? itemRaw : parseInt(String(itemRaw), 10);
    if (!Number.isFinite(itemNumber)) continue;

    const unitsRaw = row.get(COL_UNITS);
    if (!unitsRaw) continue;
    const entries = parseColumnK(String(unitsRaw));
    if (entries.length === 0) continue;

    results.push({ itemNumber, entries });
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

// BU 961 is split into three material-risk sub-entities for validation purposes.
// These codes are the canonical keys used in ccl_item_weights and respondent_units.
const BU_961_SPLIT = ['961-IRRBB', '961-Liquidity', '961-Market'];

// Maps a material_risk label (from XLSX column K) to its 961 sub-entity bu_code.
const MATERIAL_RISK_TO_961_BU: Record<string, string> = {
  'IRRBB': '961-IRRBB',
  'Liquidity Risk': '961-Liquidity',
  'Market Risk': '961-Market',
};

// Question-to-BU mapping derived from 0NBG_RDARR Compliance Checklist_addons_v3.xlsx
// Key = item_number, value = list of BU codes assigned to that question.
// BU 961 is listed as three separate entries (one per material risk) rather than bare '961'.
const QUESTION_BU_MAP: Record<number, string[]> = {
   1: ['966', '007-52'],
   2: ['966', '030', ...BU_961_SPLIT, '023', '908', '006', '956', '974'],
   3: ['966'],
   4: ['966'],
   5: ['966'],
   6: ['966'],
   7: ['966', 'DG MLE'],
   8: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
   9: ['966'],
  10: ['966'],
  11: ['966'],
  12: ['966', '030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  13: ['966', '030', ...BU_961_SPLIT, '023', '908'],
  14: ['966', '030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  15: ['966'],
  16: ['966'],
  17: ['979'],
  18: ['966'],
  19: ['030', ...BU_961_SPLIT, '023', '908', '006', '956', '966', '905'],
  20: ['DG MLE'],
  21: ['030', ...BU_961_SPLIT, '023', '908', '006', '956', '905'],
  22: ['966'],
  23: ['966', '030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  24: ['966'],
  25: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  26: ['966'],
  27: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  28: ['030', ...BU_961_SPLIT, '023', '902'],
  29: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  30: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  31: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  32: ['966'],
  33: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  34: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  35: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  36: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  37: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  38: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  39: ['030', ...BU_961_SPLIT, '023', '908', '006', '956'],
  40: ['030', ...BU_961_SPLIT, '023', '908', '006', '956', 'Committee Secretaries'],
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
      `SELECT COUNT(CASE WHEN status = 'submitted' THEN id END) AS total_submitted
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
      `INSERT INTO questionnaire_cycles (name, year, description, created_by) VALUES ($1, $2, $3, $4)`,
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
       SET status = 'pending_approval', rejection_comment = NULL, updated_at = NOW() WHERE id = $1 AND status = 'draft'
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
      parseInt(String(id), 10),
      `/cycles`
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
       SET status = 'published', published_at = NOW(), rejection_comment = NULL, updated_at = NOW() WHERE id = $1 AND status = 'pending_approval'
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
      parseInt(String(id), 10),
      `/cycles`
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
    const { rejection_comment } = req.body as { rejection_comment?: string };
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'draft', rejection_comment = $2, published_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'pending_approval'
       RETURNING *`,
      [id, rejection_comment?.trim() || null]
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

      const rows: { question_id: number; bu_code: string; material_risk: string | null; weight: number | null }[] = [];

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
          for (const { itemNumber, entries } of xlsxRows) {
            const qInfo = questionMap.get(itemNumber);
            if (!qInfo) continue;
            for (const { buCode, materialRisk, weight } of entries) {
              // BU 961 entries are emitted as split sub-entity codes based on their material risk label
              const resolvedBuCode =
                buCode === '961' && materialRisk && MATERIAL_RISK_TO_961_BU[materialRisk]
                  ? MATERIAL_RISK_TO_961_BU[materialRisk]
                  : buCode;
              rows.push({ question_id: qInfo.id, bu_code: resolvedBuCode, material_risk: materialRisk, weight });
            }
          }
          usedXlsx = rows.length > 0;
        } catch (_err) {
          // XLSX parse failed — fall through to hardcoded map
        }
      }

      if (!usedXlsx) {
        // Fallback: hardcoded QUESTION_BU_MAP (equal weights per BU)
        for (const [itemNumber, buCodes] of Object.entries(QUESTION_BU_MAP)) {
          const qInfo = questionMap.get(Number(itemNumber));
          if (!qInfo) continue;
          const equalWeight = buCodes.length > 0 ? 1 / buCodes.length : null;
          for (const buCode of buCodes) {
            rows.push({ question_id: qInfo.id, bu_code: buCode, material_risk: null, weight: equalWeight });
          }
        }
      }

      if (rows.length === 0) {
        res.status(500).json({ error: 'Cannot distribute: no applicability rows could be derived from the checklist or question map.' });
        return;
      }

      // Dedupe within the batch (pg ON CONFLICT DO NOTHING kept the first of any
      // duplicate key); NULLS-NOT-DISTINCT semantics via the sentinel below.
      const seenQa = new Set<string>();
      const uniqueRows = rows.filter(r => {
        const k = `${r.question_id}|${r.bu_code}|${r.material_risk ?? ''}`;
        if (seenQa.has(k)) return false;
        seenQa.add(k);
        return true;
      });
      await query(
        `INSERT INTO question_applicability (cycle_id, question_id, bu_code, bu_name, assigned_by, material_risk, weight)
         SELECT $1, j.question_id, j.bu_code, j.bu_code, $2, j.material_risk, j.weight
         FROM json_to_recordset($3::json) AS j(question_id int, bu_code text, material_risk text, weight numeric)
         WHERE NOT EXISTS (
           SELECT 1 FROM question_applicability qa
           WHERE qa.cycle_id = $1 AND qa.question_id = j.question_id AND qa.bu_code = j.bu_code
             AND qa.material_risk IS NOT DISTINCT FROM j.material_risk
         )`,
        [
          id,
          req.user?.id ?? null,
          JSON.stringify(uniqueRows.map(r => ({
            question_id: r.question_id,
            bu_code: r.bu_code,
            material_risk: r.material_risk ?? null,
            weight: r.weight ?? null,
          }))),
        ]
      );
    }

    // Transition cycle status
    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'distributed', distributed_at = NOW(), updated_at = NOW() WHERE id = $1
       RETURNING *`,
      [id]
    );

    // Create draft response rows for every (question, BU, material_risk) applicability entry, carrying weight
    const insertResult = await query<{ cnt: string }>(
      `INSERT INTO responses (cycle_id, question_id, bu_code, material_risk, weight)
       SELECT qa.cycle_id, qa.question_id, qa.bu_code, qa.material_risk, qa.weight
       FROM question_applicability qa
       WHERE qa.cycle_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM responses r
           WHERE r.cycle_id = qa.cycle_id AND r.question_id = qa.question_id AND r.bu_code = qa.bu_code
             AND r.material_risk IS NOT DISTINCT FROM qa.material_risk
         )
       ON CONFLICT DO NOTHING`,
      [id]
    );

    logAudit({ action: 'cycle_distributed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(id), cycle_id: parseInt(String(id), 10), details: { responses_created: insertResult.rowCount } });
    const cycle2 = result.rows[0] as { name: string };
    notifyRole('Validator',
      `Cycle "${cycle2.name}" has been distributed`,
      `Cycle "${cycle2.name}" is now in validation. Items are ready to be assessed by respondents.`,
      parseInt(String(id), 10),
      `/validation`
    ).catch(() => {});
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/cycles/:id/close — distributed → closed (Validator)
router.put('/api/cycles/:id/close', async (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Validator') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  try {
    const { id } = req.params;

    // Verify cycle exists and is distributed
    const cycleCheck = await query(
      `SELECT id FROM questionnaire_cycles WHERE id = $1 AND status = 'distributed'`,
      [id]
    );
    if (cycleCheck.rows.length === 0) {
      res.status(400).json({ error: 'Cycle not found or not in distributed status' });
      return;
    }

    // Block if any response is not yet submitted
    const pendingResponses = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM responses
       WHERE cycle_id = $1 AND status NOT IN ('submitted')`,
      [id]
    );
    if (parseInt(pendingResponses.rows[0].cnt, 10) > 0) {
      res.status(400).json({
        error: `Cannot close: ${pendingResponses.rows[0].cnt} response(s) have not been submitted by respondents yet.`,
      });
      return;
    }

    // Block if any validation is not yet closed
    const pendingValidations = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM validations
       WHERE cycle_id = $1 AND status <> 'closed'`,
      [id]
    );
    if (parseInt(pendingValidations.rows[0].cnt, 10) > 0) {
      res.status(400).json({
        error: `Cannot close: ${pendingValidations.rows[0].cnt} validation item(s) have not been fully reviewed and approved by the Senior Validator yet.`,
      });
      return;
    }

    const result = await query(
      `UPDATE questionnaire_cycles
       SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1
       RETURNING *`,
      [id]
    );
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
      `DELETE FROM questionnaire_cycles WHERE id = $1 AND status IN ('draft', 'published')`,
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
        `UPDATE questionnaire_cycles SET checklist_file = $1, checklist_original_name = $2, updated_at = NOW() WHERE id = $3
       RETURNING *`,
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
