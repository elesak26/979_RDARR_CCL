import { Router, Request, Response } from 'express';
import { logger } from '../logger';
import {
  encryptionAvailable,
  setSessionCookies,
  clearSessionCookies,
  decryptTokens,
  getSessionChunks,
} from '../lib/tokenEncryption';
import * as msal from '../lib/msalClient';
import { PERSONA_HEADER_ALLOWED } from '../lib/appEnv';

/**
 * OIDC login endpoints (NBG Identity, authorization_code + PKCE).
 *
 * The SPA performs the PKCE dance in the browser but the code→token exchange is
 * done here so the confidential client_secret never reaches the browser. These
 * routes live OUTSIDE /api (so they are not behind authMiddleware) and the UI
 * nginx proxies /auth/* straight to the Core, bypassing the compliance proxy
 * (this is the pre-authentication step).
 *
 * Auth is considered ENABLED only when OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET
 * are set. When unset (local dev / pre-identity), /auth/config reports
 * enabled:false and the SPA falls back to the no-login dev behaviour.
 */
const router = Router();

const ISSUER = process.env.OAUTH_ISSUER || 'https://myqa.nbg.gr/identity';
// When AUTH_PROVIDER=entra the authorize/logout endpoints come from MSAL (built
// from the tenant); otherwise they keep the IdentityServer /connect/* shape the
// current IdP uses. The SPA reads these from /auth/config either way.
const AUTHORIZE_URL = msal.msalEnabled()
  ? msal.authorizeEndpoint()
  : process.env.OAUTH_AUTHORIZE_URL || `${ISSUER}/connect/authorize`;
const TOKEN_URL = process.env.OAUTH_TOKEN_URL || `${ISSUER}/connect/token`;
const USERINFO_URL = process.env.OAUTH_USERINFO_URL || `${ISSUER}/connect/userinfo`;
const END_SESSION_URL = msal.msalEnabled()
  ? msal.endSessionEndpoint()
  : process.env.OAUTH_END_SESSION_URL || `${ISSUER}/connect/endsession`;
const CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const SCOPE = process.env.OAUTH_SCOPE || 'openid profile email rdarr-core-api-v1';
const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || '';

const authEnabled = (): boolean => Boolean(CLIENT_ID && CLIENT_SECRET);

// Public: tells the SPA how to start the OIDC dance (and whether auth is on).
router.get('/auth/config', (_req: Request, res: Response) => {
  res.json({
    enabled: authEnabled(),
    authorization_endpoint: AUTHORIZE_URL,
    end_session_endpoint: END_SESSION_URL,
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    // Whether the UAT persona dropdown (X-User-Id switcher) is active. When off,
    // the role comes from the verified token/directory and the SPA hides the
    // switcher — there is nothing to switch to.
    persona_mode: PERSONA_HEADER_ALLOWED,
  });
});

// Public: exchange the authorization code for an access token.
router.post('/auth/exchange', async (req: Request, res: Response) => {
  if (!authEnabled()) {
    res.status(400).json({ error: 'oauth_not_configured' });
    return;
  }
  const { code, code_verifier, redirect_uri } = (req.body ?? {}) as {
    code?: string;
    code_verifier?: string;
    redirect_uri?: string;
  };
  if (!code || !code_verifier) {
    res.status(400).json({ error: 'missing_code_or_verifier' });
    return;
  }
  try {
    // ── MSAL (Entra) path ─────────────────────────────────────────────────────
    // acquireTokenByCode redeems the SPA's PKCE code. The id_token claims already
    // carry the name and the group, so no userinfo round-trip is needed.
    if (msal.msalEnabled()) {
      if (!encryptionAvailable()) {
        logger.error('auth/exchange: TOKEN_ENCRYPTION_KEY is not set — refusing to establish a session');
        res.status(500).json({ error: 'session_not_configured' });
        return;
      }
      try {
        const t = await msal.exchangeCode({
          code,
          codeVerifier: code_verifier,
          redirectUri: redirect_uri || REDIRECT_URI,
        });
        const expiresIn = Math.max(60, Math.round((t.expiresAt - Date.now()) / 1000));
        setSessionCookies(
          res,
          { idToken: t.idToken, refreshToken: null, expiresAt: t.expiresAt, profile: t.profile },
          expiresIn
        );
        res.json({ ok: true, profile: t.profile });
      } catch (e) {
        logger.warn({ err: e }, 'auth/exchange: MSAL acquireTokenByCode failed');
        res.status(400).json({ error: 'token_exchange_failed' });
      }
      return;
    }

    // ── Legacy OIDC path (current IdP) ────────────────────────────────────────
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier,
      redirect_uri: redirect_uri || REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      logger.warn({ status: r.status, err: data.error }, 'auth/exchange: token endpoint rejected');
      res.status(400).json({ error: data.error || 'token_exchange_failed', detail: data.error_description });
      return;
    }
    // Fetch the real identity (email/name) from userinfo — NBG id_tokens carry
    // only `sub`, so the human-readable claims come from here. Non-fatal.
    let profile: Record<string, unknown> | undefined;
    try {
      if (data.access_token) {
        const ui = await fetch(USERINFO_URL, {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (ui.ok) profile = (await ui.json()) as Record<string, unknown>;
        else logger.warn({ status: ui.status }, 'auth/exchange: userinfo non-OK');
      }
    } catch (e) {
      logger.warn({ err: e }, 'auth/exchange: userinfo unreachable');
    }

    // Keep the tokens on the server, in an encrypted httpOnly cookie. They are
    // deliberately NOT returned to the browser: the SPA managing token lifetime
    // is what made RDARR bounce users to the IdP mid-task, and a token in
    // sessionStorage is reachable from any script on the page.
    if (!encryptionAvailable()) {
      logger.error('auth/exchange: TOKEN_ENCRYPTION_KEY is not set — refusing to establish a session');
      res.status(500).json({ error: 'session_not_configured' });
      return;
    }
    const expiresIn = Number(data.expires_in) || 3600;
    setSessionCookies(
      res,
      {
        idToken: data.id_token ? String(data.id_token) : null,
        refreshToken: data.refresh_token ? String(data.refresh_token) : null,
        expiresAt: Date.now() + expiresIn * 1000,
        profile: profile ?? null,
      },
      expiresIn
    );
    res.json({ ok: true, profile: profile ?? null });
  } catch (err) {
    logger.error({ err }, 'auth/exchange: token endpoint unreachable');
    res.status(502).json({ error: 'token_exchange_unreachable' });
  }
});

// Public: what the SPA asks on boot instead of inspecting a token itself.
// Returns only whether a session is live and who it belongs to — never a token.
router.get('/auth/session', (req: Request, res: Response) => {
  if (!authEnabled()) {
    res.json({ authenticated: false, auth_enabled: false, profile: null });
    return;
  }
  const session = decryptTokens(getSessionChunks(req.cookies));
  if (!session || session.expiresAt < Date.now()) {
    res.json({ authenticated: false, auth_enabled: true, profile: null });
    return;
  }
  res.json({ authenticated: true, auth_enabled: true, profile: session.profile ?? null });
});

// Public: build the end-session (logout) URL for the SPA to redirect to, and
// drop the local session. The id_token_hint now comes from the server-side
// session rather than the query string — the browser no longer holds one.
router.get('/auth/logout', (req: Request, res: Response) => {
  const session = decryptTokens(getSessionChunks(req.cookies));
  const idToken = session?.idToken || (req.query.id_token_hint as string | undefined);
  clearSessionCookies(res);
  const url = new URL(END_SESSION_URL);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  if (REDIRECT_URI) url.searchParams.set('post_logout_redirect_uri', REDIRECT_URI);
  res.json({ end_session_url: url.toString() });
});

export default router;
