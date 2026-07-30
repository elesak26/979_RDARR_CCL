/**
 * mailer — SMTP email sending for COMPASS.
 *
 * Mirrors the NBG pattern from the reference app (Nbg.AspNetCore.PMSAssistantUI:
 * SmtpClientWrapper + EmailService). Per-environment SMTP config comes from env
 * vars, so the same code runs everywhere and only the settings.*.json differ:
 *
 *   QA / PROD — internal NBG relay, no credentials. Authorisation is by NETWORK
 *               (the Core web app's outbound IP must be whitelisted to reach the
 *               relay). This is why email must leave from the Core, not the UI.
 *                 SMTP_HOST=10.32.52.20  SMTP_PORT=25  (no SMTP_USER/PASS)
 *   DEV       — either the same relay (if the DEV IP is whitelisted) or an
 *               external relay with credentials (SMTP_USER/SMTP_PASS, ideally a
 *               Key Vault reference — never plaintext).
 *
 * Sending is best-effort and MUST NOT be on a critical path: a relay outage or a
 * closed firewall should never fail the user's action. Callers get a boolean and
 * we log failures; we never throw out of sendMail.
 */
import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../logger';

const HOST = (process.env.SMTP_HOST || '').trim();
const PORT = parseInt(process.env.SMTP_PORT || '25', 10);
// Port 25 to the internal relay is plain/opportunistic-STARTTLS, not implicit TLS.
// Implicit TLS (465) → SMTP_SECURE=true. Default false.
const SECURE = (process.env.SMTP_SECURE || 'false').trim().toLowerCase() === 'true';
const USER = (process.env.SMTP_USER || '').trim();
const PASS = process.env.SMTP_PASS || '';
const FROM_ADDR = (process.env.SMTP_FROM || 'RDARRVU@nbg.gr').trim();
const FROM_NAME = (process.env.SMTP_FROM_NAME || 'COMPASS — RDARR').trim();

/** True when an SMTP host is configured. When false, sendMail is a logged no-op
 *  so environments without email (local, unconfigured) keep working. */
export function mailerEnabled(): boolean {
  return HOST.length > 0;
}

/** The "From" header, e.g. `COMPASS — RDARR <RDARRVU@nbg.gr>`. */
function fromHeader(): string {
  return FROM_NAME ? `${FROM_NAME} <${FROM_ADDR}>` : FROM_ADDR;
}

let _transport: Transporter | null = null;

/** Build (once) and return the transport. Credentials are attached only when
 *  SMTP_USER is set — the internal QA/PROD relay takes no auth (network-authorised),
 *  exactly like SmtpClientWrapper.CreateNewClient() in the reference app. */
function getTransport(): Transporter {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    // Do not force STARTTLS: the internal relay on :25 may not offer it. When a
    // cert is presented we do not fail on an internal/self-signed chain.
    requireTLS: false,
    tls: { rejectUnauthorized: false },
    auth: USER ? { user: USER, pass: PASS } : undefined,
  });
  return _transport;
}

export interface MailInput {
  to: string | string[];
  subject: string;
  /** Plain-text body. Provide this and/or `html`. */
  text?: string;
  /** Optional HTML body. */
  html?: string;
  /** Optional override of the default From. */
  from?: string;
}

/**
 * Send an email. Best-effort: returns true on success, false on failure or when
 * the mailer is not configured — never throws, so no caller's flow breaks on a
 * mail problem.
 */
export async function sendMail(input: MailInput): Promise<boolean> {
  if (!mailerEnabled()) {
    logger.info({ to: input.to, subject: input.subject }, 'mailer: SMTP not configured — skipping send');
    return false;
  }
  try {
    const info = await getTransport().sendMail({
      from: input.from || fromHeader(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    logger.info({ to: input.to, subject: input.subject, messageId: info.messageId }, 'mailer: email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: input.to, subject: input.subject }, 'mailer: failed to send email');
    return false;
  }
}

/** Verify the transport can reach the relay — for a health check or startup probe.
 *  Returns false (and logs) instead of throwing. */
export async function verifyMailer(): Promise<boolean> {
  if (!mailerEnabled()) return false;
  try {
    await getTransport().verify();
    return true;
  } catch (err) {
    logger.warn({ err, host: HOST, port: PORT }, 'mailer: transport verify failed');
    return false;
  }
}

/** Startup posture line — safe to log (no secrets). */
export function mailerPosture(): Record<string, unknown> {
  return {
    enabled: mailerEnabled(),
    host: HOST || null,
    port: mailerEnabled() ? PORT : null,
    secure: mailerEnabled() ? SECURE : null,
    auth: USER ? 'credentials' : 'network (no auth)',
    from: FROM_ADDR,
  };
}
