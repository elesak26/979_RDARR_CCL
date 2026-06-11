import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { query } from '../db';
import { logAudit } from '../audit';

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { console.error('Could not create UPLOAD_DIR ' + UPLOAD_DIR, e); }

const valAttachStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const valAttachUpload = multer({ storage: valAttachStorage, limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

// GET /api/cycles/:cycleId/validations — list all validations for a cycle (join questions)
router.get(
  '/api/cycles/:cycleId/validations',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId } = req.params;
      const result = await query(
        `SELECT
           v.id, v.cycle_id, v.question_id, v.status,
           v.validation_score, v.justification, v.additional_controls,
           v.validated_by, v.validated_at,
           v.senior_validated_by, v.senior_validated_at, v.senior_rejection_comment,
           v.created_at, v.updated_at,
           q.item_number, q.thematic_area, q.requirement,
           q.bcbs_principle_number, q.bcbs_principle_name
         FROM validations v
         JOIN questions q ON q.id = v.question_id
         WHERE v.cycle_id = $1
         ORDER BY q.item_number`,
        [cycleId]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/validations/:id — get one validation with all BU responses side by side
router.get(
  '/api/cycles/:cycleId/validations/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId, id } = req.params;

      const validationResult = await query(
        `SELECT
           v.id, v.cycle_id, v.question_id, v.status,
           v.validation_score, v.justification, v.additional_controls,
           v.validated_by, v.validated_at,
           v.senior_validated_by, v.senior_validated_at, v.senior_rejection_comment,
           v.workflow_history, v.created_at, v.updated_at,
           q.item_number, q.thematic_area, q.requirement,
           q.bcbs_principle_number, q.bcbs_principle_name,
           q.expectations, q.score_1_desc, q.score_2_desc, q.score_3_desc, q.score_4_desc,
           q.supportive_material, q.related_kpis
         FROM validations v
         JOIN questions q ON q.id = v.question_id
         WHERE v.id = $1 AND v.cycle_id = $2`,
        [id, cycleId]
      );

      if (validationResult.rows.length === 0) {
        res.status(404).json({ error: 'Validation not found' });
        return;
      }

      const validation = validationResult.rows[0] as { question_id: number };

      // Get all BU responses for this question+cycle
      const responsesResult = await query(
        `SELECT r.id, r.bu_code, r.material_risk, r.status, r.compliance_score, r.comments,
                r.responder_id, r.responder_name, r.submitted_at,
                r.return_comment, r.returned_at
         FROM responses r
         WHERE r.cycle_id = $1 AND r.question_id = $2
         ORDER BY r.bu_code, r.material_risk NULLS FIRST`,
        [cycleId, validation.question_id]
      );

      res.json({
        ...validation,
        bu_responses: responsesResult.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/validations/:id — update validation (Validator)
router.put(
  '/api/cycles/:cycleId/validations/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;
      const { validation_score, justification, additional_controls } = req.body as {
        validation_score?: number;
        justification?: string;
        additional_controls?: string;
      };

      const result = await query(
        `UPDATE validations
         SET
           validation_score    = COALESCE($3, validation_score),
           justification       = COALESCE($4, justification),
           additional_controls = COALESCE($5, additional_controls),
           validated_by        = $6,
           updated_at          = now()
         WHERE id = $1 AND cycle_id = $2
         RETURNING *`,
        [
          id,
          cycleId,
          validation_score ?? null,
          justification ?? null,
          additional_controls ?? null,
          req.user?.id ?? null,
        ]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Validation not found' });
        return;
      }
      logAudit({ action: 'validation_updated', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, validation_score: result.rows[0].validation_score } });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/validations/:id/close — submit for approval (Validator)
router.put(
  '/api/cycles/:cycleId/validations/:id/close',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;

      const historyEntry = {
        action: 'submitted_for_approval',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        timestamp: new Date().toISOString(),
      };

      const result = await query(
        `UPDATE validations
         SET
           status           = 'pending_approval',
           validated_by     = $3,
           validated_at     = now(),
           updated_at       = now(),
           workflow_history = workflow_history || $4::jsonb
         WHERE id = $1 AND cycle_id = $2 AND status IN ('pending', 'in_review', 'rejected')
         RETURNING *`,
        [id, cycleId, req.user?.id ?? null, JSON.stringify([historyEntry])]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Validation not found or not in a submittable state' });
        return;
      }
      logAudit({ action: 'validation_submitted_for_approval', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id } });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/validations/:id/approve — approve validation (Senior Validator)
router.put(
  '/api/cycles/:cycleId/validations/:id/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Senior Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;

      const historyEntry = {
        action: 'approved',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        timestamp: new Date().toISOString(),
      };

      const result = await query(
        `UPDATE validations
         SET
           status                 = 'closed',
           validated_by           = validated_by,
           validated_at           = validated_at,
           senior_validated_by    = $3,
           senior_validated_at    = now(),
           updated_at             = now(),
           workflow_history       = workflow_history || $4::jsonb
         WHERE id = $1 AND cycle_id = $2 AND status = 'pending_approval'
         RETURNING *`,
        [id, cycleId, req.user?.id ?? null, JSON.stringify([historyEntry])]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Validation not found or not pending approval' });
        return;
      }
      logAudit({ action: 'validation_approved', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id } });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/validations/:id/reject — reject validation (Senior Validator)
router.put(
  '/api/cycles/:cycleId/validations/:id/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Senior Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;
      const { rejection_comment: comment } = req.body as { rejection_comment?: string };

      const historyEntry = {
        action: 'rejected',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        timestamp: new Date().toISOString(),
        comment: comment ?? null,
      };

      const result = await query(
        `UPDATE validations
         SET
           status                   = 'rejected',
           senior_validated_by      = $3,
           senior_validated_at      = now(),
           senior_rejection_comment = $4,
           updated_at               = now(),
           workflow_history         = workflow_history || $5::jsonb
         WHERE id = $1 AND cycle_id = $2 AND status = 'pending_approval'
         RETURNING *`,
        [id, cycleId, req.user?.id ?? null, comment ?? null, JSON.stringify([historyEntry])]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Validation not found or not pending approval' });
        return;
      }
      logAudit({ action: 'validation_rejected', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, rejection_comment: comment ?? null } });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/validations/:id/attachments
router.get(
  '/api/cycles/:cycleId/validations/:id/attachments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await query(
        `SELECT id, validation_id, file_name, file_path, uploaded_by, uploaded_at
         FROM validation_attachments WHERE validation_id = $1 ORDER BY uploaded_at`,
        [id]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/cycles/:cycleId/validations/:id/attachments — Validator only
router.post(
  '/api/cycles/:cycleId/validations/:id/attachments',
  valAttachUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const { id } = req.params;
      const result = await query(
        `INSERT INTO validation_attachments (validation_id, file_name, file_path, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.file.originalname, req.file.filename, req.user?.display_name ?? null]
      );
      logAudit({ action: 'validation_attachment_uploaded', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(id), details: { file_name: req.file.originalname } });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/cycles/:cycleId/validations/:id/attachments/:attachId — Validator only
router.delete(
  '/api/cycles/:cycleId/validations/:id/attachments/:attachId',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { attachId } = req.params;
      const result = await query<{ file_path: string }>(
        `DELETE FROM validation_attachments WHERE id = $1 RETURNING file_path`,
        [attachId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      fs.unlink(path.join(UPLOAD_DIR, result.rows[0].file_path), () => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/validations/:id/attachments/:attachId/download
router.get(
  '/api/cycles/:cycleId/validations/:id/attachments/:attachId/download',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { attachId } = req.params;
      const result = await query<{ file_name: string; file_path: string }>(
        `SELECT file_name, file_path FROM validation_attachments WHERE id = $1`,
        [attachId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      const { file_name, file_path } = result.rows[0];
      res.download(path.join(UPLOAD_DIR, file_path), file_name);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
