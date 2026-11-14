/**
 * Every case in tests/fixtures/jwt-oracle.json: tokens signed by the OpenSSL command line and by
 * Python's hmac (scripts/oracles/jwt_oracle.py), verified here through the Web Crypto API. One
 * program signs, another verifies, and NetForge has to agree with both about each outcome.
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJwt } from '../../src/core/jwt/jwt';
import { verifyJwt, type KeyInput, type VerifySubtle } from '../../src/core/jwt/verify';

interface OracleCase {
  readonly name: string;
  readonly token: string;
  readonly key: KeyInput;
  readonly expect: string;
}

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'jwt-oracle.json'), 'utf8')) as { signedBy: string; cases: OracleCase[] };
const subtle = webcrypto.subtle as unknown as VerifySubtle;

async function outcome(c: OracleCase): Promise<string> {
  const decoded = decodeJwt(c.token);
  if (!decoded.ok) return `decode:${decoded.error.code}`;
  const o = await verifyJwt(subtle, decoded.value, c.key);
  return o.status === 'rejected' ? o.code : o.status;
}

describe('JWT oracle (OpenSSL and Python hmac)', () => {
  it('has the cases it is meant to have', () => {
    const names = fixture.cases.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(70);
    expect(fixture.signedBy).toContain('OpenSSL');
    const count = (expected: string) => fixture.cases.filter(c => c.expect === expected).length;
    expect(count('verified')).toBeGreaterThanOrEqual(20);
    expect(count('failed')).toBeGreaterThanOrEqual(25);
    for (const code of ['key-type-mismatch', 'curve-mismatch', 'signature-malformed', 'key-confusion', 'alg-none', 'critical-header', 'alg-unsupported', 'key-use', 'key-alg', 'key-not-found']) {
      expect([code, count(code) > 0]).toEqual([code, true]);
    }
    // All nine algorithms have a token that must verify.
    const algs = new Set(fixture.cases.filter(c => c.expect === 'verified').map(c => {
      const d = decodeJwt(c.token);
      return d.ok ? d.value.alg : 'undecoded';
    }));
    expect([...algs].sort()).toEqual(['ES256', 'ES384', 'ES512', 'HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512']);
  });

  it('holds no private key material', () => {
    const text = JSON.stringify(fixture);
    expect(text).not.toContain('PRIVATE');
    for (const c of fixture.cases) {
      if (c.key.kind !== 'public' || !c.key.text.trim().startsWith('{')) continue;
      const jwk = JSON.parse(c.key.text) as { keys?: Record<string, unknown>[] } & Record<string, unknown>;
      for (const key of jwk.keys ?? [jwk]) expect(Object.keys(key).filter(name => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].includes(name))).toEqual([]);
    }
  });

  it('agrees with the reference on every case', async () => {
    const wrong: string[] = [];
    for (const c of fixture.cases) {
      const got = await outcome(c);
      if (got !== c.expect) wrong.push(`${c.name}: expected ${c.expect}, got ${got}`);
    }
    expect(wrong).toEqual([]);
  });

  it('reports verified for exactly the cases the reference signed correctly', async () => {
    const verified: string[] = [];
    for (const c of fixture.cases) if (await outcome(c) === 'verified') verified.push(c.name);
    expect(verified).toEqual(fixture.cases.filter(c => c.expect === 'verified').map(c => c.name));
  });
});
