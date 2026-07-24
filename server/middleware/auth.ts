import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, importJWK, type JWTPayload, type JWK } from 'jose';
import { query } from '../db';
import { logger } from '../logger';
import { decryptTokens, getSessionChunks, clearSessionCookies } from '../lib/tokenEncryption';
import { DISABLE_LOGIN, UAT_PERSONA_MODE, PERSONA_HEADER_ALLOWED } from '../lib/appEnv';
import { resolveGroupRole, buildAdUser, isGlobalAdmin, type ResolvedRole } from '../lib/groupRoles';

export interface AuthUser {
  id: string;
  display_name: string;
  role: string;
  unit_codes: string[];
  primary_unit_code: string | null;
  is_active: boolean;
  // True only for identities admitted via the global-admin email allowlist (env).
  // A business user who holds the Admin ROLE through a group does NOT get this —
  // it gates the group→role mapping management, which is a meta-permission.
  is_global_admin?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ── User resolution (shared by the dev-bypass and production branches) ────────
type UserRow = Omit<AuthUser, 'unit_codes'> & { unit_codes: unknown };

/** unit_codes is stored as a JSON array (nvarchar) in Azure SQL — parse it back
 *  to string[] so AuthUser (and downstream authz) sees a real array. */
function normalizeUser(row: UserRow | undefined): AuthUser | null {
  if (!row) return null;
  const uc = row.unit_codes;
  const unit_codes: string[] = Array.isArray(uc) ? uc : typeof uc === 'string' ? JSON.parse(uc) : [];
  return { ...row, unit_codes };
}

async function resolveUser(id: string): Promise<AuthUser | null> {
  const result = await query<UserRow>(
    'SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE id = $1',
    [id]
  );
  return normalizeUser(result.rows[0]);
}

async function firstAdmin(): Promise<AuthUser | null> {
  const result = await query<UserRow>(
    "SELECT id, display_name, role, unit_codes, primary_unit_code, is_active FROM users WHERE role = 'Admin' AND is_active = true LIMIT 1"
  );
  return normalizeUser(result.rows[0]);
}

async function recordLogin(req: Request, user: AuthUser): Promise<void> {
  // Only record once per session to avoid per-request noise — skip for health/static
  if (req.path === '/health') return;
  try {
    await query(
      `INSERT INTO login_history (user_id, display_name, role, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, user.display_name, user.role, req.ip ?? null, req.headers['user-agent'] ?? null]
    );
  } catch (err) {
    logger.warn({ err }, 'authMiddleware: failed to record login history');
  }
}

// ── OIDC token verification (production) ──────────────────────────────────────
// The NBG core is publicly reachable, so we JWKS-VERIFY the token's signature in
// the backend (never decode-only) — a forged / `alg:none` token must be rejected
// even if it reaches the Core directly, bypassing the compliance proxy. Same
// posture as EWS/pf-editor. The verifiable JWT is the id_token (the NBG
// access_token is opaque), forwarded by the UI as `X-Id-Token`; we fall back to
// a JWT Authorization Bearer.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!_jwks) {
    const jwksUri = process.env.OAUTH_JWKS_URI;
    if (!jwksUri) throw new Error('OAUTH_JWKS_URI is required when DISABLE_LOGIN is not true');
    _jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  return _jwks;
}

// Cache the fetched JWKS keys (3-hour TTL) for the multi-key fallback path.
let _jwksKeysCache: { keys: JWK[]; fetchedAt: number } | null = null;
async function fetchJwksKeys(): Promise<JWK[]> {
  const jwksUri = process.env.OAUTH_JWKS_URI;
  if (!jwksUri) throw new Error('OAUTH_JWKS_URI not set');
  if (_jwksKeysCache && Date.now() - _jwksKeysCache.fetchedAt < 3 * 60 * 60 * 1000) return _jwksKeysCache.keys;
  const r = await fetch(jwksUri);
  if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
  const body = (await r.json()) as { keys?: JWK[] };
  if (!body.keys || body.keys.length === 0) throw new Error('JWKS returned no keys');
  _jwksKeysCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/** Verify a JWT against the NBG IdP JWKS, enforcing the issuer. Handles the
 *  "multiple matching keys" case IdentityServer produces (>1 RS256 key, JWT
 *  header has no kid) by fetching the keys and trying each until one verifies.
 *  Throws on invalid signature / expiry / issuer mismatch. */
async function verifyToken(token: string): Promise<JWTPayload> {
  const opts: { issuer?: string } = {};
  if (process.env.OAUTH_ISSUER) opts.issuer = process.env.OAUTH_ISSUER;
  try {
    const { payload } = await jwtVerify(token, getJWKS(), opts);
    return payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/multiple matching keys/i.test(msg)) throw err;
    const header = decodeProtectedHeader(token);
    const keys = await fetchJwksKeys();
    const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
    const useKeys = candidates.length ? candidates : keys;
    let lastErr: unknown = err;
    for (const jwk of useKeys) {
      try {
        const key = await importJWK(jwk, header.alg ?? 'RS256');
        const { payload } = await jwtVerify(token, key, opts);
        return payload;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice('Bearer '.length) : null;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (DISABLE_LOGIN) {
    // Dev/UAT bypass: no token required. Persona from X-User-Id, default first admin.
    const userId = req.headers['x-user-id'] as string | undefined;
    if (userId) {
      try {
        const user = await resolveUser(userId);
        if (user && user.is_active !== false) {
          req.user = user;
          recordLogin(req, user).catch(() => {});
          return next();
        }
      } catch (err) {
        logger.warn({ err }, 'authMiddleware: failed to fetch user');
      }
    }
    try {
      const adminUser = await firstAdmin();
      if (adminUser) {
        req.user = adminUser;
        recordLogin(req, adminUser).catch(() => {});
        return next();
      }
    } catch (err) {
      logger.warn({ err }, 'authMiddleware: fallback user fetch failed');
    }
    // No users yet (pre-seed) — allow through with a placeholder.
    req.user = { id: 'system', display_name: 'System', role: 'Admin', unit_codes: [], primary_unit_code: null, is_active: true };
    return next();
  }

  // Production: require a signature-verified OIDC token, THEN resolve the persona.
  // The id_token (a JWT) is forwarded by the UI as X-Id-Token (the NBG access_token
  // is opaque); fall back to a JWT Authorization Bearer. Role/unit still come from
  // the selected persona (X-User-Id → DB), matching RDARR's UAT dropdown model.
  // The session is the primary source: tokens live in an encrypted httpOnly
  // cookie set by /auth/exchange, so the browser neither holds nor manages them.
  // The X-Id-Token / Bearer headers remain accepted as a fallback so a tab still
  // running the previous UI build keeps working through a rollout, and so
  // server-to-server callers are unaffected.
  const session = decryptTokens(getSessionChunks(req.cookies));
  if (session && session.expiresAt < Date.now()) {
    // Expired session: clear it so the SPA sees a clean "not signed in" state
    // instead of retrying with a cookie that can never succeed.
    clearSessionCookies(res);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token =
    session?.idToken ||
    (req.headers['x-id-token'] as string | undefined) ||
    bearerToken(req) ||
    undefined;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  let claims: JWTPayload;
  try {
    claims = await verifyToken(token);
  } catch (err) {
    logger.warn({ err }, 'authMiddleware: token verification failed');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // X-User-Id is the persona dropdown's transport, so it is honoured only while a
  // persona mode is on. With both flags off — the production posture — the acting
  // user comes from the verified token alone and the header cannot grant a role
  // its bearer was not assigned. This is the header the security review asked
  // about; turning the persona modes off has to actually turn the personas off.
  const personaId =
    (PERSONA_HEADER_ALLOWED ? (req.headers['x-user-id'] as string | undefined) : undefined) ||
    (claims.sub ? String(claims.sub) : undefined);
  if (personaId) {
    try {
      const user = await resolveUser(personaId);
      if (user) {
        if (user.is_active === false) {
          res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
          return;
        }
        req.user = user;
        recordLogin(req, user).catch(() => {});
        return next();
      }
    } catch (err) {
      logger.warn({ err }, 'authMiddleware: persona lookup failed');
    }
  }
  // AD (Entra) login: the role comes from a group in the verified token, one
  // group per role. This is the production path — the directory states what the
  // user is, so no pre-existing users row is required and the persona dropdown is
  // gone. Inert until the group map is configured, so DEV and QA keep using the
  // dropdown above and nothing changes for them.
  const claimsObj = claims as Record<string, unknown>;

  // Helper: resolve/attach the acting user for a role decided outside the DB.
  const admitAs = async (resolved: ResolvedRole, globalAdmin = false): Promise<boolean> => {
    const adUser = buildAdUser(claimsObj, resolved);
    // A users row for this subject, if one exists, wins — it lets an admin pin a
    // display name or deactivate an account. Absent (the normal AD case) we act
    // on the directory alone.
    let user: AuthUser | null = null;
    try {
      user = await resolveUser(adUser.id);
    } catch (err) {
      logger.warn({ err }, 'authMiddleware: users lookup for AD subject failed');
    }
    if (user?.is_active === false) {
      res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
      return true; // handled (rejected)
    }
    req.user = user ?? adUser;
    // Mark the global-admin origin so meta-permission routes (group→role mapping)
    // can require it — a business user who holds Admin via a group must not pass.
    req.user.is_global_admin = globalAdmin;
    recordLogin(req, req.user).catch(() => {});
    return true;
  };

  // Global-admin allowlist wins over group resolution and over the exactly-one
  // rule: these identities are entitled by email, not by an AD group (spec item
  // 6), so their group memberships — however many — do not gate them. This is
  // also the break-glass path, which must work before the groups exist.
  if (isGlobalAdmin(claimsObj)) {
    await admitAs({ role: 'Admin', matchedGroup: '(global-admin allowlist)', groups: [] }, true);
    return;
  }

  const resolution = await resolveGroupRole(claimsObj);
  if (resolution.kind === 'one') {
    await admitAs({ role: resolution.role, matchedGroup: resolution.matchedGroup, groups: resolution.groups });
    return;
  }
  if (resolution.kind === 'multiple') {
    // Spec item 5: exactly one mapped group per user. More than one is not a
    // "pick the strongest" case — it is blocked, and the user is told to have
    // all but one removed. Multi-role is not allowed.
    logger.warn(
      { sub: claims.sub, groups: resolution.matched.map((m) => `${m.group}=${m.role}`) },
      'authMiddleware: identity is in multiple mapped groups — blocked'
    );
    res.status(403).json({
      error:
        'You are a member of more than one access group for this application ' +
        `(${resolution.matched.map((m) => m.role).join(', ')}). Exactly one is required — ` +
        'ask your administrator to remove the others until a single group remains.',
    });
    return;
  }
  if (resolution.kind === 'none') {
    // Group mapping is on, the token verified, but none of the caller's groups
    // are mapped to a role — authenticated, but not entitled to this application.
    logger.warn(
      { sub: claims.sub, groups: resolution.groups },
      'authMiddleware: authenticated identity is in no mapped group'
    );
    res.status(403).json({ error: 'You are not a member of any group with access to this application.' });
    return;
  }
  // resolution.kind === 'inert' → no map configured; fall through to the persona
  // model below (DEV/QA).

  // Authenticated against NBG Identity, but no persona resolved yet. This is the
  // normal first visit: the SPA only sends X-User-Id once the user has picked a
  // persona from the dropdown, so the very first request carries the id_token
  // alone and personaId falls back to claims.sub — which never matches, because
  // users.id holds UAT persona ids (admin-1, bu-006, ...), not NBG subjects.
  // Rejecting here locked out every clean browser session.
  //
  // Seeding a persona here is UAT behaviour and is therefore gated behind an
  // explicit opt-in rather than inferred from DISABLE_LOGIN or NODE_ENV: RDARR
  // does not derive authorisation from the token, the role and units always come
  // from the selected persona. The token proves the caller is an authenticated
  // NBG user; the dropdown decides what they act as. With the flag on we seed the
  // first Admin, exactly as DISABLE_LOGIN mode does, and let the user switch.
  //
  // Leaving UAT_PERSONA_MODE unset is the production-safe default: an identity
  // with no matching user is rejected. Going to production needs a real
  // identity → user mapping (match on email/upn, or store the NBG subject on
  // users), because with the flag on ANY authenticated NBG user starts as Admin.
  if (!UAT_PERSONA_MODE) {
    logger.warn({ sub: claims.sub }, 'authMiddleware: authenticated identity has no matching user');
    res.status(403).json({ error: 'No matching user for this identity.' });
    return;
  }
  try {
    const adminUser = await firstAdmin();
    if (adminUser) {
      logger.info(
        { sub: claims.sub, seeded: adminUser.id },
        'authMiddleware: no persona for identity — seeding first admin (UAT behaviour)'
      );
      req.user = adminUser;
      recordLogin(req, adminUser).catch(() => {});
      return next();
    }
  } catch (err) {
    logger.warn({ err }, 'authMiddleware: first-admin fallback failed');
  }
  res.status(403).json({ error: 'No matching user for this identity.' });
}
