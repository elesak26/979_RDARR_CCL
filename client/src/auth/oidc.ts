/**
 * Browser-side OIDC (NBG Identity, authorization_code + PKCE).
 *
 * The SPA generates the PKCE verifier/challenge and redirects to NBG Identity.
 * On return it posts the code to the Core's /auth/exchange (which holds the
 * confidential client_secret) and receives an access_token (sent as Bearer on
 * every /api call, validated by the compliance proxy) plus the id_token (the
 * real signed-in identity — email/name — which we surface in the UI).
 *
 * Role/persona is still selected via the dev user dropdown (X-User-Id); the
 * OIDC login is the authentication GATE, not the role source.
 */

const TOKEN_KEY = 'ccl-access-token';
const TOKEN_EXP_KEY = 'ccl-token-exp';
const IDTOKEN_KEY = 'ccl-id-token';
const PROFILE_KEY = 'ccl-identity';
const VERIFIER_KEY = 'ccl-pkce-verifier';
const STATE_KEY = 'ccl-oidc-state';

export interface AuthConfig {
  enabled: boolean;
  authorization_endpoint: string;
  end_session_endpoint: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
}

export interface Identity {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  [claim: string]: unknown;
}

/** Best human-readable label for an identity. */
export function identityLabel(id: Identity | null): string {
  if (!id) return '';
  const full = [id.given_name, id.family_name].filter(Boolean).join(' ').trim();
  return (
    (id.email as string) ||
    (id.preferred_username as string) ||
    (id.name as string) ||
    full ||
    (id.sub as string) ||
    ''
  );
}

let cachedConfig: AuthConfig | null = null;

export async function getAuthConfig(): Promise<AuthConfig> {
  if (cachedConfig) return cachedConfig;
  const res = await fetch('/auth/config');
  cachedConfig = (await res.json()) as AuthConfig;
  return cachedConfig;
}

/** Synchronous best-effort: true only after getAuthConfig() has run and reported enabled. */
export function isAuthEnabled(): boolean {
  return cachedConfig?.enabled === true;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(byteLen = 48): string {
  const a = new Uint8Array(byteLen);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
}

// ── Token storage ─────────────────────────────────────────────────────────────
export function getAccessToken(): string | null {
  const t = sessionStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const exp = Number(sessionStorage.getItem(TOKEN_EXP_KEY) || 0);
  // Treat as gone 30s before real expiry so we re-login proactively.
  if (exp && Date.now() > exp - 30_000) return null;
  return t;
}

// The id_token is the JWT the backend can JWKS-verify (the access_token is opaque
// on the NBG IdP). Sent as X-Id-Token on /api calls so the Core can authenticate.
export function getIdToken(): string | null {
  return sessionStorage.getItem(IDTOKEN_KEY);
}

export function getIdentity(): Identity | null {
  // Prefer the userinfo profile (has email/name); fall back to id_token (sub only).
  const stored = sessionStorage.getItem(PROFILE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as Identity;
    } catch {
      /* fall through */
    }
  }
  const idt = sessionStorage.getItem(IDTOKEN_KEY);
  if (!idt) return null;
  try {
    const payload = idt.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json))) as Identity;
  } catch {
    return null;
  }
}

function clearPkce() {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

// ── Flow ──────────────────────────────────────────────────────────────────────
export async function beginLogin(): Promise<void> {
  const cfg = await getAuthConfig();
  const verifier = randomString(48);
  const challenge = await sha256(verifier);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const url = new URL(cfg.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.client_id);
  url.searchParams.set('redirect_uri', cfg.redirect_uri);
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

/** If the URL carries ?code= (a callback), exchange it and store tokens. Returns true if handled. */
export async function completeLoginIfCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const state = params.get('state');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (!verifier || (expectedState && state !== expectedState)) {
    clearPkce();
    throw new Error('Invalid login state — please try again');
  }
  const cfg = await getAuthConfig();
  const res = await fetch('/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: cfg.redirect_uri }),
  });
  if (!res.ok) {
    clearPkce();
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || e.error || 'Login failed');
  }
  const data = await res.json();
  sessionStorage.setItem(TOKEN_KEY, data.access_token);
  if (data.id_token) sessionStorage.setItem(IDTOKEN_KEY, data.id_token);
  if (data.profile) sessionStorage.setItem(PROFILE_KEY, JSON.stringify(data.profile));
  if (data.expires_in) sessionStorage.setItem(TOKEN_EXP_KEY, String(Date.now() + Number(data.expires_in) * 1000));
  clearPkce();
  // Strip ?code&state from the address bar.
  window.history.replaceState({}, document.title, '/');
  return true;
}

export function logout(): void {
  const idToken = sessionStorage.getItem(IDTOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_EXP_KEY);
  sessionStorage.removeItem(IDTOKEN_KEY);
  sessionStorage.removeItem(PROFILE_KEY);
  fetch('/auth/logout' + (idToken ? `?id_token_hint=${encodeURIComponent(idToken)}` : ''))
    .then((r) => r.json())
    .then((d) => window.location.assign(d.end_session_url))
    .catch(() => window.location.assign('/'));
}
