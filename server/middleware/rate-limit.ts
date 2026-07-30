import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

const skipLocalhost = (req: { ip?: string }) =>
  req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

const MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000;

// IP-based limiter runs pre-auth (before authMiddleware sets req.user).
// Key on raw IP only — X-User-Id is an untrusted header at this point and
// must not be used as a limit key. The limit is generous because all corporate
// users share one NAT egress IP (Known Issue #10): this bucket is the
// DDoS/bot guard, not the per-user throttle.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? '') || 'unknown',
  skip: skipLocalhost,
});

// Per-verified-user limiter runs post-auth (after authMiddleware sets req.user).
// Keys on req.user.id so each authenticated identity gets its own budget and
// a spoofed X-User-Id cannot inflate the limit. Falls back to IP when called
// on an unprotected route (should not happen in normal usage).
export const perUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.round(MAX * 0.8),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id || ipKeyGenerator(req.ip ?? '') || 'anon',
  skip: skipLocalhost,
});

// Mutation limiter: POST / PUT / PATCH / DELETE operations within /api.
// Applied after auth so the key is the verified user identity.
export const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.round(MAX * 0.3),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id || ipKeyGenerator(req.ip ?? '') || 'anon',
  skip: skipLocalhost,
});
