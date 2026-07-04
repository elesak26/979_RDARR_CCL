import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';

const router = Router();

// GET /api/questions — list all questions, optional ?thematic_area= filter
router.get('/api/questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { thematic_area } = req.query as { thematic_area?: string };
    let sql =
      `SELECT id, item_number, thematic_area, requirement, bcbs_principle_number, bcbs_principle_name,
              ecb_reference, respondents_hint
       FROM questions`;
    const params: unknown[] = [];

    if (thematic_area) {
      sql += ' WHERE thematic_area LIKE $1';
      params.push(`%${thematic_area}%`);
    }

    sql += ' ORDER BY item_number';

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/questions/:id — get one question with full text
router.get('/api/questions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT id, item_number, thematic_area, requirement, bcbs_principle_number, bcbs_principle_name,
              ecb_reference, expectations, score_1_desc, score_2_desc, score_3_desc, score_4_desc,
              respondents_hint, supportive_material, related_kpis
       FROM questions
       WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Question not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
