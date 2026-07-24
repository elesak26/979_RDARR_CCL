/**
 * Group-claim → role resolution for AD (Entra ID) login.
 *
 * The production plan drops the persona dropdown: the user signs in with their
 * bank AD account and the token carries a group, one group per role. This is the
 * identity → user mapping that was the last thing standing between UAT and
 * production — instead of every user having to pre-exist in the users table, the
 * directory states the role and we translate it.
 *
 * The mapping lives in the database (table group_role_mappings) and is managed
 * from the UI (Admin › Users), per Thanos's spec item 4 — not in configuration.
 * It is only consulted when AUTH_PROVIDER=entra; otherwise this module is inert
 * and the middleware falls back to the persona model, so DEV and QA are
 * unaffected until Entra login is switched on.
 *
 * Units are deliberately not resolved here yet — "θα το δούμε". When the unit
 * arrives (its own claim, a group naming convention, or a lookup) it slots into
 * buildAdUser below; nothing else changes.
 */
import { query } from '../db';
import { logger } from '../logger';

export const ROLE_VALUES = ['Admin', 'Senior Validator', 'Validator', 'Responder', 'Viewer'] as const;
type Role = (typeof ROLE_VALUES)[number];

export function isRole(v: string): v is Role {
  return (ROLE_VALUES as readonly string[]).includes(v);
}

/** The mapping is the auth model only under Entra login. In persona mode
 *  (DEV/QA) it stays inert and the middleware uses the dropdown. */
export function mappingActive(): boolean {
  return (process.env.AUTH_PROVIDER || '').trim().toLowerCase() === 'entra';
}

// ── DB-backed cache of ad_group(lower) → role ────────────────────────────────
// The auth middleware resolves a role on every request, so the mapping is cached
// in memory and only re-read from the database when it goes stale (TTL) or after
// a write invalidates it. A write (UI create/update/delete) calls
// invalidateGroupMappings(); everything else rides the cache.
const CACHE_TTL_MS = 30_000;
let _cache: Map<string, Role> = new Map();
let _loadedAt = 0;
let _dirty = true;
let _inflight: Promise<void> | null = null;

async function reload(): Promise<void> {
  const res = await query<{ ad_group: string; role: string }>(
    'SELECT ad_group, role FROM group_role_mappings'
  );
  const m = new Map<string, Role>();
  for (const row of res.rows) {
    if (isRole(row.role)) m.set(row.ad_group.toLowerCase(), row.role);
  }
  _cache = m;
  _loadedAt = Date.now();
  _dirty = false;
}

async function ensureFresh(): Promise<void> {
  if (!_dirty && Date.now() - _loadedAt < CACHE_TTL_MS) return;
  if (_inflight) return _inflight; // coalesce concurrent reloads
  _inflight = reload()
    .catch((err) => {
      // Keep serving the last good cache on a transient DB error rather than
      // failing every request; log and move on.
      logger.warn({ err }, 'groupRoles: failed to reload group_role_mappings');
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/** Called by the mapping-management routes after any create/update/delete so the
 *  next request re-reads the table instead of waiting out the TTL. */
export function invalidateGroupMappings(): void {
  _dirty = true;
}

/** Warm the cache at startup (best-effort). */
export async function preloadGroupMappings(): Promise<void> {
  if (!mappingActive()) return;
  await ensureFresh();
}

/** The claim names to look in, in order. Overridable via GROUP_CLAIM. Entra's
 *  defaults are `groups` (object-ids) and `roles` (app roles). */
function groupClaimNames(): string[] {
  const override = process.env.GROUP_CLAIM?.trim();
  return override ? [override] : ['groups', 'roles'];
}

/** Pull the group list out of the verified claims, wherever it lives. */
export function groupsFromClaims(claims: Record<string, unknown>): string[] {
  for (const name of groupClaimNames()) {
    const v = claims[name];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string' && v) return [v]; // some IdPs send a single group as a string
  }
  return [];
}

/**
 * Global-admin allowlist: emails that get Admin access without belonging to any
 * group. These are the users the directory does not place in the role groups —
 * a handful of global administrators, and a break-glass path for the window
 * before the groups are fully provisioned. Provided in GLOBAL_ADMIN_EMAILS,
 * separated by comma / semicolon / whitespace. Inert when unset.
 */
let _adminEmails: Set<string> | null | undefined;

function globalAdminEmails(): Set<string> | null {
  if (_adminEmails !== undefined) return _adminEmails;
  const raw = process.env.GLOBAL_ADMIN_EMAILS?.trim();
  if (!raw) {
    _adminEmails = null;
    return _adminEmails;
  }
  const set = new Set(
    raw
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  _adminEmails = set.size ? set : null;
  return _adminEmails;
}

/** The email-like claims to match against the allowlist, in order. */
function emailsFromClaims(claims: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['email', 'preferred_username', 'upn', 'unique_name']) {
    const v = claims[k];
    if (typeof v === 'string' && v.includes('@')) out.push(v.toLowerCase());
  }
  return out;
}

/** True when the authenticated identity is on the global-admin allowlist. */
export function isGlobalAdmin(claims: Record<string, unknown>): boolean {
  const allow = globalAdminEmails();
  if (!allow) return false;
  return emailsFromClaims(claims).some((e) => allow.has(e));
}

export interface ResolvedRole {
  role: Role;
  matchedGroup: string;
  groups: string[];
}

/**
 * The outcome of resolving a token's groups against the map.
 *  - 'inert'    : no map configured — the caller falls back to the persona model
 *  - 'none'     : map configured, but none of the user's groups are mapped
 *  - 'one'      : exactly one mapped group — the only valid case, carries the role
 *  - 'multiple' : more than one mapped group — blocked (see below)
 *
 * Per the identity spec (Thanos, "Issues - Pending Items" item 5) a user must
 * belong to EXACTLY ONE mapped group. Multi-role is not allowed, so we
 * deliberately do NOT pick a "strongest" role when several match — a user in two
 * role groups is blocked and told to have all but one removed. Silently choosing
 * one would hand someone a role the directory never unambiguously granted.
 */
export type GroupResolution =
  | { kind: 'inert' }
  | { kind: 'none'; groups: string[] }
  | { kind: 'one'; role: Role; matchedGroup: string; groups: string[] }
  | { kind: 'multiple'; matched: { group: string; role: Role }[]; groups: string[] };

export async function resolveGroupRole(claims: Record<string, unknown>): Promise<GroupResolution> {
  if (!mappingActive()) return { kind: 'inert' };
  await ensureFresh();
  const groups = groupsFromClaims(claims);
  const matched: { group: string; role: Role }[] = [];
  for (const g of groups) {
    const role = _cache.get(g.toLowerCase());
    if (role) matched.push({ group: g, role });
  }
  if (matched.length === 0) return { kind: 'none', groups };
  if (matched.length === 1) return { kind: 'one', role: matched[0].role, matchedGroup: matched[0].group, groups };
  return { kind: 'multiple', matched, groups };
}

export interface AdUser {
  id: string;
  display_name: string;
  role: string;
  unit_codes: string[];
  primary_unit_code: string | null;
  is_active: boolean;
}

/**
 * Build the acting user from the verified token and its resolved role. The id is
 * the AD subject (stable per user), the name comes from the human-readable
 * claims, and units are empty for now — the piece the identity team is still
 * defining. No database row is required: the directory is the source of truth.
 */
export function buildAdUser(claims: Record<string, unknown>, resolved: ResolvedRole): AdUser {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const displayName =
    str(claims.name) ||
    str(claims.preferred_username) ||
    str(claims.upn) ||
    str(claims.email) ||
    str(claims.sub) ||
    'Unknown';
  return {
    id: String(claims.sub ?? claims.oid ?? displayName),
    display_name: displayName,
    role: resolved.role,
    unit_codes: [],
    primary_unit_code: null,
    is_active: true,
  };
}
