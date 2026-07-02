import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { query } from '../db';
import { logAudit } from '../audit';
import { notifyRole } from '../notify';

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
           v.id, v.cycle_id, v.question_id, v.bu_code, v.status,
           v.validation_score, v.justification, v.additional_controls,
           v.validated_by, v.validated_at,
           v.senior_validated_by, v.senior_validated_at, v.senior_rejection_comment,
           v.created_at, v.updated_at,
           q.item_number, q.thematic_area, q.requirement,
           q.bcbs_principle_number, q.bcbs_principle_name
         FROM validations v
         JOIN questions q ON q.id = v.question_id
         JOIN questionnaire_cycles c ON c.id = v.cycle_id
         WHERE v.cycle_id = $1
         ORDER BY q.item_number, v.bu_code`,
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
           v.id, v.cycle_id, v.question_id, v.bu_code, v.status,
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

      const validation = validationResult.rows[0] as { question_id: number; bu_code: string | null };

      // Get only this BU's responses for this question+cycle
      const responsesResult = await query(
        `SELECT r.id, r.bu_code, r.material_risk, r.status, r.compliance_score, r.comments,
                r.responder_id, r.responder_name, r.submitted_at,
                r.return_comment, r.returned_at
         FROM responses r
         WHERE r.cycle_id = $1 AND r.question_id = $2 AND r.bu_code = $3
         ORDER BY r.material_risk NULLS FIRST`,
        [cycleId, validation.question_id, validation.bu_code]
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

// PUT /api/cycles/:cycleId/validations/:id — update validation (Validator or Senior Validator)
router.put(
  '/api/cycles/:cycleId/validations/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Validator' && role !== 'Senior Validator' && role !== 'Admin') {
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

      // Senior Validators cannot edit score, justification, or additional_controls — Validator only
      const isSeniorValidator = req.user?.role === 'Senior Validator';
      const scoreValue = isSeniorValidator ? null : (validation_score ?? null);
      const justificationValue = isSeniorValidator ? null : (justification ?? null);
      const additionalControlsValue = isSeniorValidator ? null : (additional_controls ?? null);

      const oldRow = await query<{ validation_score: number | null; justification: string | null }>(
        `SELECT validation_score, justification FROM validations WHERE id = $1 AND cycle_id = $2`,
        [id, cycleId]
      );
      const oldScore = oldRow.rows[0]?.validation_score ?? null;

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
          scoreValue,
          justificationValue,
          additionalControlsValue,
          req.user?.id ?? null,
        ]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Validation not found' });
        return;
      }
      logAudit({ action: 'validation_updated', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, old_score: oldScore, new_score: result.rows[0].validation_score ?? null, justification: justificationValue ?? null, additional_controls: additionalControlsValue ?? null } });
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
        res.status(409).json({ error: 'Validation already completed by another user.' });
        return;
      }
      logAudit({ action: 'validation_submitted_for_approval', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, new_score: result.rows[0].validation_score ?? null } });

      // Notify Senior Validators that a validation item is pending their approval
      const cycleRowV = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
      const cycleNameV = cycleRowV.rows[0]?.name ?? `Cycle ${cycleId}`;
      notifyRole('Senior Validator',
        `Validation item pending approval — ${cycleNameV}`,
        `Item #${result.rows[0].item_number} (${result.rows[0].bu_code}) in cycle "${cycleNameV}" has been submitted for your approval.`,
        parseInt(String(cycleId), 10),
        `/validation/${result.rows[0].id}`
      ).catch(() => {});

      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/validation-overview — items where ALL BU validations are pending_approval
router.get(
  '/api/cycles/:cycleId/validation-overview',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Senior Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId } = req.params;
      const result = await query(
        `WITH expected_bu AS (
           -- Required respondents per question come from ccl_item_weights (column K of CCL),
           -- not question_applicability — weights define who must respond.
           SELECT q.id AS question_id, COUNT(*) AS expected_count
           FROM questions q
           JOIN ccl_item_weights w ON w.item_number = q.item_number
           GROUP BY q.id
         ),
         submitted_responses AS (
           SELECT DISTINCT question_id, bu_code
           FROM responses
           WHERE cycle_id = $1 AND status = 'submitted'
         ),
         question_status AS (
           -- Questions where ALL weighted BUs have a submitted self-assessment
           -- AND every validation row is either pending_approval or closed (Validator finished, SV may or may not have approved)
           SELECT v.question_id
           FROM validations v
           JOIN expected_bu e  ON e.question_id = v.question_id
           JOIN questions q    ON q.id = v.question_id
           JOIN ccl_item_weights w  ON w.item_number = q.item_number AND w.bu_code = v.bu_code
           JOIN submitted_responses sr ON sr.question_id = v.question_id AND sr.bu_code = v.bu_code
           WHERE v.cycle_id = $1
           GROUP BY v.question_id, e.expected_count
           HAVING COUNT(*) = e.expected_count
              AND COUNT(*) FILTER (WHERE v.status NOT IN ('pending_approval', 'closed')) = 0
         ),
         bu_self_score AS (
           SELECT question_id, bu_code,
                  ROUND(SUM(compliance_score * COALESCE(weight, 1.0)) / NULLIF(SUM(COALESCE(weight, 1.0)), 0), 2)::float AS self_score
           FROM responses
           WHERE cycle_id = $1 AND status = 'submitted'
           GROUP BY question_id, bu_code
         ),
         consolidated AS (
           SELECT v.question_id,
                  ROUND(
                    SUM(v.validation_score * COALESCE(w.weight, 1.0))
                    / NULLIF(SUM(CASE WHEN v.validation_score IS NOT NULL THEN COALESCE(w.weight, 1.0) ELSE 0 END), 0)
                  , 2)::float AS consolidated_score
           FROM validations v
           JOIN questions q ON q.id = v.question_id
           LEFT JOIN ccl_item_weights w ON w.item_number = q.item_number AND w.bu_code = v.bu_code
           WHERE v.cycle_id = $1
           GROUP BY v.question_id
         )
         SELECT
           v.id                            AS validation_id,
           v.question_id,
           v.bu_code,
           v.status,
           v.validation_score,
           q.item_number,
           q.thematic_area,
           q.requirement,
           q.bcbs_principle_name,
           q.bcbs_principle_number,
           bs.self_score,
           COALESCE(w.weight, 1.0)::float  AS weight,
           ru.bu_name,
           c.consolidated_score
         FROM validations v
         JOIN question_status qs  ON qs.question_id = v.question_id
         JOIN questions q         ON q.id = v.question_id
         LEFT JOIN bu_self_score bs ON bs.question_id = v.question_id AND bs.bu_code = v.bu_code
         LEFT JOIN ccl_item_weights w ON w.item_number = q.item_number AND w.bu_code = v.bu_code
         LEFT JOIN respondent_units ru ON ru.bu_code = v.bu_code
         JOIN consolidated c       ON c.question_id = v.question_id
         WHERE v.cycle_id = $1
         ORDER BY q.item_number, v.bu_code`,
        [cycleId]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/questions/:questionId/approve — bulk-approve all BU validations for a question
router.put(
  '/api/cycles/:cycleId/questions/:questionId/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Senior Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, questionId } = req.params;
      const historyEntry = {
        action: 'approved',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        timestamp: new Date().toISOString(),
      };
      const result = await query<{ id: number; validation_score: number | null }>(
        `UPDATE validations
         SET
           status              = 'closed',
           senior_validated_by = $3,
           senior_validated_at = now(),
           updated_at          = now(),
           workflow_history    = workflow_history || $4::jsonb
         WHERE cycle_id = $1 AND question_id = $2 AND status = 'pending_approval'
         RETURNING id, validation_score`,
        [cycleId, questionId, req.user?.id ?? null, JSON.stringify([historyEntry])]
      );
      if (result.rows.length === 0) {
        res.status(400).json({ error: 'No pending_approval validations found for this question' });
        return;
      }
      logAudit({ action: 'validation_approved', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: result.rows.map(r => r.id).join(','), cycle_id: parseInt(String(cycleId), 10), details: { question_id: parseInt(String(questionId), 10), bulk: true, new_score: result.rows[0]?.validation_score ?? null } });

      // Auto-close cycle if all validations are now closed
      const remaining = await query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM validations WHERE cycle_id = $1 AND status <> 'closed'`,
        [cycleId]
      );
      if (parseInt(remaining.rows[0].cnt, 10) === 0) {
        await query(
          `UPDATE questionnaire_cycles SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1 AND status = 'distributed'`,
          [cycleId]
        );
        logAudit({ action: 'cycle_closed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(cycleId), cycle_id: parseInt(String(cycleId), 10), details: { reason: 'all_validations_approved' } });
      }

      res.json({ approved: result.rows.length });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/questions/:questionId/reject — bulk-reject all BU validations for a question
router.put(
  '/api/cycles/:cycleId/questions/:questionId/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Senior Validator' && role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, questionId } = req.params;
      const { rejection_comment: comment } = req.body as { rejection_comment?: string };
      const historyEntry = {
        action: 'rejected',
        actor_id: req.user?.id,
        actor_name: req.user?.display_name,
        actor_role: req.user?.role,
        timestamp: new Date().toISOString(),
        comment: comment ?? null,
      };
      const result = await query<{ id: number; item_number: number; bu_code: string; validation_score: number | null }>(
        `UPDATE validations
         SET
           status                   = 'rejected',
           senior_validated_by      = $3,
           senior_validated_at      = now(),
           senior_rejection_comment = $4,
           updated_at               = now(),
           workflow_history         = workflow_history || $5::jsonb
         WHERE cycle_id = $1 AND question_id = $2 AND status = 'pending_approval'
         RETURNING id, item_number, bu_code, validation_score`,
        [cycleId, questionId, req.user?.id ?? null, comment ?? null, JSON.stringify([historyEntry])]
      );
      if (result.rows.length === 0) {
        res.status(400).json({ error: 'No pending_approval validations found for this question' });
        return;
      }
      logAudit({ action: 'validation_rejected', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: result.rows.map(r => r.id).join(','), cycle_id: parseInt(String(cycleId), 10), details: { question_id: parseInt(String(questionId), 10), bulk: true, new_score: result.rows[0]?.validation_score ?? null, rejection_comment: comment ?? null } });

      // Notify Validators — send one notification per rejected validation so each links to its detail page
      const cycleRow = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
      const cycleName = cycleRow.rows[0]?.name ?? `Cycle ${cycleId}`;
      for (const row of result.rows) {
        notifyRole('Validator',
          `Validation item rejected — ${cycleName}`,
          `Item #${row.item_number} (${row.bu_code}) in cycle "${cycleName}" was rejected by the Senior Validator and requires revision.`,
          parseInt(String(cycleId), 10),
          `/validation/${row.id}`
        ).catch(() => {});
      }

      res.json({ rejected: result.rows.length });
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
      logAudit({ action: 'validation_approved', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, new_score: result.rows[0].validation_score ?? null } });

      // Auto-close cycle if all validations are now closed
      const remaining = await query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM validations WHERE cycle_id = $1 AND status <> 'closed'`,
        [cycleId]
      );
      if (parseInt(remaining.rows[0].cnt, 10) === 0) {
        await query(
          `UPDATE questionnaire_cycles SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1 AND status = 'distributed'`,
          [cycleId]
        );
        logAudit({ action: 'cycle_closed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'cycle', entity_id: String(cycleId), cycle_id: parseInt(String(cycleId), 10), details: { reason: 'all_validations_approved' } });
      }

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
      logAudit({ action: 'validation_rejected', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id: result.rows[0].question_id, new_score: result.rows[0].validation_score ?? null, rejection_comment: comment ?? null } });

      // Notify Validators that a validation item was rejected and needs revision
      const cycleRowR = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
      const cycleNameR = cycleRowR.rows[0]?.name ?? `Cycle ${cycleId}`;
      notifyRole('Validator',
        `Validation item rejected — ${cycleNameR}`,
        `Item #${result.rows[0].item_number} (${result.rows[0].bu_code}) in cycle "${cycleNameR}" was rejected by the Senior Validator and requires revision.`,
        parseInt(String(cycleId), 10),
        `/validation/${result.rows[0].id}`
      ).catch(() => {});

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

// POST /api/cycles/:cycleId/validations/:id/attachments — Validator or Senior Validator
router.post(
  '/api/cycles/:cycleId/validations/:id/attachments',
  valAttachUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Validator' && req.user?.role !== 'Senior Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    try {
      const { id, cycleId } = req.params;
      const metaResult = await query<{ question_id: number; bu_code: string | null; cycle_name: string | null; item_number: number | null }>(
        `SELECT v.question_id, v.bu_code, c.name AS cycle_name, q.item_number
         FROM validations v
         JOIN questionnaire_cycles c ON c.id = v.cycle_id
         JOIN questions q ON q.id = v.question_id
         WHERE v.id = $1 AND v.cycle_id = $2`,
        [id, cycleId]
      );
      const meta = metaResult.rows[0];
      const result = await query(
        `INSERT INTO validation_attachments (validation_id, file_name, file_path, uploaded_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.file.originalname, req.file.filename, req.user?.display_name ?? null]
      );
      logAudit({ action: 'validation_attachment_uploaded', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'validation', entity_id: String(id), cycle_id: parseInt(cycleId, 10), details: { file_name: req.file.originalname, question_id: meta?.question_id ?? null, bu_code: meta?.bu_code ?? null, item_number: meta?.item_number ?? null } });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/cycles/:cycleId/validations/:id/attachments/:attachId — Validator or Senior Validator
router.delete(
  '/api/cycles/:cycleId/validations/:id/attachments/:attachId',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Validator' && req.user?.role !== 'Senior Validator') {
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
