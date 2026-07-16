import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, importJWK, type JWTPayload, type JWK } from 'jose';
import { query } from '../db';
import { logger } from '../logger';

export interface AuthUser {
  id: string;
  display_name: string;
  role: string;
  unit_codes: string[];
  primary_unit_code: string | null;
  is_active: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const DISABLE_LOGIN = process.env.DISABLE_LOGIN === 'true';

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
  const token = (req.headers['x-id-token'] as string | undefined) || bearerToken(req) || undefined;
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

  const personaId = (req.headers['x-user-id'] as string | undefined) || (claims.sub ? String(claims.sub) : undefined);
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
  // Authenticated, but no matching user record — do NOT auto-admin in production.
  res.status(403).json({ error: 'No matching user for this identity.' });
}
