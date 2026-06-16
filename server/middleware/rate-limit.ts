import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

const skipLocalhost = (req: { ip?: string }) =>
  req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

// Key on the application user (X-User-Id in DISABLE_LOGIN mode) so each user gets
// their own budget — the Core sits behind the UI's nginx AND all corporate users
// may egress through one NAT IP, so an IP-only key would put everyone in one
// bucket and trip 429 for all (Known Issue #10). Fall back to IP when no user.
const keyByUser = (req: Request) =>
  (req.headers['x-user-id'] as string | undefined) || ipKeyGenerator(req.ip ?? '') || 'anon';

const MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 3000;

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  skip: skipLocalhost,
});

export const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.round(MAX * 0.5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  skip: skipLocalhost,
});
