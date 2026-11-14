/** JWT claims: meanings, times, type problems and the checks against the clock and expected values. */
import { describe, expect, it } from 'vitest';
import { checkClaims, claimsVerdict, describeClaims, formatDuration, MAX_LEEWAY_SECONDS, type CheckId, type CheckOutcome, type ClaimCheck } from '../../src/core/jwt/claims';

const T = 1_700_000_000; // 2023-11-14T22:13:20Z

function outcomes(claims: Record<string, unknown>, nowSeconds: number, extra: { leewaySeconds?: number; expectedIssuer?: string; expectedAudience?: string } = {}): Partial<Record<CheckId, CheckOutcome>> {
  const out: Partial<Record<CheckId, CheckOutcome>> = {};
  for (const c of checkClaims(claims, { nowMs: nowSeconds * 1000, ...extra })) out[c.id] = c.outcome;
  return out;
}

function row(claims: Record<string, unknown>, name: string) {
  const found = describeClaims(claims).find(r => r.name === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

describe('describeClaims', () => {
  it('lists every claim in order with its JSON value', () => {
    const rows = describeClaims({ iss: 'https://issuer.example', sub: 'user-1', aud: ['a', 'b'], custom: { deep: [1, null] }, flag: false, n: null });
    expect(rows.map(r => r.name)).toEqual(['iss', 'sub', 'aud', 'custom', 'flag', 'n']);
    expect(rows.map(r => r.value)).toEqual(['"https://issuer.example"', '"user-1"', '["a","b"]', '{"deep":[1,null]}', 'false', 'null']);
    expect(rows.every(r => r.problem === null)).toBe(true);
  });

  it('explains the registered claims and says nothing about unknown ones', () => {
    const rows = describeClaims({ iss: 'a', sub: 'b', aud: 'c', exp: T, nbf: T, iat: T, jti: 'd', scope: 'read', mine: 1, toString: 'x', constructor: 'y', __proto__: 'z' });
    const meaning = Object.fromEntries(rows.map(r => [r.name, r.meaning]));
    expect(meaning.iss).toContain('Issuer');
    expect(meaning.sub).toContain('Subject');
    expect(meaning.aud).toContain('Audience');
    expect(meaning.exp).toContain('Expiration');
    expect(meaning.nbf).toContain('Not before');
    expect(meaning.iat).toContain('Issued at');
    expect(meaning.jti).toContain('JWT ID');
    expect(meaning.scope).toContain('Scope');
    expect(meaning.mine).toBeNull();
    // Names every object inherits have no meaning attached.
    expect(meaning.toString).toBeNull();
    expect(meaning.constructor).toBeNull();
  });

  it('converts time claims to ISO 8601 UTC', () => {
    expect(row({ exp: T }, 'exp').time).toBe('2023-11-14T22:13:20Z');
    expect(row({ nbf: 0 }, 'nbf').time).toBe('1970-01-01T00:00:00Z');
    expect(row({ iat: 1300819380 }, 'iat').time).toBe('2011-03-22T18:43:00Z');
    expect(row({ auth_time: T + 0.5 }, 'auth_time').time).toBe('2023-11-14T22:13:20.500Z');
    expect(row({ exp: -1 }, 'exp').time).toBe('1969-12-31T23:59:59Z');
    expect(row({ exp: 100_000_000_000 }, 'exp').time).toBe('5138-11-16T09:46:40Z');
    expect(row({ exp: -62_135_596_800 }, 'exp').time).toBe('0001-01-01T00:00:00Z');
    // Only the time claims are read as times.
    expect(row({ sub: T }, 'sub').time).toBeNull();
    expect(row({ other: T }, 'other').time).toBeNull();
  });

  it('flags time claims that are not usable numbers', () => {
    for (const value of ['1700000000', ' 1700000000 ', '1700000000.5', '-5']) {
      const r = row({ exp: value }, 'exp');
      expect(r.time).toBeNull();
      expect(r.problem).toContain('string');
    }
    for (const value of ['tomorrow', '2023-11-14T22:13:20Z', null, true, [T], { t: T }]) {
      const r = row({ exp: value }, 'exp');
      expect(r.time).toBeNull();
      expect(r.problem).not.toBeNull();
      expect(r.problem).not.toContain('but this is a string');
    }
    for (const value of [Infinity, -Infinity, NaN]) {
      const r = row({ nbf: value }, 'nbf');
      expect(r.time).toBeNull();
      expect(r.problem).not.toBeNull();
    }
  });

  it('flags times outside years 0001 to 9999', () => {
    for (const value of [253_402_300_800, -62_135_596_801, 1e15, 1_700_000_000_000]) {
      const r = row({ exp: value }, 'exp');
      expect(r.time).toBeNull();
      expect(r.problem).toContain('range');
    }
  });

  it('flags values that look like milliseconds, and shows no date for them', () => {
    const r = row({ exp: 200_000_000_000 }, 'exp');
    expect(r.problem).toContain('milliseconds');
    expect(r.time).toBeNull();
    expect(row({ exp: 253_402_300_799 }, 'exp').problem).toContain('milliseconds');
    expect(row({ exp: 100_000_000_000 }, 'exp').problem).toBeNull();
    expect(row({ exp: 100_000_000_001 }, 'exp').problem).toContain('milliseconds');
  });

  it('checks the types of iss, sub, jti and aud', () => {
    for (const name of ['iss', 'sub', 'jti']) {
      expect(row({ [name]: 'x' }, name).problem).toBeNull();
      for (const value of [1, null, true, ['x'], {}]) expect(row({ [name]: value }, name).problem).toBe('Must be a string.');
    }
    expect(row({ aud: 'x' }, 'aud').problem).toBeNull();
    expect(row({ aud: ['x', 'y'] }, 'aud').problem).toBeNull();
    expect(row({ aud: [] }, 'aud').problem).toBeNull();
    for (const value of [1, null, ['x', 2], {}, [['x']]]) expect(row({ aud: value }, 'aud').problem).toBe('Must be a string or an array of strings.');
  });
});

describe('formatDuration', () => {
  it('uses the two largest units and stops at the first empty one', () => {
    const cases: [number, string][] = [
      [0, '0 seconds'], [0.9, '0 seconds'], [1, '1 second'], [59, '59 seconds'], [60, '1 minute'], [61, '1 minute 1 second'], [125, '2 minutes 5 seconds'],
      [3600, '1 hour'], [3605, '1 hour'], [3660, '1 hour 1 minute'], [86_400, '1 day'], [90_061, '1 day 1 hour'], [86_400 + 59, '1 day'],
      [31_536_000, '1 year'], [2 * 31_536_000 + 3 * 86_400 + 7, '2 years 3 days'], [31_536_000 + 3600, '1 year'],
      [-61, '1 minute 1 second'], [-1, '1 second'],
    ];
    for (const [seconds, text] of cases) expect([seconds, formatDuration(seconds)]).toEqual([seconds, text]);
  });
});

describe('expiration (exp)', () => {
  it('fails at exactly exp and passes one second, or one millisecond, before', () => {
    expect(outcomes({ exp: T }, T).exp).toBe('fail');
    expect(outcomes({ exp: T }, T + 1).exp).toBe('fail');
    expect(outcomes({ exp: T }, T - 1).exp).toBe('pass');
    expect(outcomes({ exp: T }, T - 0.001).exp).toBe('pass');
    expect(outcomes({ exp: T }, T + 0.001).exp).toBe('fail');
  });

  it('allows leeway after exp, up to but not including exp plus leeway', () => {
    const o = (now: number, leewaySeconds: number) => outcomes({ exp: T }, now, { leewaySeconds }).exp;
    expect(o(T, 30)).toBe('pass');
    expect(o(T + 29, 30)).toBe('pass');
    expect(o(T + 29.999, 30)).toBe('pass');
    expect(o(T + 30, 30)).toBe('fail');
    expect(o(T + 31, 30)).toBe('fail');
    expect(o(T - 1, 30)).toBe('pass');
  });

  it('says whether leeway was what saved the token', () => {
    const find = (now: number) => checkClaims({ exp: T }, { nowMs: now * 1000, leewaySeconds: 60 }).find(c => c.id === 'exp')!;
    expect(find(T - 10).message).toContain('Not expired');
    expect(find(T - 10).message).not.toContain('allowance');
    expect(find(T + 10).message).toContain('allowance');
    expect(find(T + 10).message).toContain('60-second');
    expect(find(T + 100).message).toContain('Expired');
    expect(find(T + 100).message).not.toContain('allowance');
  });

  it('clamps leeway to zero and to the maximum', () => {
    expect(MAX_LEEWAY_SECONDS).toBe(3600);
    expect(outcomes({ exp: T }, T, { leewaySeconds: -100 }).exp).toBe('fail');
    expect(outcomes({ exp: T }, T - 1, { leewaySeconds: -100 }).exp).toBe('pass');
    expect(outcomes({ exp: T }, T + 3599, { leewaySeconds: 1_000_000 }).exp).toBe('pass');
    expect(outcomes({ exp: T }, T + 3600, { leewaySeconds: 1_000_000 }).exp).toBe('fail');
    expect(outcomes({ exp: T }, T + 3599, { leewaySeconds: 3600 }).exp).toBe('pass');
  });

  it('reports a missing exp as absent and a malformed one as invalid', () => {
    expect(outcomes({}, T).exp).toBe('absent');
    expect(outcomes({ sub: 'x' }, T)).toEqual({ exp: 'absent' });
    for (const value of ['1700000000', null, true, NaN, Infinity, 1e15, [T]]) expect(outcomes({ exp: value }, T - 10).exp).toBe('invalid');
    // A claim that is only inherited does not count as present.
    expect(outcomes(Object.create({ exp: T + 100 }) as Record<string, unknown>, T).exp).toBe('absent');
  });

  it('accepts fractional seconds', () => {
    expect(outcomes({ exp: T + 0.5 }, T + 0.499).exp).toBe('pass');
    expect(outcomes({ exp: T + 0.5 }, T + 0.5).exp).toBe('fail');
  });
});

describe('not before (nbf)', () => {
  it('passes at exactly nbf and fails just before', () => {
    expect(outcomes({ nbf: T }, T).nbf).toBe('pass');
    expect(outcomes({ nbf: T }, T + 1).nbf).toBe('pass');
    expect(outcomes({ nbf: T }, T - 0.001).nbf).toBe('fail');
    expect(outcomes({ nbf: T }, T - 1).nbf).toBe('fail');
    // At the boundary the token is simply valid: no allowance is involved.
    const at = checkClaims({ nbf: T }, { nowMs: T * 1000, leewaySeconds: 30 }).find(c => c.id === 'nbf')!;
    expect(at.message).toContain('Already valid');
    expect(at.message).not.toContain('allowance');
  });

  it('allows leeway before nbf, down to and including nbf minus leeway', () => {
    const o = (now: number, leewaySeconds: number) => outcomes({ nbf: T }, now, { leewaySeconds }).nbf;
    expect(o(T - 1, 30)).toBe('pass');
    expect(o(T - 30, 30)).toBe('pass');
    expect(o(T - 30.001, 30)).toBe('fail');
    expect(o(T - 31, 30)).toBe('fail');
    const early = checkClaims({ nbf: T }, { nowMs: (T - 10) * 1000, leewaySeconds: 30 }).find(c => c.id === 'nbf')!;
    expect(early.message).toContain('allowance');
    const onTime = checkClaims({ nbf: T }, { nowMs: (T + 10) * 1000, leewaySeconds: 30 }).find(c => c.id === 'nbf')!;
    expect(onTime.message).not.toContain('allowance');
  });

  it('adds no check when nbf is missing and reports a malformed one as invalid', () => {
    expect('nbf' in outcomes({ exp: T }, T)).toBe(false);
    for (const value of ['1700000000', null, false, -Infinity]) expect(outcomes({ nbf: value }, T).nbf).toBe('invalid');
  });
});

describe('issued at (iat)', () => {
  it('is a note, never a verdict, and says when it lies in the future', () => {
    const find = (now: number, leewaySeconds = 0) => checkClaims({ iat: T }, { nowMs: now * 1000, leewaySeconds }).find(c => c.id === 'iat')!;
    expect(find(T + 100).outcome).toBe('note');
    expect(find(T + 100).message).not.toContain('future');
    expect(find(T).message).not.toContain('future');
    expect(find(T - 1).outcome).toBe('note');
    expect(find(T - 1).message).toContain('future');
    // Within the leeway it is not called out.
    expect(find(T - 30, 30).message).not.toContain('future');
    expect(find(T - 31, 30).message).toContain('future');
    // A negative leeway counts as none.
    expect(find(T + 50, -100).message).not.toContain('future');
    expect(find(T - 1, -100).message).toContain('future');
  });

  it('adds no check when iat is missing and reports a malformed one as invalid', () => {
    expect('iat' in outcomes({ exp: T }, T)).toBe(false);
    expect(outcomes({ iat: 'yesterday' }, T).iat).toBe('invalid');
  });
});

describe('expected issuer and audience', () => {
  it('checks neither unless a value is expected', () => {
    expect(outcomes({ iss: 'a', aud: 'b' }, T)).toEqual({ exp: 'absent' });
    expect(outcomes({ iss: 'a', aud: 'b' }, T, { expectedIssuer: '', expectedAudience: '' })).toEqual({ exp: 'absent' });
  });

  it('compares the issuer exactly', () => {
    const o = (iss: unknown, expectedIssuer: string) => outcomes({ iss }, T, { expectedIssuer }).iss;
    expect(o('https://issuer.example', 'https://issuer.example')).toBe('pass');
    expect(o('https://issuer.example/', 'https://issuer.example')).toBe('fail');
    expect(o('https://Issuer.example', 'https://issuer.example')).toBe('fail');
    expect(o('https://issuer.example', 'https://issuer.example ')).toBe('fail');
    expect(o('issuer', 'iss')).toBe('fail');
    expect(o(['https://issuer.example'], 'https://issuer.example')).toBe('invalid');
    expect(o(42, '42')).toBe('invalid');
    expect(outcomes({}, T, { expectedIssuer: 'x' }).iss).toBe('fail');
    expect(outcomes(Object.create({ iss: 'x' }) as Record<string, unknown>, T, { expectedIssuer: 'x' }).iss).toBe('fail');
  });

  it('compares a string audience exactly', () => {
    const o = (aud: unknown, expectedAudience: string) => outcomes({ aud }, T, { expectedAudience }).aud;
    expect(o('api', 'api')).toBe('pass');
    expect(o('API', 'api')).toBe('fail');
    expect(o('api2', 'api')).toBe('fail');
    expect(o('ap', 'api')).toBe('fail');
    expect(outcomes({}, T, { expectedAudience: 'api' }).aud).toBe('fail');
  });

  it('looks for the expected audience in an array', () => {
    const o = (aud: unknown, expectedAudience: string) => outcomes({ aud }, T, { expectedAudience }).aud;
    expect(o(['web', 'api'], 'api')).toBe('pass');
    expect(o(['api'], 'api')).toBe('pass');
    expect(o(['web', 'mobile'], 'api')).toBe('fail');
    expect(o(['web', 'apis'], 'api')).toBe('fail');
    expect(o([], 'api')).toBe('fail');
    expect(o(['api', 7], 'api')).toBe('invalid');
    expect(o({ api: true }, 'api')).toBe('invalid');
    expect(o(7, '7')).toBe('invalid');
    expect(o(null, 'null')).toBe('invalid');
  });
});

describe('claimsVerdict', () => {
  const check = (outcome: CheckOutcome): ClaimCheck => ({ id: 'exp', outcome, message: '' });

  it('fails on any failed or malformed check, passes when something passed, and is none otherwise', () => {
    expect(claimsVerdict([])).toBe('none');
    expect(claimsVerdict([check('absent')])).toBe('none');
    expect(claimsVerdict([check('note'), check('absent')])).toBe('none');
    expect(claimsVerdict([check('pass')])).toBe('pass');
    expect(claimsVerdict([check('absent'), check('pass'), check('note')])).toBe('pass');
    expect(claimsVerdict([check('pass'), check('fail')])).toBe('fail');
    expect(claimsVerdict([check('pass'), check('invalid')])).toBe('fail');
    expect(claimsVerdict([check('invalid')])).toBe('fail');
    expect(claimsVerdict([check('fail')])).toBe('fail');
  });

  it('gives the right verdict for whole tokens', () => {
    const verdict = (claims: Record<string, unknown>, now: number, extra = {}) => claimsVerdict(checkClaims(claims, { nowMs: now * 1000, ...extra }));
    expect(verdict({ exp: T + 60, nbf: T - 60, iat: T - 60 }, T)).toBe('pass');
    expect(verdict({ exp: T - 60, nbf: T - 120 }, T)).toBe('fail');
    expect(verdict({ exp: T + 60, nbf: T + 30 }, T)).toBe('fail');
    expect(verdict({ iat: T - 60 }, T)).toBe('none');
    expect(verdict({ exp: T + 60, iss: 'a' }, T, { expectedIssuer: 'b' })).toBe('fail');
    expect(verdict({ exp: T + 60, iss: 'a', aud: ['x'] }, T, { expectedIssuer: 'a', expectedAudience: 'x' })).toBe('pass');
    expect(verdict({ exp: String(T + 60) }, T)).toBe('fail');
  });
});
