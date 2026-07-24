/**
 * Azure AD (Entra ID) login via MSAL Node — the confidential-client side.
 *
 * The identity team's guidance is to sign in through MSAL, Microsoft's own
 * library, rather than a hand-rolled OIDC exchange. MSAL runs HERE, on the
 * server, as a confidential client: the browser still performs the PKCE dance
 * and posts the authorization code to /auth/exchange, and this module redeems it
 * with acquireTokenByCode. The tokens never leave the server — they go straight
 * into the encrypted httpOnly session cookie, exactly as before.
 *
 * That placement is deliberate. MSAL's *browser* library (@azure/msal-browser)
 * keeps tokens in sessionStorage, which is the token-in-the-browser pattern RDARR
 * was moved off precisely because it bounced users mid-task and exposed the token
 * to any script on the page. MSAL Node preserves the session model while still
 * being "the library".
 *
 * Inert until AUTH_PROVIDER=entra. Unset (the default) leaves the existing OIDC
 * fetch path in routes/auth.ts untouched, so DEV and QA against myqa.nbg.gr are
 * unchanged. Nothing here is exercised until the identity team delivers the
 * tenant id, client id and secret.
 */
import {
  ConfidentialClientApplication,
  type Configuration,
  type AuthenticationResult,
  LogLevel,
} from '@azure/msal-node';
import { logger } from '../logger';

/** MSAL is the login path only when explicitly selected. */
export function msalEnabled(): boolean {
  return (process.env.AUTH_PROVIDER || '').trim().toLowerCase() === 'entra';
}

const TENANT_ID = () => (process.env.AZURE_TENANT_ID || '').trim();
const CLIENT_ID = () => (process.env.OAUTH_CLIENT_ID || '').trim();
const CLIENT_SECRET = () => (process.env.OAUTH_CLIENT_SECRET || '').trim();

/** login.microsoftonline.com/<tenant>. Override AZURE_AUTHORITY for sovereign or
 *  B2C endpoints if the identity team specifies one. */
export function authority(): string {
  const override = (process.env.AZURE_AUTHORITY || '').trim();
  if (override) return override.replace(/\/$/, '');
  return `https://login.microsoftonline.com/${TENANT_ID()}`;
}

/** The v2.0 authorize endpoint the SPA redirects to. Kept so /auth/config can
 *  hand the SPA the same shape it already uses for the current IdP. */
export function authorizeEndpoint(): string {
  return `${authority()}/oauth2/v2.0/authorize`;
}

export function endSessionEndpoint(): string {
  return `${authority()}/oauth2/v2.0/logout`;
}

/** OIDC reserved scopes MSAL manages itself — passing them into
 *  acquireTokenByCode makes MSAL throw, so they are stripped from the resource
 *  scopes here while remaining in the SPA's authorize request (which needs
 *  `openid` to receive an id_token). */
const RESERVED = new Set(['openid', 'profile', 'email', 'offline_access']);

export function resourceScopes(): string[] {
  const raw = (process.env.OAUTH_SCOPE || 'openid profile email').split(/\s+/).filter(Boolean);
  return raw.filter((s) => !RESERVED.has(s.toLowerCase()));
}

/** Fail at startup, not at first login, if MSAL is selected but unconfigured. */
export function assertConfigIfEnabled(): void {
  if (!msalEnabled()) return;
  const missing = [
    TENANT_ID() ? null : 'AZURE_TENANT_ID',
    CLIENT_ID() ? null : 'OAUTH_CLIENT_ID',
    CLIENT_SECRET() ? null : 'OAUTH_CLIENT_SECRET',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`AUTH_PROVIDER=entra but MSAL config is incomplete: missing ${missing.join(', ')}`);
  }
}

let _client: ConfidentialClientApplication | null = null;

export function getClient(): ConfidentialClientApplication {
  if (_client) return _client;
  const missing = [
    TENANT_ID() ? null : 'AZURE_TENANT_ID',
    CLIENT_ID() ? null : 'OAUTH_CLIENT_ID',
    CLIENT_SECRET() ? null : 'OAUTH_CLIENT_SECRET',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`MSAL enabled (AUTH_PROVIDER=entra) but missing: ${missing.join(', ')}`);
  }
  const config: Configuration = {
    auth: {
      clientId: CLIENT_ID(),
      authority: authority(),
      clientSecret: CLIENT_SECRET(),
    },
    system: {
      loggerOptions: {
        // Route MSAL's own diagnostics through our logger; never log PII.
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) logger.warn({ msal: message }, 'MSAL');
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  };
  _client = new ConfidentialClientApplication(config);
  return _client;
}

export interface MsalTokens {
  idToken: string | null;
  expiresAt: number;
  claims: Record<string, unknown>;
  profile: Record<string, unknown> | null;
}

/**
 * Redeem the authorization code the SPA obtained (with PKCE) for tokens. Returns
 * the id_token and its claims — the claims carry the group the middleware maps to
 * a role, and the human-readable name for the session profile. No separate
 * userinfo call is needed: Entra id_tokens already carry name/preferred_username.
 */
export async function exchangeCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<MsalTokens> {
  const result: AuthenticationResult = await getClient().acquireTokenByCode({
    code: params.code,
    codeVerifier: params.codeVerifier,
    redirectUri: params.redirectUri,
    scopes: resourceScopes(),
  });
  const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const profile: Record<string, unknown> = {
    sub: claims.sub ?? claims.oid ?? null,
    name: str(claims.name) ?? null,
    email: str(claims.email) ?? str(claims.preferred_username) ?? null,
    preferred_username: str(claims.preferred_username) ?? null,
  };
  // expiresOn is the access-token expiry; fall back to +1h if MSAL omits it.
  const expiresAt = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600 * 1000;
  return { idToken: result.idToken ?? null, expiresAt, claims, profile };
}
