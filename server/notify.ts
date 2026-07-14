import { query } from './db';

export async function notifyRole(
  role: string,
  title: string,
  body: string,
  cycleId: number,
  link?: string,
): Promise<void> {
  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = $1 AND is_active = true`,
    [role]
  );
  for (const user of users.rows) {
    await query(
      `INSERT INTO notifications (user_id, title, body, cycle_id, link) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, title, body, cycleId, link ?? null]
    );
  }
}

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  cycleId: number,
  link?: string,
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, title, body, cycle_id, link) VALUES ($1, $2, $3, $4, $5)`,
    [userId, title, body, cycleId, link ?? null]
  );
}

export async function notifyBuResponders(
  buCode: string,
  cycleId: number,
  title: string,
  body: string,
  link?: string,
): Promise<void> {
  const users = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'Responder' AND is_active = true AND unit_codes ? $1`,
    [buCode]
  );
  for (const user of users.rows) {
    await query(
      `INSERT INTO notifications (user_id, title, body, cycle_id, link) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, title, body, cycleId, link ?? null]
    );
  }
}
