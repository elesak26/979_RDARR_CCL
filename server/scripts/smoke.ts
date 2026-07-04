/**
 * Minimal smoke test for the Azure SQL migration. Assumes the server is already
 * running (DISABLE_LOGIN=true) at $SMOKE_BASE (default http://localhost:3011).
 * Exercises a read endpoint, a write endpoint, and a Greek round-trip verified
 * both through the API and directly at the database.
 *
 * Run:  SMOKE_BASE=http://localhost:3011 tsx scripts/smoke.ts
 */
import { query, pool } from '../db';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3011';
const ADMIN = { 'x-user-id': 'admin-1', 'content-type': 'application/json' };
const GREEK = 'Κύκλος Ελληνικά ΑΒΓ Παπαδόπουλος 2026';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error('SMOKE FAIL: ' + msg);
  console.log('  ok - ' + msg);
}

async function main() {
  // 1. read: health
  const h = await fetch(`${BASE}/api/health`).then((r) => r.json() as Promise<{ ok?: boolean }>);
  assert(h.ok === true, 'GET /api/health returns ok');

  // 2. read: questions (seeded = 40)
  const qs = await fetch(`${BASE}/api/questions`, { headers: ADMIN }).then((r) => r.json() as Promise<unknown[]>);
  assert(Array.isArray(qs) && qs.length === 40, `GET /api/questions returns 40 seeded rows (got ${Array.isArray(qs) ? qs.length : 'n/a'})`);

  // 2b. read: users (unit_codes must come back as a real array, not a JSON string)
  const users = await fetch(`${BASE}/api/users`, { headers: ADMIN }).then((r) => r.json() as Promise<Array<{ unit_codes: unknown }>>);
  const admin = users.find((u) => Array.isArray(u.unit_codes));
  assert(admin !== undefined, 'GET /api/users returns unit_codes as arrays (JSON parsed)');

  // 3. write + Greek round-trip: create a cycle with a Greek name
  const created = await fetch(`${BASE}/api/cycles`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify({ name: GREEK, year: 2026, description: 'Δοκιμή' }),
  }).then((r) => r.json() as Promise<{ id?: number; name?: string }>);
  assert(created.id != null, 'POST /api/cycles created a cycle');
  assert(created.name === GREEK, `write response preserves Greek (got: ${created.name})`);

  // 3b. read it back through the API
  const readBack = await fetch(`${BASE}/api/cycles/${created.id}`, { headers: ADMIN }).then((r) => r.json() as Promise<{ name?: string }>);
  assert(readBack.name === GREEK, `GET /api/cycles/:id reads Greek back intact (got: ${readBack.name})`);

  // 3c. verify at the DB that it is stored as real Unicode, not '?'
  const dbRow = await query<{ name: string }>('SELECT name FROM questionnaire_cycles WHERE id = $1', [created.id]);
  const dbName = dbRow.rows[0]?.name;
  assert(dbName === GREEK, `DB stores Greek exactly (got: ${dbName})`);
  assert(!/\?/.test(dbName ?? '?'), 'DB value contains no "?" replacement chars');

  // 4. cleanup: delete the draft cycle so the smoke test leaves no residue
  const del = await fetch(`${BASE}/api/cycles/${created.id}`, { method: 'DELETE', headers: ADMIN });
  assert(del.ok, 'DELETE /api/cycles/:id cleaned up the test cycle');

  console.log('\nSMOKE PASS');
  await pool.end();
}

main().catch(async (e) => {
  console.error(e.message || e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
