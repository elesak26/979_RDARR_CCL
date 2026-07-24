import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from 'crypto';
import { logger } from '../logger';

/**
 * Encrypted server-side session, held in httpOnly cookies.
 *
 * RDARR used to hand the OIDC tokens to the browser (sessionStorage) and let the
 * SPA manage their lifetime. That made it the only NBG app that bounces users to
 * the IdP mid-task: the SPA redirects 30s before the access_token expires, and
 * again whenever the shorter-lived id_token makes the Core answer 401. BIA,
 * pf-editor, EWS and LoanFileTransfer all keep the tokens server-side in an
 * encrypted httpOnly cookie instead, so the browser never knows a token exists
 * and never redirects on its own. This is that model, following BIA's
 * implementation so the two stay comparable.
 *
 * Cookie name prefix is rdarr_session_ (chunked — browsers cap a cookie at 4KB
 * and an NBG id_token plus access_token comfortably exceeds that).
 */

const CHUNK_SIZE = 3800; // Safe under the 4KB browser cookie limit
export const SESSION_COOKIE_PREFIX = 'rdarr_session_';
export const SESSION_COUNT_COOKIE = 'rdarr_session_count';
const MAX_CHUNKS = 10;

export interface SessionTokens {
  /** The JWT the Core JWKS-verifies — the NBG access_token is opaque and, since
   *  nothing reads it after the userinfo call during the exchange, it is
   *  deliberately NOT stored: every byte here is sent as a Cookie header on every
   *  single request, and nginx rejects a Cookie header over 8KB with a bare
   *  "400 Request Header Or Cookie Too Large". */
  idToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  /** Identity claims from userinfo/id_token, so /auth/session needs no re-parse. */
  profile?: Record<string, unknown> | null;
}

let _cachedKey: Buffer | null = null;
let _cachedKeySource: string | undefined;

/**
 * The secret the session key is derived from.
 *
 * Deliberately NOT a new environment variable. OAUTH_CLIENT_SECRET is already
 * required for login to work at all, already lives only on the server, and is
 * already a Key Vault reference in both DEV and QA — so deriving from it means
 * this feature ships with zero new configuration, zero new Key Vault entries and
 * nothing to coordinate per environment.
 *
 * TOKEN_ENCRYPTION_KEY is still honoured if someone sets it later, so the two
 * secrets can be separated without a code change.
 *
 * The derived key is NOT the client secret: PBKDF2 with an RDARR-specific salt
 * produces an independent 256-bit key, and the client secret can never be
 * recovered from a cookie. The accepted trade-off is that rotating the client
 * secret invalidates live sessions — everyone signs in once more, which a client
 * secret rotation forces anyway.
 */
function sourceSecret(): string | null {
  const explicit = process.env.TOKEN_ENCRYPTION_KEY;
  if (explicit && explicit.length >= 32) return explicit;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (clientSecret && clientSecret.length >= 16) return clientSecret;
  return null;
}

function getEncryptionKey(): Buffer {
  const secret = sourceSecret();
  if (!secret) {
    throw new Error(
      'No session secret available: set OAUTH_CLIENT_SECRET (required for login anyway) or TOKEN_ENCRYPTION_KEY'
    );
  }
  if (_cachedKey && _cachedKeySource === secret) return _cachedKey;
  // PBKDF2 at the OWASP-recommended iteration count. The salt is RDARR-specific
  // and mixed with the secret, so the derived key is unrelated to any other use
  // of the same secret and cannot be precomputed.
  const salt = createHash('sha256').update(`nbg-rdarr-session-salt-${secret}`).digest();
  _cachedKey = pbkdf2Sync(secret, salt, 310000, 32, 'sha256');
  _cachedKeySource = secret;
  return _cachedKey;
}

/** True when a usable secret exists — lets callers fail closed with a clear message. */
export function encryptionAvailable(): boolean {
  return sourceSecret() !== null;
}

/** Encrypt the session with AES-256-GCM into cookie-safe base64 chunks. */
export function encryptTokens(tokens: SessionTokens): string[] {
  const key = getEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // base64, not hex. Hex doubles the ciphertext and the whole thing then gets
  // base64'd again (+33%) — a ~2.7x blow-up that pushed a normal id_token past
  // nginx's 8KB Cookie limit. base64 keeps it at ~1.33x.
  const parts = [cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()];
  const encrypted = Buffer.concat(parts).toString('base64');
  const tag = cipher.getAuthTag();

  const payload = Buffer.from(
    JSON.stringify({ encrypted, iv: iv.toString('base64'), tag: tag.toString('base64') })
  ).toString('base64');

  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
    chunks.push(payload.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** Decrypt cookie chunks back into the session, or null if anything is off. */
export function decryptTokens(chunks: string[]): SessionTokens | null {
  if (!chunks.length) return null;
  try {
    const key = getEncryptionKey();
    const payload = chunks.join('');
    const { encrypted, iv, tag } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted) as SessionTokens;
  } catch (err) {
    // A rotated key, a truncated cookie or a tampered tag all land here. Treat as
    // "no session" rather than an error — the caller will start a fresh login.
    logger.warn({ err }, 'tokenEncryption: session decryption failed');
    return null;
  }
}

/** Collect the ordered rdarr_session_* cookie chunks. */
export function getSessionChunks(cookies: Record<string, string> | undefined): string[] {
  if (!cookies) return [];
  const chunks: string[] = [];
  let i = 0;
  while (cookies[`${SESSION_COOKIE_PREFIX}${i}`] && i < MAX_CHUNKS) {
    chunks.push(cookies[`${SESSION_COOKIE_PREFIX}${i}`]);
    i++;
  }
  return chunks;
}

const isProduction = process.env.NODE_ENV === 'production';

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    // 'lax' rather than 'strict': the user arrives back from the NBG IdP via a
    // cross-site redirect, and 'strict' would withhold the cookie on that first
    // request, making a completed login look like no login at all.
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function getAuthCookieOptions(maxAgeSeconds: number) {
  return { ...baseCookieOptions(), maxAge: maxAgeSeconds * 1000 };
}

/** Short-lived cookies for the PKCE handshake. */
export function getPkceCookieOptions() {
  return { ...baseCookieOptions(), maxAge: 10 * 60 * 1000 };
}

/** Write the session across as many chunks as it needs. */
export function setSessionCookies(
  res: { cookie: (n: string, v: string, o: object) => void },
  tokens: SessionTokens,
  maxAgeSeconds: number
): void {
  const chunks = encryptTokens(tokens);
  const opts = getAuthCookieOptions(maxAgeSeconds);
  chunks.forEach((chunk, i) => res.cookie(`${SESSION_COOKIE_PREFIX}${i}`, chunk, opts));
  res.cookie(SESSION_COUNT_COOKIE, String(chunks.length), opts);
}

/** Clear every chunk we could have written, not just the ones present. */
export function clearSessionCookies(res: {
  clearCookie: (n: string, o: object) => void;
}): void {
  const opts = baseCookieOptions();
  for (let i = 0; i < MAX_CHUNKS; i++) res.clearCookie(`${SESSION_COOKIE_PREFIX}${i}`, opts);
  res.clearCookie(SESSION_COUNT_COOKIE, opts);
}
