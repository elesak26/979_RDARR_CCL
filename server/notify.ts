import { query } from './db';

export async function notifyRole(
  role: string,
  title: string,
  body: string,
  cycleId: number,
): Promise<void> {
  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = $1 AND is_active = true`,
    [role]
  );
  for (const user of users.rows) {
    await query(
      `INSERT INTO notifications (user_id, title, body, cycle_id) VALUES ($1, $2, $3, $4)`,
      [user.id, title, body, cycleId]
    );
  }
}
