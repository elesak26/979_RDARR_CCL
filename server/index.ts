import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '.env') });

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';

import { logger } from './logger';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { generalLimiter } from './middleware/rate-limit';

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

const app = express();

// ── Security & middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
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
    'RVMT — RDARR Validation Management Tool server started'
  );
});

export default app;
