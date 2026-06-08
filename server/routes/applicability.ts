import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { logAudit } from '../audit';

const router = Router({ mergeParams: true });

// GET /api/cycles/:cycleId/applicability
router.get(
  '/api/cycles/:cycleId/applicability',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId } = req.params;
      const result = await query(
        `SELECT
           qa.id, qa.cycle_id, qa.question_id, qa.bu_code, qa.bu_name,
           qa.assigned_by, qa.assigned_at,
           q.item_number, q.thematic_area, q.requirement,
           q.bcbs_principle_number, q.bcbs_principle_name
         FROM question_applicability qa
         JOIN questions q ON q.id = qa.question_id
         WHERE qa.cycle_id = $1
         ORDER BY q.item_number, qa.bu_code`,
        [cycleId]
      );
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/cycles/:cycleId/applicability — assign a BU to a question (Admin/Validator)
router.post(
  '/api/cycles/:cycleId/applicability',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Admin' && role !== 'Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId } = req.params;
      const { question_id, bu_code, bu_name } = req.body as {
        question_id: number;
        bu_code: string;
        bu_name: string;
      };

      if (!question_id || !bu_code || !bu_name) {
        res.status(400).json({ error: 'question_id, bu_code, and bu_name are required' });
        return;
      }

      const result = await query(
        `INSERT INTO question_applicability (cycle_id, question_id, bu_code, bu_name, assigned_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cycle_id, question_id, bu_code) DO UPDATE
           SET bu_name = EXCLUDED.bu_name, assigned_by = EXCLUDED.assigned_by, assigned_at = now()
         RETURNING *`,
        [cycleId, question_id, bu_code, bu_name, req.user?.id ?? null]
      );
      logAudit({ action: 'applicability_assigned', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'applicability', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { question_id, bu_code, bu_name } });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/cycles/:cycleId/applicability/:id — remove assignment (Admin/Validator, only if cycle is draft/published)
router.delete(
  '/api/cycles/:cycleId/applicability/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (role !== 'Admin' && role !== 'Validator') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;

      // Check cycle status
      const cycleResult = await query<{ status: string }>(
        `SELECT status FROM questionnaire_cycles WHERE id = $1`,
        [cycleId]
      );
      if (cycleResult.rows.length === 0) {
        res.status(404).json({ error: 'Cycle not found' });
        return;
      }
      const cycleStatus = cycleResult.rows[0].status;
      if (cycleStatus !== 'draft' && cycleStatus !== 'published') {
        res.status(400).json({ error: 'Applicability can only be modified for draft or published cycles' });
        return;
      }

      const result = await query(
        `DELETE FROM question_applicability WHERE id = $1 AND cycle_id = $2 RETURNING id`,
        [id, cycleId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Applicability entry not found' });
        return;
      }
      logAudit({ action: 'applicability_removed', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'applicability', entity_id: String(id), cycle_id: parseInt(String(cycleId), 10), details: {} });
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
