/**
 * Key material for JWT verification. Real keys are generated here with node:crypto (OpenSSL), so
 * the PEM, DER and JWK forms NetForge has to read are produced by an independent implementation.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_KEY_CHARS, parsePublicKey, parseSecret, type PublicKey } from '../../src/core/jwt/keys';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = {
  'P-256': generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  'P-384': generateKeyPairSync('ec', { namedCurve: 'secp384r1' }),
  'P-521': generateKeyPairSync('ec', { namedCurve: 'secp521r1' }),
} as const;

const spkiPem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }) as string;
const spkiDer = (key: KeyObject) => new Uint8Array(key.export({ type: 'spki', format: 'der' }));
const jwkOf = (key: KeyObject) => key.export({ format: 'jwk' }) as Record<string, unknown>;

function pem(label: string, der: Uint8Array, endLabel = label): string {
  const body = Buffer.from(der).toString('base64').replace(/(.{64})/g, `$1${LF}`).trimEnd();
  return `-----BEGIN ${label}-----${LF}${body}${LF}-----END ${endLabel}-----${LF}`;
}

function key(text: string, kid?: string): PublicKey {
  const r = parsePublicKey(text, kid);
  if (!r.ok) throw new Error(`expected a key, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function keyError(text: string, kid?: string): string {
  const r = parsePublicKey(text, kid);
  return r.ok ? 'ok' : r.error.code;
}

function secretError(text: string, format: 'text' | 'hex' | 'base64'): string {
  const r = parseSecret(text, format);
  return r.ok ? 'ok' : r.error.code;
}

function secretBytes(text: string, format: 'text' | 'hex' | 'base64'): number[] {
  const r = parseSecret(text, format);
  if (!r.ok) throw new Error(`expected a secret, got ${r.error.code}`);
  return [...r.value];
}

describe('parseSecret', () => {
  it('reads text as UTF-8 exactly as typed, spaces included', () => {
    expect(secretBytes('secret', 'text')).toEqual([...Buffer.from('secret')]);
    expect(secretBytes(' pad ', 'text')).toEqual([0x20, 0x70, 0x61, 0x64, 0x20]);
    expect(secretBytes(' ', 'text')).toEqual([0x20]);
    const euro = String.fromCharCode(0x20ac);
    expect(secretBytes(euro, 'text')).toEqual([0xe2, 0x82, 0xac]);
    // Text that happens to look like hex or Base64 is still text.
    expect(secretBytes('00ff', 'text')).toEqual([0x30, 0x30, 0x66, 0x66]);
  });

  it('reads hex, ignoring only surrounding whitespace', () => {
    expect(secretBytes('00ff10', 'hex')).toEqual([0, 255, 16]);
    expect(secretBytes('  00FF10 ', 'hex')).toEqual([0, 255, 16]);
    expect(secretError('00 ff', 'hex')).toBe('key-encoding');
    expect(secretError('0xff', 'hex')).toBe('key-encoding');
    expect(secretError('abc', 'hex')).toBe('key-encoding');
    expect(secretError('zz', 'hex')).toBe('key-encoding');
  });

  it('reads Base64 in either alphabet, padded or not', () => {
    expect(secretBytes('AP8Q', 'base64')).toEqual([0, 255, 16]);
    expect(secretBytes('+/8=', 'base64')).toEqual([0xfb, 0xff]);
    expect(secretBytes('+/8', 'base64')).toEqual([0xfb, 0xff]);
    expect(secretBytes('-_8', 'base64')).toEqual([0xfb, 0xff]);
    expect(secretBytes('-_8=', 'base64')).toEqual([0xfb, 0xff]);
    expect(secretBytes(` AP8Q${LF}`, 'base64')).toEqual([0, 255, 16]);
    expect(secretError('-/8=', 'base64')).toBe('key-encoding');
    expect(secretError('AP8Q=', 'base64')).toBe('key-encoding');
    expect(secretError('AP!Q', 'base64')).toBe('key-encoding');
    expect(secretError('A', 'base64')).toBe('key-encoding');
    expect(secretError('AP 8Q', 'base64')).toBe('key-encoding');
  });

  it('refuses an empty secret', () => {
    expect(secretError('', 'text')).toBe('key-empty');
    expect(secretError('', 'hex')).toBe('key-empty');
    expect(secretError('   ', 'hex')).toBe('key-empty');
    expect(secretError('', 'base64')).toBe('key-empty');
    expect(secretError(`${LF} `, 'base64')).toBe('key-empty');
  });

  it('refuses text that cannot be UTF-8', () => {
    expect(secretError(`a${String.fromCharCode(0xd800)}b`, 'text')).toBe('key-encoding');
  });

  it('refuses an oversize secret', () => {
    expect(secretError('a'.repeat(MAX_KEY_CHARS + 1), 'text')).toBe('key-format');
    expect(secretError('a'.repeat(MAX_KEY_CHARS), 'text')).toBe('ok');
  });

  it('refuses a PEM key offered as the secret, in text', () => {
    expect(secretError(spkiPem(rsa.publicKey), 'text')).toBe('key-confusion');
    expect(secretError(spkiPem(rsa.publicKey).trim(), 'text')).toBe('key-confusion');
    expect(secretError(spkiPem(rsa.publicKey).split(LF).join(CRLF), 'text')).toBe('key-confusion');
    expect(secretError(spkiPem(ec['P-256'].publicKey), 'text')).toBe('key-confusion');
    expect(secretError(rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string, 'text')).toBe('key-confusion');
    expect(secretError(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'text')).toBe('key-confusion');
    expect(secretError(`junk before${LF}${spkiPem(rsa.publicKey)}`, 'text')).toBe('key-confusion');
    expect(secretError('-----BEGIN CERTIFICATE-----', 'text')).toBe('key-confusion');
  });

  it('refuses a PEM key hidden inside hex or Base64', () => {
    const text = spkiPem(rsa.publicKey);
    expect(secretError(Buffer.from(text).toString('hex'), 'hex')).toBe('key-confusion');
    expect(secretError(Buffer.from(text).toString('hex').toUpperCase(), 'hex')).toBe('key-confusion');
    expect(secretError(Buffer.from(text).toString('base64'), 'base64')).toBe('key-confusion');
    expect(secretError(Buffer.from(text).toString('base64url'), 'base64')).toBe('key-confusion');
    expect(secretError(Buffer.from(text.trim()).toString('base64'), 'base64')).toBe('key-confusion');
  });

  it('refuses a JWK or JWK Set offered as the secret, in any encoding', () => {
    const jwk = JSON.stringify(jwkOf(rsa.publicKey));
    expect(secretError(jwk, 'text')).toBe('key-confusion');
    expect(secretError(`  ${jwk}${LF}`, 'text')).toBe('key-confusion');
    expect(secretError(JSON.stringify(jwkOf(ec['P-256'].publicKey), null, 2), 'text')).toBe('key-confusion');
    expect(secretError(JSON.stringify({ keys: [jwkOf(rsa.publicKey)] }), 'text')).toBe('key-confusion');
    expect(secretError(Buffer.from(jwk).toString('hex'), 'hex')).toBe('key-confusion');
    expect(secretError(Buffer.from(jwk).toString('base64'), 'base64')).toBe('key-confusion');
  });

  it('accepts secrets that merely resemble keys', () => {
    expect(secretError('{"not":"a key"}', 'text')).toBe('ok');
    expect(secretError('{not json', 'text')).toBe('ok');
    expect(secretError('-----BEGIN-----', 'text')).toBe('ok');
    expect(secretError('BEGIN PUBLIC KEY', 'text')).toBe('ok');
    expect(secretError('["kty"]', 'text')).toBe('ok');
  });
});

describe('parsePublicKey: PEM', () => {
  it('reads an RSA SubjectPublicKeyInfo key and keeps its exact DER', () => {
    const k = key(spkiPem(rsa.publicKey));
    expect(k.format).toBe('spki');
    expect(k.family).toBe('RSA');
    expect(k.format === 'spki' ? [...k.der] : []).toEqual([...spkiDer(rsa.publicKey)]);
  });

  it('reads elliptic-curve keys on the three supported curves', () => {
    for (const curve of ['P-256', 'P-384', 'P-521'] as const) {
      const k = key(spkiPem(ec[curve].publicKey));
      expect(k.format).toBe('spki');
      expect(k.family).toBe('EC');
      expect(k.family === 'EC' ? k.curve : null).toBe(curve);
      expect(k.format === 'spki' ? [...k.der] : []).toEqual([...spkiDer(ec[curve].publicKey)]);
    }
  });

  it('wraps a PKCS#1 RSA public key into the same SubjectPublicKeyInfo OpenSSL writes', () => {
    const pkcs1 = rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    expect(pkcs1).toContain('BEGIN RSA PUBLIC KEY');
    const k = key(pkcs1);
    expect(k.family).toBe('RSA');
    expect(k.format === 'spki' ? [...k.der] : []).toEqual([...spkiDer(rsa.publicKey)]);
    // Other key sizes change the DER length encodings.
    for (const bits of [1024, 3072, 4096]) {
      const other = generateKeyPairSync('rsa', { modulusLength: bits }).publicKey;
      const wrapped = key(other.export({ type: 'pkcs1', format: 'pem' }) as string);
      expect(wrapped.format === 'spki' ? [...wrapped.der] : []).toEqual([...spkiDer(other)]);
    }
  });

  it('accepts CRLF line endings, surrounding whitespace and an unwrapped body', () => {
    const text = spkiPem(rsa.publicKey);
    const der = [...spkiDer(rsa.publicKey)];
    const derOf = (t: string) => { const k = key(t); return k.format === 'spki' ? [...k.der] : []; };
    expect(derOf(text.split(LF).join(CRLF))).toEqual(der);
    expect(derOf(`${LF}${LF}  ${text}  ${LF}`)).toEqual(der);
    expect(derOf(`-----BEGIN PUBLIC KEY-----${Buffer.from(spkiDer(rsa.publicKey)).toString('base64')}-----END PUBLIC KEY-----`)).toEqual(der);
  });

  it('refuses every kind of private key', () => {
    expect(keyError(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toBe('key-private');
    expect(keyError(rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string)).toBe('key-private');
    expect(keyError(ec['P-256'].privateKey.export({ type: 'sec1', format: 'pem' }) as string)).toBe('key-private');
    expect(keyError(ec['P-256'].privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toBe('key-private');
    const encrypted = rsa.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'test-only' }) as string;
    expect(encrypted).toContain('BEGIN ENCRYPTED PRIVATE KEY');
    expect(keyError(encrypted)).toBe('key-private');
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY']) {
      expect(keyError(pem(label, new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00])))).toBe('key-private');
    }
  });

  it('refuses certificates and other PEM types', () => {
    for (const label of ['CERTIFICATE', 'X509 CRL', 'CERTIFICATE REQUEST', 'EC PARAMETERS', 'DH PARAMETERS', 'PGP PUBLIC KEY BLOCK', 'SSH2 PUBLIC KEY']) {
      expect(keyError(pem(label, spkiDer(rsa.publicKey)))).toBe('key-format');
    }
  });

  it('refuses PEM blocks with header lines', () => {
    const text = spkiPem(rsa.publicKey).replace(`-----BEGIN PUBLIC KEY-----${LF}`, `-----BEGIN PUBLIC KEY-----${LF}Proc-Type: 4,ENCRYPTED${LF}DEK-Info: AES-128-CBC,00${LF}${LF}`);
    expect(keyError(text)).toBe('key-format');
  });

  it('refuses incomplete, mismatched or padded-out PEM text', () => {
    const text = spkiPem(rsa.publicKey);
    expect(keyError(text.replace('-----END PUBLIC KEY-----', ''))).toBe('key-pem');
    expect(keyError('-----BEGIN PUBLIC KEY-----')).toBe('key-pem');
    expect(keyError(text.replace('END PUBLIC KEY', 'END RSA PUBLIC KEY'))).toBe('key-pem');
    expect(keyError(pem('PUBLIC KEY', spkiDer(rsa.publicKey), 'PRIVATE KEY'))).toBe('key-pem');
    expect(keyError(`${text}trailing text`)).toBe('key-pem');
    expect(keyError(`${text}${spkiPem(ec['P-256'].publicKey)}`)).toBe('key-pem');
    expect(keyError(`-----BEGIN PUBLIC KEY-----${LF}-----END PUBLIC KEY-----`)).toBe('key-pem');
    expect(keyError(`-----BEGIN PUBLIC KEY-----${LF}MIIB!!!!${LF}-----END PUBLIC KEY-----`)).toBe('key-pem');
    expect(keyError(`-----BEGIN PUBLIC KEY-----${LF}MIIBI${LF}-----END PUBLIC KEY-----`)).toBe('key-pem');
    expect(keyError('-----BEGIN public key-----\nAAAA\n-----END public key-----')).toBe('key-pem');
  });

  it('refuses truncated or corrupted DER', () => {
    const der = spkiDer(rsa.publicKey);
    const mutate = (change: (copy: Uint8Array) => Uint8Array | void) => {
      const copy = der.slice();
      return keyError(pem('PUBLIC KEY', change(copy) ?? copy));
    };
    expect(mutate(c => c.subarray(0, c.length - 5))).toBe('key-der');
    expect(mutate(c => c.subarray(0, 10))).toBe('key-der');
    expect(mutate(c => c.subarray(0, 1))).toBe('key-der');
    expect(mutate(c => { c[0] = 0x31; })).toBe('key-der');
    expect(mutate(c => { c[4] = 0x31; })).toBe('key-der');
    expect(mutate(c => { c[6] = 0x04; })).toBe('key-der');
    expect(mutate(c => { c[3] += 1; })).toBe('key-der');
    expect(mutate(c => Uint8Array.from([...c, 0x00]))).toBe('key-der');
    expect(mutate(() => new Uint8Array([0x30, 0x80, 0x00, 0x00]))).toBe('key-der');
    expect(mutate(() => new Uint8Array([0x30, 0x85, 1, 1, 1, 1, 1]))).toBe('key-der');
    // The BIT STRING replaced by another type.
    const bitString = 19;
    expect(der[bitString]).toBe(0x03);
    expect(mutate(c => { c[bitString] = 0x04; })).toBe('key-der');
    // PKCS#1 with the wrong inner structure.
    expect(keyError(pem('RSA PUBLIC KEY', der))).toBe('key-der');
    expect(keyError(pem('RSA PUBLIC KEY', new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x05])))).toBe('key-der');
    expect(keyError(pem('RSA PUBLIC KEY', new Uint8Array([0x02, 0x01, 0x05])))).toBe('key-der');
  });

  it('refuses key types and curves that are not supported, by name', () => {
    const unsupported = (text: string) => {
      const r = parsePublicKey(text);
      return r.ok ? ['ok', ''] : [r.error.code, r.error.message];
    };
    const cases: [string, string][] = [
      [spkiPem(generateKeyPairSync('ed25519').publicKey), 'Ed25519'],
      [spkiPem(generateKeyPairSync('ed448').publicKey), 'Ed448'],
      [spkiPem(generateKeyPairSync('x25519').publicKey), 'X25519'],
      [spkiPem(generateKeyPairSync('rsa-pss', { modulusLength: 2048 }).publicKey), 'RSASSA-PSS'],
      [spkiPem(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey), 'secp256k1'],
      [spkiPem(generateKeyPairSync('ec', { namedCurve: 'secp224r1' }).publicKey), 'P-224'],
    ];
    for (const [text, name] of cases) {
      const [code, message] = unsupported(text);
      expect([name, code]).toEqual([name, 'key-unsupported']);
      expect(message).toContain(name);
    }
    // A curve NetForge has no name for is still refused.
    expect(unsupported(spkiPem(generateKeyPairSync('ec', { namedCurve: 'brainpoolP256r1' }).publicKey))[0]).toBe('key-unsupported');
  });
});

describe('parsePublicKey: JWK', () => {
  it('reads an RSA JWK and keeps only the public parameters', () => {
    const source: Record<string, unknown> = { ...jwkOf(rsa.publicKey), kid: 'k1', use: 'sig', alg: 'RS256', key_ops: ['verify'], extra: 'ignored' };
    const k = key(JSON.stringify(source));
    expect(k.format).toBe('jwk');
    expect(k.family).toBe('RSA');
    expect(k.format === 'jwk' ? k.jwk : null).toEqual({ kty: 'RSA', n: source.n, e: source.e });
    expect(k.format === 'jwk' ? k.declared : null).toEqual({ alg: 'RS256', use: 'sig', kid: 'k1', keyOps: ['verify'] });
  });

  it('reads EC JWKs on the three supported curves', () => {
    for (const curve of ['P-256', 'P-384', 'P-521'] as const) {
      const source = jwkOf(ec[curve].publicKey);
      const k = key(JSON.stringify(source, null, 2));
      expect(k.format).toBe('jwk');
      expect(k.family === 'EC' ? k.curve : null).toBe(curve);
      expect(k.format === 'jwk' ? k.jwk : null).toEqual({ kty: 'EC', crv: curve, x: source.x, y: source.y });
      expect(k.format === 'jwk' ? k.declared : null).toEqual({ alg: undefined, use: undefined, kid: undefined, keyOps: undefined });
    }
  });

  it('refuses a JWK that holds a private key', () => {
    expect(keyError(JSON.stringify(jwkOf(rsa.privateKey)))).toBe('key-private');
    expect(keyError(JSON.stringify(jwkOf(ec['P-256'].privateKey)))).toBe('key-private');
    const pub = jwkOf(rsa.publicKey);
    for (const name of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) expect(keyError(JSON.stringify({ ...pub, [name]: 'AQAB' }))).toBe('key-private');
    expect(keyError(JSON.stringify({ ...jwkOf(ec['P-384'].publicKey), d: '' }))).toBe('key-private');
  });

  it('refuses a shared-secret JWK and unsupported key types and curves', () => {
    expect(keyError(JSON.stringify({ kty: 'oct', k: 'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ' }))).toBe('key-format');
    expect(keyError(JSON.stringify(jwkOf(generateKeyPairSync('ed25519').publicKey)))).toBe('key-unsupported');
    expect(keyError(JSON.stringify({ kty: 'OKP', crv: 'X25519', x: 'AAAA' }))).toBe('key-unsupported');
    expect(keyError(JSON.stringify({ kty: 'rsa', n: 'AQAB', e: 'AQAB' }))).toBe('key-unsupported');
    expect(keyError(JSON.stringify(jwkOf(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey)))).toBe('key-unsupported');
    const p256 = jwkOf(ec['P-256'].publicKey);
    expect(keyError(JSON.stringify({ ...p256, crv: 'p-256' }))).toBe('key-unsupported');
    expect(keyError(JSON.stringify({ kty: 'EC', x: p256.x, y: p256.y }))).toBe('key-unsupported');
    expect(keyError(JSON.stringify({ ...p256, crv: 256 }))).toBe('key-unsupported');
  });

  it('refuses malformed JWKs', () => {
    const r = jwkOf(rsa.publicKey);
    const p256 = jwkOf(ec['P-256'].publicKey);
    const p521 = jwkOf(ec['P-521'].publicKey);
    const bad: unknown[] = [
      {}, { n: r.n, e: r.e }, { kty: 5, n: r.n, e: r.e }, { kty: null },
      { kty: 'RSA', e: r.e }, { kty: 'RSA', n: r.n }, { kty: 'RSA', n: '', e: r.e }, { kty: 'RSA', n: 12345, e: r.e },
      { kty: 'RSA', n: `${r.n as string}=`, e: r.e }, { kty: 'RSA', n: r.n, e: 'AQAB==' }, { kty: 'RSA', n: 'ab+/', e: r.e }, { kty: 'RSA', n: 'a b', e: r.e },
      { kty: 'EC', crv: 'P-256', x: p256.x }, { kty: 'EC', crv: 'P-256', y: p256.y },
      { kty: 'EC', crv: 'P-256', x: `${p256.x as string}=`, y: p256.y },
      // Coordinates of the wrong length for the curve.
      { kty: 'EC', crv: 'P-256', x: (p256.x as string).slice(0, -2), y: p256.y }, { kty: 'EC', crv: 'P-256', x: p256.x, y: `${p256.y as string}AA` },
      { kty: 'EC', crv: 'P-384', x: p256.x, y: p256.y }, { kty: 'EC', crv: 'P-256', x: p521.x, y: p521.y }, { kty: 'EC', crv: 'P-521', x: p256.x, y: p256.y },
      // Declared uses of the wrong type.
      { ...r, alg: 256 }, { ...r, use: ['sig'] }, { ...r, kid: 7 }, { ...r, key_ops: 'verify' }, { ...r, key_ops: ['verify', 1] },
    ];
    for (const jwk of bad) expect([JSON.stringify(jwk).slice(0, 60), keyError(JSON.stringify(jwk))]).toEqual([JSON.stringify(jwk).slice(0, 60), 'key-jwk']);
  });

  it('refuses invalid JSON and JSON with repeated names', () => {
    expect(keyError('{"kty":"RSA",')).toBe('key-jwk');
    expect(keyError('{kty:"RSA"}')).toBe('key-jwk');
    expect(keyError('{"kty":"RSA"} trailing')).toBe('key-jwk');
    const r = jwkOf(rsa.publicKey);
    expect(keyError(`{"kty":"RSA","n":"${r.n as string}","e":"AQAB","n":"${r.n as string}"}`)).toBe('key-jwk');
    expect(keyError(`{"kty":"EC","kty":"RSA","n":"${r.n as string}","e":"AQAB"}`)).toBe('key-jwk');
  });
});

describe('parsePublicKey: a pasted JWK Set', () => {
  const a = { ...jwkOf(rsa.publicKey), kid: 'rsa-1' };
  const b = { ...jwkOf(ec['P-256'].publicKey), kid: 'ec-1' };
  const c = { ...jwkOf(ec['P-384'].publicKey), kid: 'ec-2' };
  const set = JSON.stringify({ keys: [a, b, c] });

  it('selects the key whose kid matches the token', () => {
    expect(key(set, 'rsa-1').family).toBe('RSA');
    const second = key(set, 'ec-1');
    expect(second.family === 'EC' ? second.curve : null).toBe('P-256');
    const third = key(set, 'ec-2');
    expect(third.family === 'EC' ? third.curve : null).toBe('P-384');
    expect(third.format === 'jwk' ? third.declared.kid : null).toBe('ec-2');
  });

  it('reports no match, never falling back to another key', () => {
    expect(keyError(set, 'missing')).toBe('key-not-found');
    expect(keyError(set, 'RSA-1')).toBe('key-not-found');
    expect(keyError(set, 'rsa-1 ')).toBe('key-not-found');
    expect(keyError(set, '')).toBe('key-not-found');
    expect(keyError(JSON.stringify({ keys: [a] }), 'other')).toBe('key-not-found');
    expect(keyError(JSON.stringify({ keys: [{ ...a, kid: undefined }] }), 'rsa-1')).toBe('key-not-found');
  });

  it('refuses an ambiguous kid', () => {
    expect(keyError(JSON.stringify({ keys: [a, { ...b, kid: 'rsa-1' }] }), 'rsa-1')).toBe('key-not-found');
  });

  it('uses the only key when the token has no kid, and refuses to choose among several', () => {
    expect(key(JSON.stringify({ keys: [b] })).family).toBe('EC');
    expect(keyError(set)).toBe('key-not-found');
    expect(keyError(JSON.stringify({ keys: [a, b] }))).toBe('key-not-found');
    expect(keyError(JSON.stringify({ keys: [] }))).toBe('key-not-found');
    expect(keyError(JSON.stringify({ keys: [] }), 'rsa-1')).toBe('key-not-found');
  });

  it('applies every single-key rule to the selected key', () => {
    expect(keyError(JSON.stringify({ keys: [{ ...jwkOf(rsa.privateKey), kid: 'x' }] }), 'x')).toBe('key-private');
    expect(keyError(JSON.stringify({ keys: [{ kty: 'oct', k: 'AAAA', kid: 'x' }] }), 'x')).toBe('key-format');
    expect(keyError(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'x' }] }), 'x')).toBe('key-jwk');
    // An unselected private key in the set is not read at all.
    expect(key(JSON.stringify({ keys: [{ ...jwkOf(rsa.privateKey), kid: 'private' }, b] }), 'ec-1').family).toBe('EC');
  });

  it('refuses a malformed set', () => {
    expect(keyError('{"keys":{}}')).toBe('key-jwk');
    expect(keyError('{"keys":"x"}')).toBe('key-jwk');
    expect(keyError('{"keys":[1]}')).toBe('key-jwk');
    expect(keyError('{"keys":[null]}')).toBe('key-jwk');
    expect(keyError('{"keys":[[]]}')).toBe('key-jwk');
  });
});

describe('parsePublicKey: other input', () => {
  it('asks for a key when there is none', () => {
    expect(keyError('')).toBe('key-empty');
    expect(keyError(`  ${LF} `)).toBe('key-empty');
  });

  it('refuses oversize input', () => {
    expect(keyError(`{"kty":"RSA","n":"${'A'.repeat(MAX_KEY_CHARS)}"}`)).toBe('key-format');
    expect(keyError(`-----BEGIN PUBLIC KEY-----${'A'.repeat(MAX_KEY_CHARS)}`)).toBe('key-format');
  });

  it('refuses OpenSSH keys, URLs and anything else, without fetching', () => {
    expect(keyError('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ user@host')).toBe('key-format');
    expect(keyError('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 user@host')).toBe('key-format');
    expect(keyError('ecdsa-sha2-nistp256 AAAAE2VjZHNh user@host')).toBe('key-format');
    expect(keyError('https://issuer.example/.well-known/jwks.json')).toBe('key-format');
    expect(keyError('HTTP://issuer.example/keys')).toBe('key-format');
    expect(keyError('my-shared-secret')).toBe('key-format');
    expect(keyError('[{"kty":"RSA"}]')).toBe('key-format');
    expect(keyError(Buffer.from(spkiDer(rsa.publicKey)).toString('base64'))).toBe('key-format');
    const url = parsePublicKey('https://issuer.example/.well-known/jwks.json');
    expect(url.ok ? '' : url.error.message).toContain('never fetches');
  });
});
