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

// Deliberately no token keys here any more. Tokens live only in the Core's
// encrypted httpOnly session cookie; anything the browser can read, a script on
// the page can read too.
const VERIFIER_KEY = 'ccl-pkce-verifier';
const STATE_KEY = 'ccl-oidc-state';
const RETURN_KEY = 'ccl-return-to';

/** Where to send the user after a login round-trip.
 *
 *  The IdP can only return to the registered redirect_uri (the app root), and
 *  the scope has no `offline_access`, so a token renewal is a full-page trip
 *  through NBG Identity. Without remembering the route, every renewal silently
 *  dumps the user back on the Dashboard, mid-task — which is what users report
 *  as "it refreshed and changed my screen".
 *
 *  Guard the stored value: only a same-origin absolute path is ever accepted,
 *  never a full URL or a protocol-relative one, so this can never become an
 *  open redirect. */
function safeReturnPath(p: string | null): string {
  if (!p || !p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}

export interface AuthConfig {
  enabled: boolean;
  authorization_endpoint: string;
  end_session_endpoint: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  /** True when the UAT persona dropdown is active. When false the role comes from
   *  the token/directory and the SPA hides the switcher. */
  persona_mode?: boolean;
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

/** Synchronous best-effort: is the UAT persona switcher active? When auth is on
 *  but persona mode is off, the role comes from the directory and the dropdown is
 *  hidden. Defaults to true until the config is known, and whenever auth is off
 *  (local/DISABLE_LOGIN), so the dev switcher keeps working there. */
export function isPersonaMode(): boolean {
  if (!cachedConfig) return true;
  if (cachedConfig.enabled !== true) return true;
  return cachedConfig.persona_mode !== false;
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

// ── Session ───────────────────────────────────────────────────────────────────
// The browser holds NO tokens. /auth/exchange puts them in an encrypted httpOnly
// cookie on the Core and this asks only "am I signed in, and as whom". That is
// what stops the SPA from redirecting on its own: there is no expiry here to
// watch, so nothing can decide mid-task that the user must go to the IdP again.
// Matches BIA / pf-editor / EWS / LoanFileTransfer.
export interface Session {
  authenticated: boolean;
  auth_enabled: boolean;
  profile: Identity | null;
}

let cachedSession: Session | null = null;

export async function fetchSession(force = false): Promise<Session> {
  if (cachedSession && !force) return cachedSession;
  try {
    const res = await fetch('/auth/session', { credentials: 'include' });
    cachedSession = res.ok
      ? ((await res.json()) as Session)
      : { authenticated: false, auth_enabled: true, profile: null };
  } catch {
    cachedSession = { authenticated: false, auth_enabled: true, profile: null };
  }
  return cachedSession;
}

/** Synchronous read of the last /auth/session result (null before it has run). */
export function getSession(): Session | null {
  return cachedSession;
}

/** Forget the cached answer — call after logout or a fresh sign-in. */
export function clearSessionCache(): void {
  cachedSession = null;
}

export function getIdentity(): Identity | null {
  return cachedSession?.profile ?? null;
}

function clearPkce() {
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}

// ── Flow ──────────────────────────────────────────────────────────────────────
export async function beginLogin(): Promise<void> {
  // Capture the current route BEFORE leaving for the IdP. sessionStorage
  // survives the cross-origin round trip in the same tab (the PKCE verifier
  // below relies on exactly that).
  try {
    // Drop any OIDC params already in the bar, so a retry cannot store a stale
    // authorization code and replay it after the next round trip.
    const q = new URLSearchParams(window.location.search);
    for (const k of ['code', 'state', 'session_state', 'error', 'error_description']) q.delete(k);
    const qs = q.toString();
    sessionStorage.setItem(RETURN_KEY, safeReturnPath(window.location.pathname + (qs ? `?${qs}` : '')));
  } catch { /* storage unavailable — fall back to the root */ }
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
  // credentials:'include' so the Set-Cookie from the Core is stored — this is the
  // only place the session is established.
  const res = await fetch('/auth/exchange', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: cfg.redirect_uri }),
  });
  if (!res.ok) {
    clearPkce();
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || e.error || 'Login failed');
  }
  const data = await res.json();
  // No tokens come back and none are stored. Seed the session cache from the
  // exchange response so the first render already knows who is signed in.
  cachedSession = { authenticated: true, auth_enabled: true, profile: data.profile ?? null };
  clearPkce();
  // Strip ?code&state from the address bar and land back on the route the user
  // was on. BrowserRouter is a child of AuthGate, so it has not mounted yet —
  // it will read this corrected URL on its first render, no navigation needed.
  const returnTo = safeReturnPath(sessionStorage.getItem(RETURN_KEY));
  sessionStorage.removeItem(RETURN_KEY);
  window.history.replaceState({}, document.title, returnTo);
  return true;
}

export function logout(): void {
  // The Core holds the id_token and clears the session cookies; the browser has
  // nothing of its own to discard beyond the cached answer.
  clearSessionCache();
  sessionStorage.removeItem(RETURN_KEY);
  fetch('/auth/logout', { credentials: 'include' })
    .then((r) => r.json())
    .then((d) => window.location.assign(d.end_session_url))
    .catch(() => window.location.assign('/'));
}
