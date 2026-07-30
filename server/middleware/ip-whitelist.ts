import net from 'net';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { IS_NON_PROD } from '../lib/appEnv';

// ── CIDR helpers ─────────────────────────────────────────────────────────────

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/** Strip IPv4-mapped IPv6 prefix so ::ffff:10.x.x.x is treated as 10.x.x.x */
function normalizeIP(raw: string): string {
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : raw;
}

function isInCIDR(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/');
  const prefix = parseInt(bits, 10);

  if (net.isIPv4(ip) && net.isIPv4(range)) {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
  }

  // Single-IP notation without a prefix (treat as /32 or /128)
  if (!bits) return ip === range;

  return false;
}

// ── Lazy init ─────────────────────────────────────────────────────────────────
// ALLOWED_IPS is read on the first request (not at module load) so that
// dotenv.config() in index.ts has already populated process.env before we check.

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

let initialized = false;
let checkEnabled = false;
let allowedCIDRs: string[] = [];

function init(): void {
  if (initialized) return;
  initialized = true;

  const rawAllowed = (process.env.ALLOWED_IPS ?? '').trim();
  allowedCIDRs = rawAllowed
    ? rawAllowed.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  checkEnabled = allowedCIDRs.length > 0;

  if (!checkEnabled) {
    if (IS_NON_PROD) {
      logger.warn('ALLOWED_IPS is not set — IP whitelist check is DISABLED (non-production environment)');
    } else {
      // Production with no whitelist configured: refuse to serve any request.
      throw new Error(
        'ALLOWED_IPS must be set in production. ' +
        'Set it to a comma-separated list of CIDR blocks for the NBG intranet ' +
        '(e.g. ALLOWED_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16).',
      );
    }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function ipWhitelistMiddleware(req: Request, res: Response, next: NextFunction): void {
  init();

  if (!checkEnabled) {
    return next();
  }

  const raw = req.ip ?? '';
  const ip = normalizeIP(raw);

  if (LOOPBACK.includes(raw) || LOOPBACK.includes(ip)) {
    return next();
  }

  const allowed = allowedCIDRs.some(cidr => isInCIDR(ip, cidr));

  if (!allowed) {
    logger.warn({ ip, path: req.path, method: req.method }, 'IP whitelist: blocked request');
    res.status(403).json({ error: 'Access restricted to internal network' });
    return;
  }

  next();
}
