/**
 * Which environment this instance is running as, and what that permits.
 *
 * NODE_ENV cannot answer this. Every deployment — DEV included — runs with
 * NODE_ENV=production because that is what switches Express, the logger and the
 * pool sizes into their non-development behaviour. Reading it as "this is the
 * production environment" would be wrong, and a guard built on it would refuse
 * to start on DEV.
 *
 * So the environment is declared separately, and only the non-production ones
 * are declared. Production is the default: an instance that says nothing about
 * itself is treated as production and refuses every authentication bypass. A
 * forgotten setting therefore breaks DEV, never opens production.
 */

/** Environments where the UAT persona model may be used. */
const NON_PROD = new Set(['local', 'dev', 'qa', 'uat', 'test']);

// APP_ENV and nothing else. An earlier version fell back to parsing the
// environment out of WEBSITE_SITE_NAME, which Azure injects and which carries
// the environment in the NBG naming convention. That was convenient — DEV needed
// no configuration at all — but it makes a security control depend on a naming
// convention rather than on a decision. It failed safe for a correctly named
// production app, yet any host that happened to contain -test- or -uat- would
// have permitted the bypass, and "we read the hostname" is not an answer that
// survives a security review. The environment is declared, or it is production.
export const APP_ENV = (process.env.APP_ENV || '').trim().toLowerCase();

/** True only when this instance has positively declared itself non-production. */
export const IS_NON_PROD = NON_PROD.has(APP_ENV);

/** Authentication is off entirely. Local development only. */
export const DISABLE_LOGIN = process.env.DISABLE_LOGIN === 'true';

/** Authentication is enforced, but the role still comes from the persona
 *  dropdown rather than from the token. */
export const UAT_PERSONA_MODE = process.env.UAT_PERSONA_MODE === 'true';

/**
 * Whether an X-User-Id header may choose the acting user.
 *
 * This is the header the security review asked about. It is the persona
 * dropdown's transport, so it is honoured exactly when a persona mode is on and
 * ignored otherwise — turning the persona modes off has to actually turn the
 * personas off, or "run QA without personas" would silently keep working for
 * anyone who had already picked one while locking out every fresh browser.
 *
 * With both flags off the acting user comes from the verified token alone, which
 * is the production posture: the header can no longer grant a role its bearer
 * was not assigned.
 */
export const PERSONA_HEADER_ALLOWED = DISABLE_LOGIN || UAT_PERSONA_MODE;

/**
 * Refuse to start if an authentication bypass is enabled outside a declared
 * non-production environment.
 *
 * Deliberately fatal rather than a warning. The commitment given to the security
 * review is that these mechanisms are not available in production; a log line
 * nobody reads is not that commitment, a process that will not boot is.
 */
export function assertBypassFlagsAllowed(): void {
  if (!DISABLE_LOGIN && !UAT_PERSONA_MODE) return; // production posture — nothing to check
  if (IS_NON_PROD) return;

  const enabled = [
    DISABLE_LOGIN ? 'DISABLE_LOGIN' : null,
    UAT_PERSONA_MODE ? 'UAT_PERSONA_MODE' : null,
  ].filter(Boolean).join(', ');

  throw new Error(
    `Refusing to start: ${enabled} is enabled but APP_ENV=` +
    `${JSON.stringify(process.env.APP_ENV ?? '')} does not declare a non-production ` +
    `environment. Set APP_ENV to one of: ${[...NON_PROD].join(', ')} — or unset the flag.`
  );
}
