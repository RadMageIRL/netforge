/**
 * JWT signature verification through the Web Crypto API (Node's implementation here).
 *
 * Published vectors: the RFC 7515 appendix A examples (A.1 HS256, A.2 RS256, A.3 ES256, A.4 ES512,
 * A.5 unsecured), with the RFC's own keys, public parts only. The strings below were extracted by
 * script from the RFC text as published by the RFC Editor, not typed by hand.
 *
 * Everything else is signed in the test with node:crypto's classic API (createHmac, sign), a
 * different code path from the Web Crypto verification under test.
 */
import { createHmac, generateKeyPairSync, sign as nodeSign, webcrypto, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeJwt, type DecodedJwt } from '../../src/core/jwt/jwt';
import { MIN_RSA_BITS, verifyJwt, type KeyInput, type VerifyOutcome, type VerifySubtle } from '../../src/core/jwt/verify';
import { rng } from '../helpers';

const subtle = webcrypto.subtle as unknown as VerifySubtle;

const RFC = {
  a1Token: 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  a1Key: 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow',
  a2Token: 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw',
  a2Jwk: { kty: 'RSA', n: 'ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ', e: 'AQAB' },
  a3Token: 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q',
  a3Jwk: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' },
  a4Token: 'eyJhbGciOiJFUzUxMiJ9.UGF5bG9hZA.AdwMgeerwtHoh-l192l60hp9wAHZFVJbLfD_UxMi70cwnZOYaRI1bKPWROc-mZZqwqT2SI-KGDKB34XO0aw_7XdtAG8GaSwFKdCAPZgoXD2YBJZCPEX3xKpRwcdOO8KpEHwJjyqOgzDO7iKvU8vcnwNrmxYbSW9ERBXukOXolLzeO_Jn',
  a4Jwk: { kty: 'EC', crv: 'P-521', x: 'AekpBQ8ST8a8VcfVOTNl353vSrDCLLJXmPk06wTjxrrjcBpXp5EOnYG_NjFZ6OvLFV1jSfS9tsz4qUxcWceqwQGk', y: 'ADSmRA43Z1DSNx_RvcLI87cdL07l6jQyyBXMoxVg_l2Th-x3S1WDhjDly79ajL4Kkd0AZMaZmh9ubmf63e3kyMj2' },
  a5Token: 'eyJhbGciOiJub25lIn0.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.',
};

type Alg = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';
const HS_ALGS = ['HS256', 'HS384', 'HS512'] as const;
const RS_ALGS = ['RS256', 'RS384', 'RS512'] as const;
const ES_ALGS = ['ES256', 'ES384', 'ES512'] as const;
const HASH: Record<Alg, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512', RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512' };
const CURVE = { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' } as const;

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa1024 = generateKeyPairSync('rsa', { modulusLength: 1024 });
const ec = {
  'P-256': generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  'P-384': generateKeyPairSync('ec', { namedCurve: 'secp384r1' }),
  'P-521': generateKeyPairSync('ec', { namedCurve: 'secp521r1' }),
} as const;
const ecOther = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SECRET = Buffer.from('a-test-secret-that-is-long-enough-for-every-hmac-size-0123456789-0123456789');

const b64u = (data: string | Uint8Array) => Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
const pemOf = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }) as string;
const jwkOf = (key: KeyObject) => key.export({ format: 'jwk' }) as Record<string, unknown>;
const jwkText = (key: KeyObject, extra: Record<string, unknown> = {}) => JSON.stringify({ ...jwkOf(key), ...extra });
const secret = (bytes: Uint8Array = SECRET): KeyInput => ({ kind: 'secret', format: 'hex', text: Buffer.from(bytes).toString('hex') });
const pub = (text: string): KeyInput => ({ kind: 'public', text });

/** The raw signature bytes for `alg` over `data`, made with node:crypto's classic API. */
function rawSignature(alg: Alg, data: string, key: Uint8Array | KeyObject): Buffer {
  if (alg.startsWith('HS')) return createHmac(HASH[alg], key as Uint8Array).update(data).digest();
  if (alg.startsWith('RS')) return nodeSign(HASH[alg], Buffer.from(data), key as KeyObject);
  return nodeSign(HASH[alg], Buffer.from(data), { key: key as KeyObject, dsaEncoding: 'ieee-p1363' });
}

function signToken(alg: Alg, key: Uint8Array | KeyObject, payload: unknown = { sub: 'user-1', exp: 2_000_000_000 }, headerExtra: Record<string, unknown> = {}): string {
  const input = `${b64u(JSON.stringify({ alg, typ: 'JWT', ...headerExtra }))}.${b64u(typeof payload === 'string' ? payload : JSON.stringify(payload))}`;
  return `${input}.${b64u(rawSignature(alg, input, key))}`;
}

const privateFor = (alg: Alg): Uint8Array | KeyObject => (alg.startsWith('HS') ? SECRET : alg.startsWith('RS') ? rsa.privateKey : ec[CURVE[alg as 'ES256']].privateKey);
const publicFor = (alg: Alg): KeyObject => (alg.startsWith('RS') ? rsa.publicKey : ec[CURVE[alg as 'ES256']].publicKey);
const goodKey = (alg: Alg): KeyInput => (alg.startsWith('HS') ? secret() : pub(pemOf(publicFor(alg))));

function decode(token: string): DecodedJwt {
  const r = decodeJwt(token);
  if (!r.ok) throw new Error(`test token did not decode: ${r.error.code}`);
  return r.value;
}

async function verify(token: string, key: KeyInput): Promise<VerifyOutcome> {
  return verifyJwt(subtle, decode(token), key);
}

/** "verified", "failed", or the rejection code. */
async function result(token: string, key: KeyInput): Promise<string> {
  const o = await verify(token, key);
  return o.status === 'rejected' ? o.code : o.status;
}

/** The same, on a page that has no Web Crypto (plain HTTP). */
async function resultWithoutCrypto(token: string, key: KeyInput): Promise<string> {
  const o = await verifyJwt(undefined, decode(token), key);
  return o.status === 'rejected' ? o.code : o.status;
}

/** Replaces the signature segment with other bytes. */
function withSignature(token: string, signature: Uint8Array): string {
  return `${token.slice(0, token.lastIndexOf('.'))}.${b64u(signature)}`;
}

function signatureOf(token: string): Buffer {
  return Buffer.from(token.slice(token.lastIndexOf('.') + 1), 'base64url');
}

function flipped(token: string, index = 0): string {
  const sig = signatureOf(token);
  sig[index < 0 ? sig.length + index : index] ^= 0x01;
  return withSignature(token, sig);
}

describe('RFC 7515 appendix A examples', () => {
  it('A.1: HS256 with the RFC key', async () => {
    const o = await verify(RFC.a1Token, { kind: 'secret', format: 'base64', text: RFC.a1Key });
    expect(o).toEqual({ status: 'verified', alg: 'HS256', keySource: 'shared secret', warnings: [] });
    expect(decode(RFC.a1Token).claims).toEqual({ iss: 'joe', exp: 1300819380, 'http://example.com/is_root': true });
    expect(await result(flipped(RFC.a1Token), { kind: 'secret', format: 'base64', text: RFC.a1Key })).toBe('failed');
  });

  it('A.2: RS256 with the RFC public key', async () => {
    const o = await verify(RFC.a2Token, pub(JSON.stringify(RFC.a2Jwk)));
    expect(o).toEqual({ status: 'verified', alg: 'RS256', keySource: 'JWK (RSA)', warnings: [] });
    expect(await result(flipped(RFC.a2Token, -1), pub(JSON.stringify(RFC.a2Jwk)))).toBe('failed');
  });

  it('A.3: ES256 with the RFC public key', async () => {
    const o = await verify(RFC.a3Token, pub(JSON.stringify(RFC.a3Jwk)));
    expect(o).toEqual({ status: 'verified', alg: 'ES256', keySource: 'JWK (EC P-256)', warnings: [] });
    expect(await result(flipped(RFC.a3Token, 40), pub(JSON.stringify(RFC.a3Jwk)))).toBe('failed');
  });

  it('A.4: ES512 over a payload that is not JSON', async () => {
    const jwt = decode(RFC.a4Token);
    expect(jwt.payloadKind).toBe('text');
    expect(jwt.payloadText).toBe('Payload');
    expect(jwt.signature).toHaveLength(132);
    const o = await verifyJwt(subtle, jwt, pub(JSON.stringify(RFC.a4Jwk)));
    expect(o).toEqual({ status: 'verified', alg: 'ES512', keySource: 'JWK (EC P-521)', warnings: [] });
    expect(await result(flipped(RFC.a4Token, 100), pub(JSON.stringify(RFC.a4Jwk)))).toBe('failed');
  });

  it('A.5: the unsecured example is never verified, whatever key is offered', async () => {
    expect(decode(RFC.a5Token).signature).toHaveLength(0);
    expect(await result(RFC.a5Token, { kind: 'secret', format: 'base64', text: RFC.a1Key })).toBe('alg-none');
    expect(await result(RFC.a5Token, pub(JSON.stringify(RFC.a2Jwk)))).toBe('alg-none');
    expect(await result(RFC.a5Token, { kind: 'secret', format: 'text', text: '' })).toBe('alg-none');
  });

  it('the examples do not verify with each other\'s keys', async () => {
    expect(await result(RFC.a3Token, pub(JSON.stringify(jwkOf(ec['P-256'].publicKey))))).toBe('failed');
    expect(await result(RFC.a2Token, pub(pemOf(rsa.publicKey)))).toBe('failed');
    expect(await result(RFC.a1Token, secret())).toBe('failed');
  });
});

describe('all nine algorithms', () => {
  it('HS256, HS384 and HS512 verify with the secret as text, hex or Base64', async () => {
    const text = 'correct horse battery staple, long enough for sha-512: 0123456789 0123456789';
    for (const alg of HS_ALGS) {
      const token = signToken(alg, Buffer.from(text));
      for (const key of [
        { kind: 'secret', format: 'text', text },
        { kind: 'secret', format: 'hex', text: Buffer.from(text).toString('hex') },
        { kind: 'secret', format: 'base64', text: Buffer.from(text).toString('base64') },
        { kind: 'secret', format: 'base64', text: Buffer.from(text).toString('base64url') },
      ] as KeyInput[]) {
        expect(await verify(token, key)).toEqual({ status: 'verified', alg, keySource: 'shared secret', warnings: [] });
      }
      expect(await result(token, { kind: 'secret', format: 'text', text: `${text} ` })).toBe('failed');
      expect(await result(token, { kind: 'secret', format: 'text', text: text.toUpperCase() })).toBe('failed');
    }
  });

  it('RS256, RS384 and RS512 verify with the public key as PEM, PKCS#1 PEM or JWK', async () => {
    for (const alg of RS_ALGS) {
      const token = signToken(alg, rsa.privateKey);
      expect(await verify(token, pub(pemOf(rsa.publicKey)))).toEqual({ status: 'verified', alg, keySource: 'PEM (SubjectPublicKeyInfo)', warnings: [] });
      expect(await verify(token, pub(rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string))).toEqual({ status: 'verified', alg, keySource: 'PEM (PKCS#1 RSA public key)', warnings: [] });
      expect(await verify(token, pub(jwkText(rsa.publicKey)))).toEqual({ status: 'verified', alg, keySource: 'JWK (RSA)', warnings: [] });
      expect(await result(token, pub(pemOf(rsaOther.publicKey)))).toBe('failed');
      expect(await result(token, pub(jwkText(rsaOther.publicKey)))).toBe('failed');
    }
  });

  it('ES256, ES384 and ES512 verify with the public key as PEM or JWK', async () => {
    for (const alg of ES_ALGS) {
      const curve = CURVE[alg];
      const token = signToken(alg, ec[curve].privateKey);
      expect(decode(token).signature).toHaveLength({ 'P-256': 64, 'P-384': 96, 'P-521': 132 }[curve]);
      expect(await verify(token, pub(pemOf(ec[curve].publicKey)))).toEqual({ status: 'verified', alg, keySource: 'PEM (SubjectPublicKeyInfo)', warnings: [] });
      expect(await verify(token, pub(jwkText(ec[curve].publicKey)))).toEqual({ status: 'verified', alg, keySource: `JWK (EC ${curve})`, warnings: [] });
      const stranger = generateKeyPairSync('ec', { namedCurve: { 'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1' }[curve] }).publicKey;
      expect(await result(token, pub(pemOf(stranger)))).toBe('failed');
      expect(await result(token, pub(jwkText(stranger)))).toBe('failed');
    }
  });

  it('binds the hash to the algorithm name: a signature made with another hash fails', async () => {
    const forge = (alg: Alg, signedAs: Alg, key: KeyObject) => {
      const input = `${b64u(JSON.stringify({ alg }))}.${b64u('{"a":1}')}`;
      return `${input}.${b64u(rawSignature(signedAs, input, key).subarray(0))}`;
    };
    expect(await result(forge('RS256', 'RS256', rsa.privateKey), pub(pemOf(rsa.publicKey)))).toBe('verified');
    expect(await result(forge('RS384', 'RS256', rsa.privateKey), pub(pemOf(rsa.publicKey)))).toBe('failed');
    expect(await result(forge('RS256', 'RS512', rsa.privateKey), pub(pemOf(rsa.publicKey)))).toBe('failed');
    expect(await result(forge('RS512', 'RS384', rsa.privateKey), pub(jwkText(rsa.publicKey)))).toBe('failed');
  });
});

describe('a changed token fails', () => {
  it('for every algorithm: changed payload, changed header, changed signature', async () => {
    for (const alg of [...HS_ALGS, ...RS_ALGS, ...ES_ALGS]) {
      const token = signToken(alg, privateFor(alg), { sub: 'user-1', admin: false });
      const key = goodKey(alg);
      expect([alg, await result(token, key)]).toEqual([alg, 'verified']);
      const [h, , s] = token.split('.');
      expect([alg, await result(`${h}.${b64u(JSON.stringify({ sub: 'user-1', admin: true }))}.${s}`, key)]).toEqual([alg, 'failed']);
      expect([alg, await result(`${b64u(JSON.stringify({ alg, typ: 'JWT', kid: 'x' }))}.${token.split('.')[1]}.${s}`, key)]).toEqual([alg, 'failed']);
      // The same header and payload with different JSON spacing is a different signed text.
      expect([alg, await result(`${b64u(JSON.stringify({ alg, typ: 'JWT' }, null, 1))}.${token.split('.')[1]}.${s}`, key)]).toEqual([alg, 'failed']);
      for (const index of [0, 1, -1]) expect([alg, index, await result(flipped(token, index), key)]).toEqual([alg, index, 'failed']);
      const sig = signatureOf(token);
      expect([alg, await result(withSignature(token, new Uint8Array(sig.length)), key)]).toEqual([alg, 'failed']);
      expect([alg, await result(withSignature(token, new Uint8Array(sig.length).fill(0xff)), key)]).toEqual([alg, 'failed']);
    }
  });

  it('never reports verified for any single-character change to a token', async () => {
    const random = rng(20261114);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (const alg of ['HS256', 'RS256', 'ES256', 'ES512'] as const) {
      const token = signToken(alg, privateFor(alg));
      const key = goodKey(alg);
      let checked = 0;
      for (let i = 0; i < 60; i++) {
        const at = Math.floor(random() * token.length);
        if (token[at] === '.') continue;
        let ch = alphabet[Math.floor(random() * 64)];
        if (ch === token[at]) ch = ch === 'A' ? 'B' : 'A';
        const changed = token.slice(0, at) + ch + token.slice(at + 1);
        const decoded = decodeJwt(changed);
        // Either the structure is refused outright, or the signature check does not pass.
        const status = decoded.ok ? (await verifyJwt(subtle, decoded.value, key)).status : 'not-decoded';
        expect([alg, at, status === 'verified']).toEqual([alg, at, false]);
        checked++;
      }
      expect(checked).toBeGreaterThan(40);
    }
  });
});

describe('algorithms that are never verified', () => {
  const fake = (header: Record<string, unknown>, signature: Uint8Array = new Uint8Array(32)) => `${b64u(JSON.stringify(header))}.${b64u('{"sub":"admin"}')}.${b64u(signature)}`;

  it('alg none, with or without a signature, with any key', async () => {
    for (const token of [fake({ alg: 'none' }, new Uint8Array(0)), fake({ alg: 'none' }), fake({ alg: 'none', typ: 'JWT' })]) {
      expect(await result(token, secret())).toBe('alg-none');
      expect(await result(token, pub(pemOf(rsa.publicKey)))).toBe('alg-none');
      expect(await resultWithoutCrypto(token, secret())).toBe('alg-none');
    }
  });

  it('spellings of none are unsupported algorithms, never accepted', async () => {
    for (const alg of ['None', 'NONE', 'nOnE', 'none ']) expect([alg, await result(fake({ alg }, new Uint8Array(0)), secret())]).toEqual([alg, 'alg-unsupported']);
  });

  it('unsupported and misspelled algorithms', async () => {
    for (const alg of ['PS256', 'PS384', 'PS512', 'EdDSA', 'Ed25519', 'ES256K', 'hs256', 'Hs256', 'rs256', 'HS257', 'RSA-OAEP', 'dir', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect([alg, await result(fake({ alg }), secret())]).toEqual([alg, 'alg-unsupported']);
      expect([alg, await result(fake({ alg }), pub(pemOf(rsa.publicKey)))]).toEqual([alg, 'alg-unsupported']);
    }
  });

  it('a correctly signed token under a wrong-case name is still refused', async () => {
    const input = `${b64u('{"alg":"hs256"}')}.${b64u('{"a":1}')}`;
    const token = `${input}.${b64u(rawSignature('HS256', input, SECRET))}`;
    expect(await result(token, secret())).toBe('alg-unsupported');
  });
});

describe('critical extensions', () => {
  it('refuses a correctly signed token that has a crit header', async () => {
    for (const alg of ['HS256', 'RS256', 'ES256'] as const) {
      expect(await result(signToken(alg, privateFor(alg), { a: 1 }, { crit: ['exp'], exp: 2_000_000_000 }), goodKey(alg))).toBe('critical-header');
      expect(await result(signToken(alg, privateFor(alg), { a: 1 }, { crit: [] }), goodKey(alg))).toBe('critical-header');
      expect(await result(signToken(alg, privateFor(alg), { a: 1 }, { crit: null }), goodKey(alg))).toBe('critical-header');
    }
  });

  it('refuses the unencoded-payload option (b64 false) even without crit', async () => {
    expect(await result(signToken('HS256', SECRET, { a: 1 }, { b64: false }), secret())).toBe('critical-header');
    expect(await result(signToken('HS256', SECRET, { a: 1 }, { b64: false, crit: ['b64'] }), secret())).toBe('critical-header');
    // b64 true is the default behavior and changes nothing.
    expect(await result(signToken('HS256', SECRET, { a: 1 }, { b64: true }), secret())).toBe('verified');
  });
});

describe('the key must be of the type the algorithm uses', () => {
  it('an HMAC token is never checked with a public key', async () => {
    for (const alg of HS_ALGS) {
      const token = signToken(alg, SECRET);
      for (const key of [pemOf(rsa.publicKey), jwkText(rsa.publicKey), pemOf(ec['P-256'].publicKey), jwkText(ec['P-256'].publicKey), '', 'not a key']) {
        expect([alg, await result(token, pub(key))]).toEqual([alg, 'key-type-mismatch']);
      }
    }
  });

  it('a public-key token is never checked with a shared secret', async () => {
    for (const alg of [...RS_ALGS, ...ES_ALGS]) {
      const token = signToken(alg, privateFor(alg));
      expect([alg, await result(token, secret())]).toEqual([alg, 'key-type-mismatch']);
      expect([alg, await result(token, { kind: 'secret', format: 'text', text: pemOf(publicFor(alg)) })]).toEqual([alg, 'key-type-mismatch']);
      expect([alg, await result(token, { kind: 'secret', format: 'text', text: '' })]).toEqual([alg, 'key-type-mismatch']);
    }
  });

  it('an RSA key is refused for ES tokens and an EC key for RS tokens', async () => {
    for (const alg of ES_ALGS) {
      const token = signToken(alg, privateFor(alg));
      expect([alg, await result(token, pub(pemOf(rsa.publicKey)))]).toEqual([alg, 'key-type-mismatch']);
      expect([alg, await result(token, pub(jwkText(rsa.publicKey)))]).toEqual([alg, 'key-type-mismatch']);
      expect([alg, await result(token, pub(rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string))]).toEqual([alg, 'key-type-mismatch']);
    }
    for (const alg of RS_ALGS) {
      const token = signToken(alg, rsa.privateKey);
      for (const curve of ['P-256', 'P-384', 'P-521'] as const) {
        expect([alg, curve, await result(token, pub(pemOf(ec[curve].publicKey)))]).toEqual([alg, curve, 'key-type-mismatch']);
        expect([alg, curve, await result(token, pub(jwkText(ec[curve].publicKey)))]).toEqual([alg, curve, 'key-type-mismatch']);
      }
    }
  });

  it('an EC key on another curve is refused', async () => {
    for (const alg of ES_ALGS) {
      const token = signToken(alg, privateFor(alg));
      for (const curve of ['P-256', 'P-384', 'P-521'] as const) {
        const expected = curve === CURVE[alg] ? 'verified' : 'curve-mismatch';
        expect([alg, curve, await result(token, pub(pemOf(ec[curve].publicKey)))]).toEqual([alg, curve, expected]);
        expect([alg, curve, await result(token, pub(jwkText(ec[curve].publicKey)))]).toEqual([alg, curve, expected]);
      }
    }
  });

  it('key problems are reported by their own codes', async () => {
    const rs = signToken('RS256', rsa.privateKey);
    expect(await result(rs, pub(''))).toBe('key-empty');
    expect(await result(rs, pub(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string))).toBe('key-private');
    expect(await result(rs, pub(JSON.stringify(jwkOf(rsa.privateKey))))).toBe('key-private');
    expect(await result(rs, pub('https://issuer.example/jwks.json'))).toBe('key-format');
    expect(await result(rs, pub(pemOf(generateKeyPairSync('ed25519').publicKey)))).toBe('key-unsupported');
    expect(await result(rs, pub('{"kty":"RSA"}'))).toBe('key-jwk');
    expect(await result(rs, pub(pemOf(rsa.publicKey).replace('END PUBLIC', 'END RSA PUBLIC')))).toBe('key-pem');
    const hs = signToken('HS256', SECRET);
    expect(await result(hs, { kind: 'secret', format: 'text', text: '' })).toBe('key-empty');
    expect(await result(hs, { kind: 'secret', format: 'hex', text: 'xyz' })).toBe('key-encoding');
  });

  it('a key the browser cannot import is a rejection, not an exception', async () => {
    const token = signToken('ES256', ec['P-256'].privateKey);
    // A point that is not on the curve.
    const jwk = jwkOf(ec['P-256'].publicKey);
    const x = Buffer.from(jwk.x as string, 'base64url');
    x[31] ^= 0x01;
    expect(await result(token, pub(JSON.stringify({ ...jwk, x: x.toString('base64url') })))).toBe('key-import');
    const der = Buffer.from(ec['P-256'].publicKey.export({ type: 'spki', format: 'der' }));
    der[der.length - 1] ^= 0x01;
    const body = der.toString('base64');
    expect(await result(token, pub(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`))).toBe('key-import');
  });
});

describe('what a JWK says about its own use', () => {
  it('use must be sig when present', async () => {
    const token = signToken('RS256', rsa.privateKey);
    expect(await result(token, pub(jwkText(rsa.publicKey, { use: 'sig' })))).toBe('verified');
    expect(await result(token, pub(jwkText(rsa.publicKey, { use: 'enc' })))).toBe('key-use');
    expect(await result(token, pub(jwkText(rsa.publicKey, { use: 'SIG' })))).toBe('key-use');
    expect(await result(token, pub(jwkText(rsa.publicKey, { use: '' })))).toBe('key-use');
    const es = signToken('ES384', ec['P-384'].privateKey);
    expect(await result(es, pub(jwkText(ec['P-384'].publicKey, { use: 'enc' })))).toBe('key-use');
  });

  it('key_ops must include verify when present', async () => {
    const token = signToken('ES256', ec['P-256'].privateKey);
    expect(await result(token, pub(jwkText(ec['P-256'].publicKey, { key_ops: ['verify'] })))).toBe('verified');
    expect(await result(token, pub(jwkText(ec['P-256'].publicKey, { key_ops: ['sign', 'verify'] })))).toBe('verified');
    expect(await result(token, pub(jwkText(ec['P-256'].publicKey, { key_ops: ['sign'] })))).toBe('key-use');
    expect(await result(token, pub(jwkText(ec['P-256'].publicKey, { key_ops: [] })))).toBe('key-use');
    expect(await result(token, pub(jwkText(ec['P-256'].publicKey, { key_ops: ['encrypt', 'wrapKey'] })))).toBe('key-use');
  });

  it('alg must equal the token\'s algorithm when present', async () => {
    const token = signToken('RS256', rsa.privateKey);
    expect(await result(token, pub(jwkText(rsa.publicKey, { alg: 'RS256' })))).toBe('verified');
    expect(await result(token, pub(jwkText(rsa.publicKey, { alg: 'RS384' })))).toBe('key-alg');
    expect(await result(token, pub(jwkText(rsa.publicKey, { alg: 'PS256' })))).toBe('key-alg');
    expect(await result(token, pub(jwkText(rsa.publicKey, { alg: 'rs256' })))).toBe('key-alg');
    expect(await result(token, pub(jwkText(rsa.publicKey, { alg: 'RSA-OAEP' })))).toBe('key-alg');
    const es = signToken('ES256', ec['P-256'].privateKey);
    expect(await result(es, pub(jwkText(ec['P-256'].publicKey, { alg: 'ES256' })))).toBe('verified');
    expect(await result(es, pub(jwkText(ec['P-256'].publicKey, { alg: 'ES384' })))).toBe('key-alg');
  });
});

describe('the signature must have the exact size the algorithm produces', () => {
  it('HMAC', async () => {
    const sizes = { HS256: 32, HS384: 48, HS512: 64 } as const;
    for (const alg of HS_ALGS) {
      const token = signToken(alg, SECRET);
      const sig = signatureOf(token);
      expect(sig).toHaveLength(sizes[alg]);
      for (const wrong of [sig.subarray(0, 0), sig.subarray(0, sig.length - 1), Buffer.concat([sig, Buffer.from([0])]), sig.subarray(0, 16), Buffer.concat([sig, sig])]) {
        expect([alg, wrong.length, await result(withSignature(token, wrong), secret())]).toEqual([alg, wrong.length, 'signature-malformed']);
      }
    }
    // A longer hash's output under a shorter algorithm's name, and the reverse.
    const input = `${b64u('{"alg":"HS256"}')}.${b64u('{"a":1}')}`;
    expect(await result(`${input}.${b64u(rawSignature('HS512', input, SECRET))}`, secret())).toBe('signature-malformed');
    const input512 = `${b64u('{"alg":"HS512"}')}.${b64u('{"a":1}')}`;
    expect(await result(`${input512}.${b64u(rawSignature('HS256', input512, SECRET))}`, secret())).toBe('signature-malformed');
  });

  it('RSA: as long as the modulus', async () => {
    for (const alg of RS_ALGS) {
      const token = signToken(alg, rsa.privateKey);
      const sig = signatureOf(token);
      expect(sig).toHaveLength(256);
      for (const wrong of [sig.subarray(0, 0), sig.subarray(0, 255), sig.subarray(1), Buffer.concat([Buffer.from([0]), sig]), Buffer.concat([sig, Buffer.from([0])])]) {
        expect([alg, wrong.length, await result(withSignature(token, wrong), pub(pemOf(rsa.publicKey)))]).toEqual([alg, wrong.length, 'signature-malformed']);
        expect([alg, wrong.length, await result(withSignature(token, wrong), pub(jwkText(rsa.publicKey)))]).toEqual([alg, wrong.length, 'signature-malformed']);
      }
    }
    // A signature from a key of another size.
    expect(await result(signToken('RS256', rsa1024.privateKey), pub(pemOf(rsa.publicKey)))).toBe('signature-malformed');
    expect(await result(signToken('RS256', rsa.privateKey), pub(pemOf(rsa1024.publicKey)))).toBe('signature-malformed');
  });

  it('ECDSA: two fixed-size numbers, never ASN.1 DER', async () => {
    for (const alg of ES_ALGS) {
      const key = ec[CURVE[alg]];
      const token = signToken(alg, key.privateKey);
      const sig = signatureOf(token);
      const input = token.slice(0, token.lastIndexOf('.'));
      const der = nodeSign(HASH[alg], Buffer.from(input), key.privateKey);
      expect(der[0]).toBe(0x30);
      expect(der.length).not.toBe(sig.length);
      for (const wrong of [der, sig.subarray(0, 0), sig.subarray(0, sig.length - 1), Buffer.concat([sig, Buffer.from([0])]), sig.subarray(0, sig.length / 2)]) {
        expect([alg, wrong.length, await result(withSignature(token, wrong), pub(pemOf(key.publicKey)))]).toEqual([alg, wrong.length, 'signature-malformed']);
        expect([alg, wrong.length, await result(withSignature(token, wrong), pub(jwkText(key.publicKey)))]).toEqual([alg, wrong.length, 'signature-malformed']);
      }
    }
    // A P-384 signature offered under ES256 with a P-256 key.
    const es384 = signatureOf(signToken('ES384', ec['P-384'].privateKey));
    expect(await result(withSignature(signToken('ES256', ec['P-256'].privateKey), es384), pub(pemOf(ec['P-256'].publicKey)))).toBe('signature-malformed');
  });
});

describe('when Web Crypto is not available', () => {
  it('reports that nothing was checked', async () => {
    for (const alg of ['HS256', 'RS256', 'ES256'] as const) {
      expect(await resultWithoutCrypto(signToken(alg, privateFor(alg)), goodKey(alg))).toBe('crypto-unavailable');
      // Nothing is claimed for a bad token either.
      expect(await resultWithoutCrypto(flipped(signToken(alg, privateFor(alg))), goodKey(alg))).toBe('crypto-unavailable');
    }
    // Refusals that need no cryptography still come first.
    expect(await resultWithoutCrypto(signToken('HS256', SECRET, { a: 1 }, { crit: ['x'] }), secret())).toBe('critical-header');
    expect(await resultWithoutCrypto(`${b64u('{"alg":"PS256"}')}.${b64u('{}')}.c2ln`, secret())).toBe('alg-unsupported');
  });
});

describe('algorithm confusion', () => {
  // The attack: a service expects RS256 and holds the issuer's public key. The attacker, who also
  // knows that public key, signs a token with HS256 using the public key's PEM text as the HMAC
  // secret. A verifier that picks its method from the token's alg then accepts the forgery.
  const publicPem = pemOf(rsa.publicKey);
  const forged = signToken('HS256', Buffer.from(publicPem), { sub: 'admin', admin: true });

  it('the forged token really does carry a valid HMAC under the public key bytes', () => {
    const input = forged.slice(0, forged.lastIndexOf('.'));
    expect(createHmac('sha256', publicPem).update(input).digest('base64url')).toBe(forged.split('.')[2]);
    expect(decode(forged).alg).toBe('HS256');
  });

  it('is rejected when the public key is supplied as a public key', async () => {
    expect(await result(forged, pub(publicPem))).toBe('key-type-mismatch');
    expect(await result(forged, pub(jwkText(rsa.publicKey)))).toBe('key-type-mismatch');
    expect(await result(forged, pub(rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string))).toBe('key-type-mismatch');
  });

  it('is rejected when the public key is supplied as the secret, in text, hex or Base64', async () => {
    expect(await result(forged, { kind: 'secret', format: 'text', text: publicPem })).toBe('key-confusion');
    expect(await result(forged, { kind: 'secret', format: 'hex', text: Buffer.from(publicPem).toString('hex') })).toBe('key-confusion');
    expect(await result(forged, { kind: 'secret', format: 'base64', text: Buffer.from(publicPem).toString('base64') })).toBe('key-confusion');
    expect(await result(forged, { kind: 'secret', format: 'base64', text: Buffer.from(publicPem).toString('base64url') })).toBe('key-confusion');
  });

  it('is rejected for the other PEM spellings and for a JWK used as the secret', async () => {
    for (const material of [publicPem.trim(), rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string, pemOf(ec['P-256'].publicKey), jwkText(rsa.publicKey)]) {
      const token = signToken('HS256', Buffer.from(material), { sub: 'admin' });
      expect(await result(token, { kind: 'secret', format: 'text', text: material })).toBe('key-confusion');
      expect(await result(token, { kind: 'secret', format: 'hex', text: Buffer.from(material).toString('hex') })).toBe('key-confusion');
      expect(await result(token, { kind: 'secret', format: 'base64', text: Buffer.from(material).toString('base64') })).toBe('key-confusion');
    }
  });

  it('holds for HS384 and HS512 too', async () => {
    for (const alg of ['HS384', 'HS512'] as const) {
      const token = signToken(alg, Buffer.from(publicPem));
      expect(await result(token, pub(publicPem))).toBe('key-type-mismatch');
      expect(await result(token, { kind: 'secret', format: 'text', text: publicPem })).toBe('key-confusion');
    }
  });
});

describe('weak keys are flagged without changing the result', () => {
  it('a secret shorter than the hash output', async () => {
    const sizes = { HS256: 32, HS384: 48, HS512: 64 } as const;
    for (const alg of HS_ALGS) {
      const short = Buffer.alloc(sizes[alg] - 1, 0x61);
      const exact = Buffer.alloc(sizes[alg], 0x61);
      const good = await verify(signToken(alg, short), secret(short));
      expect(good.status).toBe('verified');
      expect(good.status === 'verified' ? good.warnings : []).toHaveLength(1);
      expect(good.status === 'verified' ? good.warnings[0] : '').toContain(`${sizes[alg] - 1} bytes`);
      const wrong = await verify(signToken(alg, short), secret(Buffer.alloc(sizes[alg] - 1, 0x62)));
      expect(wrong.status).toBe('failed');
      expect(wrong.status === 'failed' ? wrong.warnings : []).toHaveLength(1);
      const fine = await verify(signToken(alg, exact), secret(exact));
      expect(fine).toEqual({ status: 'verified', alg, keySource: 'shared secret', warnings: [] });
    }
    const tiny = await verify(signToken('HS256', Buffer.from('x')), { kind: 'secret', format: 'text', text: 'x' });
    expect(tiny.status).toBe('verified');
    expect(tiny.status === 'verified' ? tiny.warnings[0] : '').toContain('1 bytes');
  });

  it('an RSA key under 2048 bits', async () => {
    expect(MIN_RSA_BITS).toBe(2048);
    const token = signToken('RS256', rsa1024.privateKey);
    const good = await verify(token, pub(pemOf(rsa1024.publicKey)));
    expect(good.status).toBe('verified');
    expect(good.status === 'verified' ? good.warnings : []).toHaveLength(1);
    expect(good.status === 'verified' ? good.warnings[0] : '').toContain('1024 bits');
    const viaJwk = await verify(token, pub(jwkText(rsa1024.publicKey)));
    expect(viaJwk.status === 'verified' ? viaJwk.warnings : []).toHaveLength(1);
    const wrong = await verify(flipped(token, 5), pub(pemOf(rsa1024.publicKey)));
    expect(wrong.status).toBe('failed');
    expect(wrong.status === 'failed' ? wrong.warnings : []).toHaveLength(1);
    const strong = await verify(signToken('RS256', rsa.privateKey), pub(pemOf(rsa.publicKey)));
    expect(strong.status === 'verified' ? strong.warnings : ['x']).toEqual([]);
  });
});

describe('choosing a key from a pasted JWK Set by kid', () => {
  const set = JSON.stringify({ keys: [
    { ...jwkOf(rsaOther.publicKey), kid: 'old' },
    { ...jwkOf(rsa.publicKey), kid: 'current' },
    { ...jwkOf(ec['P-256'].publicKey), kid: 'ec' },
    { ...jwkOf(ecOther.publicKey), kid: 'ec-other' },
  ] });

  it('uses the key the token names', async () => {
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'current' }), pub(set))).toBe('verified');
    expect(await result(signToken('RS256', rsaOther.privateKey, { a: 1 }, { kid: 'old' }), pub(set))).toBe('verified');
    expect(await result(signToken('ES256', ec['P-256'].privateKey, { a: 1 }, { kid: 'ec' }), pub(set))).toBe('verified');
  });

  it('does not try the other keys when the named one fails', async () => {
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'old' }), pub(set))).toBe('failed');
    expect(await result(signToken('ES256', ec['P-256'].privateKey, { a: 1 }, { kid: 'ec-other' }), pub(set))).toBe('failed');
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'ec' }), pub(set))).toBe('key-type-mismatch');
  });

  it('refuses when no key, or no single key, is named', async () => {
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'unknown' }), pub(set))).toBe('key-not-found');
    expect(await result(signToken('RS256', rsa.privateKey), pub(set))).toBe('key-not-found');
    // A kid that is not a string names nothing.
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 1 }), pub(set))).toBe('key-not-found');
  });

  it('a single pasted key is used whatever the token\'s kid says', async () => {
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'anything' }), pub(jwkText(rsa.publicKey, { kid: 'different' })))).toBe('verified');
    expect(await result(signToken('RS256', rsa.privateKey, { a: 1 }, { kid: 'anything' }), pub(pemOf(rsa.publicKey)))).toBe('verified');
  });

  it('a key embedded in the token header is never used', async () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signToken('RS256', attacker.privateKey, { sub: 'admin' }, { jwk: jwkOf(attacker.publicKey) });
    expect(decode(token).notes.join(' ')).toContain('"jwk"');
    expect(await result(token, pub(pemOf(rsa.publicKey)))).toBe('failed');
  });
});
