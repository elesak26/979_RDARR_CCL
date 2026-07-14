import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import { logAudit } from '../audit';
import { notifyRole, notifyBuResponders } from '../notify';

const router = Router();

// GET /api/cycles/:cycleId/responses — list responses, optional ?bu_code= filter
router.get(
  '/api/cycles/:cycleId/responses',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId } = req.params;
      const { bu_code } = req.query as { bu_code?: string };

      let sql = `
        SELECT r.*, q.item_number, q.thematic_area, q.requirement,
               q.bcbs_principle_number, q.bcbs_principle_name,
               q.expectations,
               q.score_1_desc, q.score_2_desc, q.score_3_desc, q.score_4_desc
        FROM responses r
        JOIN questions q ON q.id = r.question_id
        JOIN questionnaire_cycles c ON c.id = r.cycle_id
        WHERE r.cycle_id = $1
          AND (c.status <> 'closed' OR r.status = 'submitted')`;
      const params: unknown[] = [cycleId];

      if (bu_code) {
        const codes = req.user?.unit_codes?.length ? req.user.unit_codes : [bu_code];
        sql += ` AND r.bu_code = ANY($2::text[])`;
        params.push(codes);
      }

      sql += ' ORDER BY q.item_number, r.bu_code, r.material_risk';

      const result = await query(sql, params);
      res.json(result.rows);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/cycles/:cycleId/responses/:id — get one response
router.get(
  '/api/cycles/:cycleId/responses/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId, id } = req.params;
      const result = await query(
        `SELECT r.*, q.item_number, q.thematic_area, q.requirement,
                q.expectations, q.score_1_desc, q.score_2_desc, q.score_3_desc, q.score_4_desc,
                q.respondents_hint, q.supportive_material, q.material_risk AS question_material_risk
         FROM responses r
         JOIN questions q ON q.id = r.question_id
         WHERE r.id = $1 AND r.cycle_id = $2`,
        [id, cycleId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Response not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/responses/:id — update response (Responder, only if status=draft)
router.put(
  '/api/cycles/:cycleId/responses/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Responder') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;
      const { compliance_score, comments } = req.body as {
        compliance_score?: number;
        comments?: string;
      };

      const oldRow = await query<{ compliance_score: number | null; comments: string | null }>(
        `SELECT compliance_score, comments FROM responses WHERE id = $1 AND cycle_id = $2`,
        [id, cycleId]
      );
      const oldScore = oldRow.rows[0]?.compliance_score ?? null;

      const result = await query(
        `UPDATE responses
         SET
           compliance_score = COALESCE($3, compliance_score),
           comments         = COALESCE($4, comments),
           responder_id     = $5,
           responder_name   = $6,
           status           = CASE WHEN status = 'draft' THEN 'in_progress' ELSE status END,
           updated_at       = NOW()
         WHERE id = $1 AND cycle_id = $2 AND status IN ('draft', 'in_progress', 'returned')
         RETURNING *`,
        [id, cycleId, compliance_score ?? null, comments ?? null, req.user.id, req.user.display_name]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Response not found or not editable' });
        return;
      }
      logAudit({ action: 'response_saved', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'response', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { bu_code: result.rows[0].bu_code, question_id: result.rows[0].question_id, status: result.rows[0].status, old_score: oldScore, new_score: result.rows[0].compliance_score ?? null, comments: comments ?? null } });
      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/responses/:id/submit — submit response (Responder)
router.put(
  '/api/cycles/:cycleId/responses/:id/submit',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Responder') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;

      const result = await query<{ id: number; question_id: number; bu_code: string; status: string; compliance_score: number | null }>(
        `UPDATE responses
         SET status = 'submitted', submitted_at = NOW(), updated_at = NOW(),
             responder_id = COALESCE(responder_id, $3),
             responder_name = COALESCE(responder_name, $4)
         WHERE id = $1 AND cycle_id = $2 AND status IN ('draft', 'in_progress', 'returned')
         RETURNING id, question_id, bu_code, status, compliance_score`,
        [id, cycleId, req.user.id, req.user.display_name]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Response not found or not in a submittable status' });
        return;
      }

      const { question_id, bu_code } = result.rows[0];

      const buProgress = await query<{ total: string; submitted: string }>(
        `SELECT
           COUNT(*)                                            AS total,
           COUNT(CASE WHEN status = 'submitted' THEN 1 END)   AS submitted
         FROM responses
         WHERE cycle_id = $1 AND bu_code = $2`,
        [cycleId, bu_code]
      );

      const { total: buTotal, submitted: buSubmitted } = buProgress.rows[0];
      if (buTotal === buSubmitted && parseInt(buTotal, 10) > 0) {
        const buQuestions = await query<{ question_id: number }>(
          `SELECT DISTINCT question_id FROM responses
           WHERE cycle_id = $1 AND bu_code = $2 AND status = 'submitted'`,
          [cycleId, bu_code]
        );
        for (const { question_id: qid } of buQuestions.rows) {
          await query(
            `INSERT INTO validations (cycle_id, question_id, bu_code, status)
             VALUES ($1, $2, $3, 'in_review')
             ON CONFLICT (cycle_id, question_id, bu_code)
               DO UPDATE SET status = 'in_review', updated_at = NOW()
               WHERE validations.status NOT IN ('closed', 'pending_approval')`,
            [cycleId, qid, bu_code]
          );
        }
      } else {
        await query(
          `INSERT INTO validations (cycle_id, question_id, bu_code, status)
           VALUES ($1, $2, $3, 'in_review')
           ON CONFLICT (cycle_id, question_id, bu_code)
             DO UPDATE SET status = 'in_review', updated_at = NOW()
             WHERE validations.status NOT IN ('closed', 'pending_approval')`,
          [cycleId, question_id, bu_code]
        );
      }

      logAudit({ action: 'response_submitted', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'response', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { bu_code: result.rows[0].bu_code, question_id: result.rows[0].question_id, new_score: result.rows[0].compliance_score ?? null } });

      const cycleRow = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
      const cycleName = cycleRow.rows[0]?.name ?? `Cycle ${cycleId}`;
      notifyRole('Validator',
        `New validation items ready — ${cycleName}`,
        `Items submitted by ${bu_code} are now ready for your validation in cycle "${cycleName}".`,
        parseInt(String(cycleId), 10),
        `/validation`
      ).catch(() => {});

      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/cycles/:cycleId/responses/:id/return — return response to draft (Validator)
router.put(
  '/api/cycles/:cycleId/responses/:id/return',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Validator' && req.user?.role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId, id } = req.params;
      const { return_comment } = req.body as { return_comment?: string };

      const result = await query<{ id: number; question_id: number; bu_code: string; status: string }>(
        `UPDATE responses
         SET status = 'returned', return_comment = $3, returned_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND cycle_id = $2 AND status = 'submitted'
         RETURNING id, question_id, bu_code, status`,
        [id, cycleId, return_comment ?? null]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Response not found or not in submitted status' });
        return;
      }

      const { question_id, bu_code } = result.rows[0];

      await query(
        `UPDATE validations
         SET status = 'returned', updated_at = NOW()
         WHERE cycle_id = $1 AND question_id = $2 AND bu_code = $3 AND status = 'in_review'`,
        [cycleId, question_id, bu_code]
      );

      logAudit({ action: 'response_returned', actor_id: req.user?.id, actor_name: req.user?.display_name, actor_role: req.user?.role, entity_type: 'response', entity_id: String(result.rows[0].id), cycle_id: parseInt(String(cycleId), 10), details: { bu_code: result.rows[0].bu_code, question_id: result.rows[0].question_id, return_comment: return_comment ?? null } });

      const cycleRowR = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
      const cycleNameR = cycleRowR.rows[0]?.name ?? `Cycle ${cycleId}`;
      notifyBuResponders(bu_code, parseInt(String(cycleId), 10),
        `Response returned for revision — ${cycleNameR}`,
        `A response for question #${question_id} in cycle "${cycleNameR}" has been returned to you for revision.`,
        `/assignments/${result.rows[0].id}`
      ).catch(() => {});

      res.json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
