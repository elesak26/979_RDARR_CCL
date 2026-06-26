import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';

const router = Router();

// GET /api/notifications — unread + recent read notifications for the current user
router.get('/api/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const result = await query(
      `SELECT id, title, body, cycle_id, link, is_read, created_at
       FROM notifications
       WHERE user_id = $1 AND is_read = false
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/:id/read — mark one notification as read
router.put('/api/notifications/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await query(
      `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/read-all — mark all as read for the current user
router.put('/api/notifications/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    await query(
      `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
