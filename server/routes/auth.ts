import { Router, Request, Response } from 'express';
import { logger } from '../logger';

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
const AUTHORIZE_URL = process.env.OAUTH_AUTHORIZE_URL || `${ISSUER}/connect/authorize`;
const TOKEN_URL = process.env.OAUTH_TOKEN_URL || `${ISSUER}/connect/token`;
const USERINFO_URL = process.env.OAUTH_USERINFO_URL || `${ISSUER}/connect/userinfo`;
const END_SESSION_URL = process.env.OAUTH_END_SESSION_URL || `${ISSUER}/connect/endsession`;
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

    res.json({
      access_token: data.access_token,
      token_type: data.token_type,
      expires_in: data.expires_in,
      id_token: data.id_token,
      profile,
    });
  } catch (err) {
    logger.error({ err }, 'auth/exchange: token endpoint unreachable');
    res.status(502).json({ error: 'token_exchange_unreachable' });
  }
});

// Public: build the end-session (logout) URL for the SPA to redirect to.
router.get('/auth/logout', (req: Request, res: Response) => {
  const idToken = req.query.id_token_hint as string | undefined;
  const url = new URL(END_SESSION_URL);
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  if (REDIRECT_URI) url.searchParams.set('post_logout_redirect_uri', REDIRECT_URI);
  res.json({ end_session_url: url.toString() });
});

export default router;
