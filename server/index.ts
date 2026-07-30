import path from 'path';
import tls from 'tls';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env') });

// Enforce TLS 1.2 minimum for all outbound Node.js connections (MSAL,
// any fetch-based auth flows, pg when DB_SSL=require). TLS 1.3 is negotiated
// automatically when both sides support it.
tls.DEFAULT_MIN_VERSION = 'TLSv1.2';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';

import { logger } from './logger';
import { assertBypassFlagsAllowed, APP_ENV, DISABLE_LOGIN, UAT_PERSONA_MODE } from './lib/appEnv';
import { mappingActive, preloadGroupMappings } from './lib/groupRoles';
import { assertStorageConfig, usingBlob } from './lib/fileStore';
import { mailerEnabled, mailerPosture } from './lib/mailer';
import { msalEnabled, assertConfigIfEnabled as assertMsalConfig } from './lib/msalClient';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { generalLimiter, perUserLimiter, mutationLimiter } from './middleware/rate-limit';
import { ipWhitelistMiddleware } from './middleware/ip-whitelist';

import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import cyclesRouter from './routes/cycles';
import questionsRouter from './routes/questions';
import responsesRouter from './routes/responses';
import attachmentsRouter from './routes/attachments';
import validationsRouter from './routes/validations';
import reportingRouter from './routes/reporting';
import auditRouter from './routes/audit';
import notificationsRouter from './routes/notifications';
import groupMappingsRouter from './routes/group-mappings';

// Before anything else: an authentication bypass outside a declared
// non-production environment is fatal, not a warning. Throwing here happens
// before the server binds, so the container fails its health check and the
// deployment is rejected rather than quietly serving unauthenticated traffic.
assertBypassFlagsAllowed();
// MSAL (Entra) login: if selected, its config must be complete before we bind.
assertMsalConfig();
// Blob storage: if selected, it must be configured before we bind.
assertStorageConfig();
logger.info(
  {
    appEnv: APP_ENV || '(undeclared — treated as production)',
    disableLogin: DISABLE_LOGIN,
    uatPersonaMode: UAT_PERSONA_MODE,
    groupRoleMapping: mappingActive() ? 'entra (DB-backed)' : 'off (persona mode)',
    authProvider: msalEnabled() ? 'entra (MSAL)' : 'oidc',
    fileStorage: usingBlob() ? 'azure blob' : 'local disk',
    email: mailerEnabled() ? mailerPosture() : 'off (SMTP not configured)',
  },
  'Authentication posture'
);
// Warm the group→role cache so the first authenticated request does not pay for
// the initial DB read (best-effort; no-op unless AUTH_PROVIDER=entra).
preloadGroupMappings().catch(() => {});

const app = express();

// ── IP Whitelist (must run before everything else) ───────────────────────────
app.use(ipWhitelistMiddleware as express.RequestHandler);

// ── Security & middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = [
        process.env.CORS_ORIGIN || 'http://localhost:5173',
        'http://localhost:4001',
        /\.trycloudflare\.com$/,
      ];
      if (!origin || allowed.some(p => typeof p === 'string' ? p === origin : p.test(origin))) {
        cb(null, true);
      } else {
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  })
);
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(
  pinoHttp({
    logger,
    // skip health checks to avoid noise
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  })
);

// ── HTTPS enforcement (production only) ─────────────────────────────────────
// Behind a reverse proxy (nginx / Azure Front Door) the plain-TCP connection
// arrives as HTTP; the proxy sets X-Forwarded-Proto so we can detect it and
// issue a permanent redirect before any API logic runs.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// The Core runs behind the UI's nginx (which proxies /api) — without trust proxy,
// every request appears to come from nginx's single IP, so all users would share
// one rate-limit bucket and collectively hit 429. Trust the one nginx hop so the
// limiter can key on the real client (and X-User-Id, see rate-limit.ts).
app.set('trust proxy', 1);
app.use(generalLimiter);

// ── Health (no auth) ─────────────────────────────────────────────────────────
app.use(healthRouter);

// ── OIDC login endpoints (no auth — these ARE the login step) ─────────────────
// /auth/config, /auth/exchange, /auth/logout. The UI nginx routes /auth/* to the
// Core directly (bypassing the compliance proxy, which only gates /api).
app.use(authRouter);

// ── Auth middleware for all /api/* routes ────────────────────────────────────
app.use('/api', authMiddleware as express.RequestHandler);

// Post-auth rate limiters: keyed on verified req.user.id (not on a spoofable
// header). generalLimiter already ran pre-auth as a blunt IP guard; these two
// enforce per-identity budgets for reads and mutations separately.
app.use('/api', perUserLimiter);
app.use('/api', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return (mutationLimiter as express.RequestHandler)(req, res, next);
  }
  next();
});

// ── API routers ──────────────────────────────────────────────────────────────
app.use(usersRouter);
app.use(cyclesRouter);
app.use(questionsRouter);
app.use(responsesRouter);
app.use(attachmentsRouter);
app.use(validationsRouter);
app.use(reportingRouter);
app.use(auditRouter);
app.use(notificationsRouter);
app.use(groupMappingsRouter);

// ── Serve built client (production / single-server mode) ─────────────────────
const clientDist = path.resolve(__dirname, '../client/dist');
app.use(express.static(clientDist, { index: false }));
app.get(/^(?!\/api|\/auth|\/uploads).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.listen(PORT, () => {
  // Azure SQL: describe the connection target without exposing the password.
  const database = `${process.env.DB_AUTH === 'msi' ? 'msi' : (process.env.DB_USER || 'sa')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '1433'}/${process.env.DB_NAME || 'ccl'}`;

  logger.info(
    { port: PORT, database },
    'COMPASS - Compliance Control Oversight Management, Process Assessment & Scoring System server started'
  );
});

export default app;
