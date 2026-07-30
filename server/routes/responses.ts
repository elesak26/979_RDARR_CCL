import { Router, Request, Response, NextFunction } from 'express';
import { query, pool } from '../db';
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

      const result = await query<{ id: number; question_id: number; bu_code: string; material_risk: string | null; status: string; compliance_score: number | null }>(
        `UPDATE responses
         SET status = 'submitted', submitted_at = NOW(), updated_at = NOW(),
             responder_id = COALESCE(responder_id, $3),
             responder_name = COALESCE(responder_name, $4)
         WHERE id = $1 AND cycle_id = $2 AND status IN ('draft', 'in_progress', 'returned')
         RETURNING id, question_id, bu_code, material_risk, status, compliance_score`,
        [id, cycleId, req.user.id, req.user.display_name]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Response not found or not in a submittable status' });
        return;
      }

      const { question_id, bu_code, material_risk } = result.rows[0];

      // Each submitted (respondent × item × material_risk) gets its own validation row immediately.
      await query(
        `INSERT INTO validations (cycle_id, question_id, bu_code, material_risk, status)
         VALUES ($1, $2, $3, $4, 'in_review')
         ON CONFLICT (cycle_id, question_id, bu_code, material_risk)
           DO UPDATE SET status = 'in_review', updated_at = NOW()
           WHERE validations.status NOT IN ('closed', 'pending_approval')`,
        [cycleId, question_id, bu_code, material_risk ?? null]
      );

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

// POST /api/cycles/:cycleId/responses/submit-all — atomically save+submit all pending responses (Responder)
router.post(
  '/api/cycles/:cycleId/responses/submit-all',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Responder') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { cycleId } = req.params;
      const { items } = req.body as {
        items: Array<{ id: number; compliance_score: number | null; comments: string | null }>;
      };

      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'No items provided' });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Save scores/comments and mark submitted in one pass per item
        const submittedRows: Array<{ id: number; question_id: number; bu_code: string; material_risk: string | null }> = [];
        for (const item of items) {
          const r = await client.query<{ id: number; question_id: number; bu_code: string; material_risk: string | null }>(
            `UPDATE responses
             SET compliance_score = $3,
                 comments         = $4,
                 status           = 'submitted',
                 submitted_at     = NOW(),
                 updated_at       = NOW(),
                 responder_id     = COALESCE(responder_id, $5),
                 responder_name   = COALESCE(responder_name, $6)
             WHERE id = $1 AND cycle_id = $2 AND status IN ('draft', 'in_progress', 'returned')
             RETURNING id, question_id, bu_code, material_risk`,
            [item.id, cycleId, item.compliance_score ?? null, item.comments ?? null, req.user!.id, req.user!.display_name]
          );
          if (r.rows.length) submittedRows.push(r.rows[0]);
        }

        if (submittedRows.length === 0) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'No responses were in a submittable status' });
          return;
        }

        // Each submitted (respondent × item × material_risk) gets its own validation row immediately.
        for (const { question_id, bu_code, material_risk } of submittedRows) {
          await client.query(
            `INSERT INTO validations (cycle_id, question_id, bu_code, material_risk, status)
             VALUES ($1, $2, $3, $4, 'in_review')
             ON CONFLICT (cycle_id, question_id, bu_code, material_risk)
               DO UPDATE SET status = 'in_review', updated_at = NOW()
               WHERE validations.status NOT IN ('closed', 'pending_approval')`,
            [cycleId, question_id, bu_code, material_risk ?? null]
          );
        }

        const buCodes = [...new Set(submittedRows.map(r => r.bu_code))];

        await client.query('COMMIT');

        // Audit + single notification (fire-and-forget)
        logAudit({
          action: 'response_submitted',
          actor_id: req.user!.id,
          actor_name: req.user!.display_name,
          actor_role: req.user!.role,
          entity_type: 'cycle',
          entity_id: String(cycleId),
          cycle_id: parseInt(String(cycleId), 10),
          details: { submitted_count: submittedRows.length, bu_codes: buCodes },
        });

        const cycleRow = await query<{ name: string }>(`SELECT name FROM questionnaire_cycles WHERE id = $1`, [cycleId]);
        const cycleName = cycleRow.rows[0]?.name ?? `Cycle ${cycleId}`;
        notifyRole(
          'Validator',
          `New validation items ready — ${cycleName}`,
          `${buCodes.join(', ')} submitted ${submittedRows.length} item${submittedRows.length !== 1 ? 's' : ''} for your validation in cycle "${cycleName}".`,
          parseInt(String(cycleId), 10),
          `/validation`
        ).catch(() => {});

        res.json({ submitted: submittedRows.length });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
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

      const result = await query<{ id: number; question_id: number; bu_code: string; material_risk: string | null; status: string }>(
        `UPDATE responses
         SET status = 'returned', return_comment = $3, returned_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND cycle_id = $2 AND status = 'submitted'
         RETURNING id, question_id, bu_code, material_risk, status`,
        [id, cycleId, return_comment ?? null]
      );

      if (result.rows.length === 0) {
        res.status(400).json({ error: 'Response not found or not in submitted status' });
        return;
      }

      const { question_id, bu_code, material_risk } = result.rows[0];

      await query(
        `UPDATE validations
         SET status = 'returned', updated_at = NOW()
         WHERE cycle_id = $1 AND question_id = $2 AND bu_code = $3
           AND material_risk IS NOT DISTINCT FROM $4 AND status = 'in_review'`,
        [cycleId, question_id, bu_code, material_risk ?? null]
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
