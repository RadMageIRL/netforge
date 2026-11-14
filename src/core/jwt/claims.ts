/**
 * Reading a JWT's claims: what each registered claim means, the times in exp, nbf and iat, and
 * checks against the clock and against values the user expects. A claim check says only what the
 * token states; it is never evidence that the token is genuine.
 */

export interface ClaimRow {
  readonly name: string;
  /** The value as JSON text. */
  readonly value: string;
  /** What the claim means, for names NetForge knows; null otherwise. */
  readonly meaning: string | null;
  /** For time claims with a usable value: the instant in ISO 8601 UTC. */
  readonly time: string | null;
  /** Set when the value does not have the type the specification requires. */
  readonly problem: string | null;
}

const MEANINGS: Readonly<Record<string, string>> = {
  iss: 'Issuer: who created and signed the token.',
  sub: 'Subject: who or what the token is about.',
  aud: 'Audience: who the token is meant for. A recipient that is not listed must reject it.',
  exp: 'Expiration time: the token must not be accepted at or after this moment.',
  nbf: 'Not before: the token must not be accepted before this moment.',
  iat: 'Issued at: when the token was created.',
  jti: 'JWT ID: a unique identifier for this token, used to stop replays.',
  scope: 'Scope: the permissions granted, as a space-separated list (OAuth 2.0).',
  scp: 'Scope: the permissions granted (a common non-standard spelling of "scope").',
  azp: 'Authorized party: the client the token was issued to (OpenID Connect).',
  nonce: 'Nonce: a value tying the token to one sign-in request (OpenID Connect).',
  auth_time: 'Authentication time: when the user last signed in (OpenID Connect).',
  client_id: 'Client ID: the OAuth 2.0 client that requested the token.',
  acr: 'Authentication context class: how strongly the user was authenticated (OpenID Connect).',
  amr: 'Authentication methods: how the user signed in, such as password or one-time code (OpenID Connect).',
  sid: 'Session ID (OpenID Connect).',
  name: 'Full name of the user (OpenID Connect).',
  email: 'Email address of the user (OpenID Connect).',
  email_verified: 'Whether the issuer has verified the email address (OpenID Connect).',
  roles: 'Roles: not a registered claim; its meaning is up to the issuer.',
  groups: 'Groups: not a registered claim; its meaning is up to the issuer.',
};

const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat', 'auth_time']);
/** NumericDate values outside years 0001 to 9999 cannot be shown as dates. */
const MIN_SECONDS = -62_135_596_800;
const MAX_SECONDS = 253_402_300_799;

function isoSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) return null;
  const ms = Math.floor(seconds * 1000);
  const iso = new Date(ms).toISOString();
  return ms % 1000 === 0 ? iso.replace('.000Z', 'Z') : iso;
}

function isStringOrUri(value: unknown): value is string {
  return typeof value === 'string';
}

function typeProblem(name: string, value: unknown): string | null {
  if (TIME_CLAIMS.has(name)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())
        ? 'Must be a JSON number of seconds since 1970-01-01T00:00:00Z, but this is a string. Strict verifiers reject it.'
        : 'Must be a JSON number of seconds since 1970-01-01T00:00:00Z.';
    }
    if (isoSeconds(value) === null) return 'Outside the range of dates (years 0001 to 9999).';
    if (value > 100_000_000_000) return 'Very large for a time in seconds. The issuer may have written milliseconds, which verifiers read as a date far in the future.';
    return null;
  }
  if (name === 'iss' || name === 'sub' || name === 'jti') return isStringOrUri(value) ? null : 'Must be a string.';
  if (name === 'aud') {
    if (isStringOrUri(value)) return null;
    return Array.isArray(value) && value.every(isStringOrUri) ? null : 'Must be a string or an array of strings.';
  }
  return null;
}

export function describeClaims(claims: Readonly<Record<string, unknown>>): ClaimRow[] {
  return Object.keys(claims).map(name => {
    const value = claims[name];
    const problem = typeProblem(name, value);
    return {
      name,
      value: JSON.stringify(value) ?? 'undefined',
      meaning: Object.hasOwn(MEANINGS, name) ? MEANINGS[name] : null,
      time: TIME_CLAIMS.has(name) && typeof value === 'number' && problem === null ? isoSeconds(value) : null,
      problem,
    };
  });
}

/** "3 days 4 hours", "42 seconds": the two largest units of a duration. */
export function formatDuration(totalSeconds: number): string {
  let rest = Math.floor(Math.abs(totalSeconds));
  if (rest === 0) return '0 seconds';
  const units: [string, number][] = [['year', 31_536_000], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    if (parts.length === 2) break;
    if (parts.length === 1 && n === 0) break;
  }
  return parts.join(' ');
}

export type CheckId = 'exp' | 'nbf' | 'iat' | 'iss' | 'aud';
/** pass and fail are verdicts; absent means the claim is missing; invalid means it is malformed; note is informational. */
export type CheckOutcome = 'pass' | 'fail' | 'absent' | 'invalid' | 'note';

export interface ClaimCheck {
  readonly id: CheckId;
  readonly outcome: CheckOutcome;
  readonly message: string;
}

export interface CheckOptions {
  readonly nowMs: number;
  /** Allowance for clock differences, in seconds, applied to exp and nbf. */
  readonly leewaySeconds?: number;
  /** When given (non-empty), iss must equal it exactly. */
  readonly expectedIssuer?: string;
  /** When given (non-empty), aud must be it or contain it. */
  readonly expectedAudience?: string;
}

export const MAX_LEEWAY_SECONDS = 3600;

/**
 * Checks the time claims against `nowMs`, and iss and aud against expected values when given.
 * exp: valid while now is before exp (plus leeway). nbf: valid once now reaches nbf (minus leeway).
 * iat is reported, and flagged when it lies in the future; RFC 7519 defines no rejection rule for it.
 */
export function checkClaims(claims: Readonly<Record<string, unknown>>, options: CheckOptions): ClaimCheck[] {
  const now = options.nowMs / 1000;
  const leeway = Math.min(Math.max(options.leewaySeconds ?? 0, 0), MAX_LEEWAY_SECONDS);
  const checks: ClaimCheck[] = [];
  const time = (name: 'exp' | 'nbf' | 'iat'): number | 'absent' | 'invalid' => {
    if (!Object.hasOwn(claims, name)) return 'absent';
    const v = claims[name];
    return typeof v === 'number' && isoSeconds(v) !== null ? v : 'invalid';
  };

  const exp = time('exp');
  if (exp === 'absent') checks.push({ id: 'exp', outcome: 'absent', message: 'No expiration time (exp): the token never expires on its own.' });
  else if (exp === 'invalid') checks.push({ id: 'exp', outcome: 'invalid', message: 'The expiration time (exp) is not a valid number of seconds, so it cannot be checked.' });
  else if (now < exp) checks.push({ id: 'exp', outcome: 'pass', message: `Not expired: expires ${isoSeconds(exp)}, in ${formatDuration(exp - now)}.` });
  else if (now < exp + leeway) checks.push({ id: 'exp', outcome: 'pass', message: `Expired ${formatDuration(now - exp)} ago (${isoSeconds(exp)}), but within the ${leeway}-second allowance for clock differences.` });
  else checks.push({ id: 'exp', outcome: 'fail', message: `Expired: the token stopped being valid at ${isoSeconds(exp)}, ${formatDuration(now - exp)} ago.` });

  const nbf = time('nbf');
  if (nbf === 'invalid') checks.push({ id: 'nbf', outcome: 'invalid', message: 'The not-before time (nbf) is not a valid number of seconds, so it cannot be checked.' });
  else if (nbf !== 'absent') {
    if (now >= nbf) checks.push({ id: 'nbf', outcome: 'pass', message: `Already valid: not-before was ${isoSeconds(nbf)}, ${formatDuration(now - nbf)} ago.` });
    else if (now >= nbf - leeway) checks.push({ id: 'nbf', outcome: 'pass', message: `Not valid until ${isoSeconds(nbf)}, in ${formatDuration(nbf - now)}, but within the ${leeway}-second allowance for clock differences.` });
    else checks.push({ id: 'nbf', outcome: 'fail', message: `Not valid yet: the token becomes valid at ${isoSeconds(nbf)}, in ${formatDuration(nbf - now)}.` });
  }

  const iat = time('iat');
  if (iat === 'invalid') checks.push({ id: 'iat', outcome: 'invalid', message: 'The issued-at time (iat) is not a valid number of seconds.' });
  else if (iat !== 'absent') {
    if (iat > now + leeway) checks.push({ id: 'iat', outcome: 'note', message: `Issued at ${isoSeconds(iat)}, which is ${formatDuration(iat - now)} in the future by this device's clock. Either a clock is wrong or the token is not what it claims.` });
    else checks.push({ id: 'iat', outcome: 'note', message: `Issued at ${isoSeconds(iat)}, ${formatDuration(now - iat)} ago.` });
  }

  const wantIssuer = options.expectedIssuer ?? '';
  if (wantIssuer !== '') {
    const iss = claims.iss;
    if (!Object.hasOwn(claims, 'iss')) checks.push({ id: 'iss', outcome: 'fail', message: 'The token has no issuer (iss), so it does not match the expected issuer.' });
    else if (typeof iss !== 'string') checks.push({ id: 'iss', outcome: 'invalid', message: 'The issuer (iss) is not a string.' });
    else if (iss === wantIssuer) checks.push({ id: 'iss', outcome: 'pass', message: 'The issuer (iss) is exactly the expected value.' });
    else checks.push({ id: 'iss', outcome: 'fail', message: `The issuer (iss) is ${JSON.stringify(iss)}, not the expected value. The comparison is exact: case, trailing slashes and all.` });
  }

  const wantAudience = options.expectedAudience ?? '';
  if (wantAudience !== '') {
    const aud = claims.aud;
    if (!Object.hasOwn(claims, 'aud')) checks.push({ id: 'aud', outcome: 'fail', message: 'The token has no audience (aud), so it is not addressed to the expected audience.' });
    else if (typeof aud === 'string') {
      checks.push(aud === wantAudience
        ? { id: 'aud', outcome: 'pass', message: 'The audience (aud) is exactly the expected value.' }
        : { id: 'aud', outcome: 'fail', message: `The audience (aud) is ${JSON.stringify(aud)}, not the expected value.` });
    } else if (Array.isArray(aud) && aud.every(a => typeof a === 'string')) {
      checks.push(aud.includes(wantAudience)
        ? { id: 'aud', outcome: 'pass', message: `The audience (aud) lists the expected value${aud.length > 1 ? `, among ${aud.length} audiences` : ''}.` }
        : { id: 'aud', outcome: 'fail', message: 'The audience (aud) does not list the expected value.' });
    } else checks.push({ id: 'aud', outcome: 'invalid', message: 'The audience (aud) is neither a string nor an array of strings.' });
  }
  return checks;
}

export type ClaimsVerdict = 'pass' | 'fail' | 'none';

/** fail if any check failed or was malformed; pass if at least one passed; none if nothing could be checked. */
export function claimsVerdict(checks: readonly ClaimCheck[]): ClaimsVerdict {
  if (checks.some(c => c.outcome === 'fail' || c.outcome === 'invalid')) return 'fail';
  return checks.some(c => c.outcome === 'pass') ? 'pass' : 'none';
}
