/**
 * JWT decoding: structure checks, header and payload handling, and what is said about algorithms.
 * Tokens are built by hand here (Node's Buffer does the Base64URL), so each malformed shape is
 * exactly the one named by the test.
 */
import { describe, expect, it } from 'vitest';
import { decodeJwt, MAX_JWT_CHARS, SUPPORTED_ALGS, unsupportedAlgReason, type DecodedJwt } from '../../src/core/jwt/jwt';

type Part = string | Uint8Array | Record<string, unknown>;

function b64u(data: string | Uint8Array): string {
  return Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');
}

function seg(part: Part): string {
  return typeof part === 'string' || part instanceof Uint8Array ? b64u(part) : b64u(JSON.stringify(part));
}

function token(header: Part, payload: Part, signature: string | Uint8Array = 'sig-bytes'): string {
  return `${seg(header)}.${seg(payload)}.${b64u(signature)}`;
}

function good(input: string): DecodedJwt {
  const r = decodeJwt(input);
  if (!r.ok) throw new Error(`expected a decoded token, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function bad(input: string): { code: string; offset: number | undefined } {
  const r = decodeJwt(input);
  if (r.ok) throw new Error('expected an error, but the token decoded');
  return { code: r.error.code, offset: r.error.offset };
}

const HS = { alg: 'HS256', typ: 'JWT' };
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);

describe('decoding a well-formed token', () => {
  it('splits, decodes and formats the header and payload', () => {
    const t = token('{"alg":"HS256","typ":"JWT"}', '{"sub":"1234567890","name":"Ada","admin":true,"iat":1516239022}', new Uint8Array(32).fill(7));
    const jwt = good(t);
    expect(jwt.token).toBe(t);
    expect(jwt.segments).toEqual(t.split('.'));
    expect(jwt.signingInput).toBe(t.slice(0, t.lastIndexOf('.')));
    expect(jwt.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(jwt.headerJson).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(jwt.alg).toBe('HS256');
    expect(jwt.algInfo).toBe(SUPPORTED_ALGS.HS256);
    expect(jwt.payloadKind).toBe('claims');
    expect(jwt.claims).toEqual({ sub: '1234567890', name: 'Ada', admin: true, iat: 1516239022 });
    expect(jwt.payloadText).toBe('{\n  "sub": "1234567890",\n  "name": "Ada",\n  "admin": true,\n  "iat": 1516239022\n}');
    expect([...jwt.signature]).toEqual(new Array(32).fill(7));
    expect(jwt.notes).toEqual([]);
  });

  it('keeps numbers in the formatted payload exactly as the issuer wrote them', () => {
    const jwt = good(token(HS, '{"exp":1.0e3,"big":12345678901234567890}'));
    expect(jwt.payloadText).toBe('{\n  "exp": 1.0e3,\n  "big": 12345678901234567890\n}');
    expect(jwt.claims!.exp).toBe(1000);
  });

  it('decodes Unicode claims and keeps the payload bytes', () => {
    const name = String.fromCodePoint(0x4e16, 0x754c, 0x1f600);
    const jwt = good(token(HS, { name }));
    expect(jwt.claims).toEqual({ name });
    expect(Buffer.from(jwt.payloadBytes).toString('utf8')).toBe(JSON.stringify({ name }));
  });

  it('trims surrounding whitespace and nothing else', () => {
    const t = token(HS, { a: 1 });
    expect(good(`  ${TAB}${t}${LF}`).token).toBe(t);
  });

  it('removes a Bearer prefix and says so', () => {
    const t = token(HS, { a: 1 });
    for (const prefix of ['Bearer ', 'bearer  ', `BEARER${TAB}`]) {
      const jwt = good(prefix + t);
      expect(jwt.token).toBe(t);
      expect(jwt.notes).toHaveLength(1);
      expect(jwt.notes[0]).toContain('Bearer');
    }
    // "Bearer" glued to the token is not a prefix: it is part of a (broken) first segment.
    expect(decodeJwt(`Bearer${t}`).ok ? good(`Bearer${t}`).notes : []).toEqual([]);
  });

  it('accepts an empty signature segment and reports zero signature bytes', () => {
    const jwt = good(`${seg({ alg: 'none' })}.${seg({ iss: 'joe' })}.`);
    expect(jwt.alg).toBe('none');
    expect(jwt.algInfo).toBeNull();
    expect(jwt.signature).toHaveLength(0);
    expect(jwt.claims).toEqual({ iss: 'joe' });
  });

  it('accepts a token exactly at the size limit', () => {
    const head = `${seg(HS)}.`;
    const tail = '.c2ln';
    const room = MAX_JWT_CHARS - head.length - tail.length;
    // A quoted string of the right length inside an object, so the payload is valid JSON.
    const fill = Math.floor(room / 4) * 3 - '{"a":""}'.length;
    const payload = b64u(`{"a":"${'x'.repeat(fill)}"}`);
    const t = head + payload + tail;
    expect(t.length).toBeLessThanOrEqual(MAX_JWT_CHARS);
    expect(t.length).toBeGreaterThan(MAX_JWT_CHARS - 8);
    expect(decodeJwt(t).ok).toBe(true);
  });
});

describe('algorithm lookup', () => {
  it('knows exactly nine algorithms', () => {
    expect(Object.keys(SUPPORTED_ALGS)).toEqual(['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']);
    for (const [name, info] of Object.entries(SUPPORTED_ALGS)) expect(info.name).toBe(name);
    expect(Object.values(SUPPORTED_ALGS).map(a => [a.family, a.hash, a.curve ?? null, a.signatureBytes ?? null])).toEqual([
      ['HMAC', 'SHA-256', null, 32], ['HMAC', 'SHA-384', null, 48], ['HMAC', 'SHA-512', null, 64],
      ['RSA', 'SHA-256', null, null], ['RSA', 'SHA-384', null, null], ['RSA', 'SHA-512', null, null],
      ['EC', 'SHA-256', 'P-256', 64], ['EC', 'SHA-384', 'P-384', 96], ['EC', 'SHA-512', 'P-521', 132],
    ]);
  });

  it('gives each supported name its own entry', () => {
    for (const name of Object.keys(SUPPORTED_ALGS)) expect(good(token({ alg: name }, {})).algInfo).toBe(SUPPORTED_ALGS[name]);
  });

  it('has no entry for unsupported names, wrong case, or names inherited from Object', () => {
    for (const name of ['none', 'None', 'NONE', 'PS256', 'EdDSA', 'ES256K', 'hs256', 'Hs256', 'RS257', 'HS256 ', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const jwt = good(token({ alg: name }, {}));
      expect(jwt.alg).toBe(name);
      expect(jwt.algInfo).toBeNull();
    }
  });

  it('explains why an algorithm is not verified', () => {
    expect(unsupportedAlgReason('none')).toContain('unsecured');
    expect(unsupportedAlgReason('PS256')).toContain('RSASSA-PSS');
    expect(unsupportedAlgReason('EdDSA')).toContain('EdDSA');
    expect(unsupportedAlgReason('ES256K')).toContain('secp256k1');
    // Wrong case is pointed out, never silently corrected.
    expect(unsupportedAlgReason('hs256')).toContain('"HS256"');
    expect(unsupportedAlgReason('hs256')).toContain('case-sensitive');
    expect(unsupportedAlgReason('rs512')).toContain('"RS512"');
    expect(unsupportedAlgReason('XYZ')).toContain('HS256, HS384, HS512, RS256, RS384, RS512, ES256, ES384, ES512');
    expect(unsupportedAlgReason('XYZ')).not.toContain('case-sensitive');
    // Names that exist on every object are just unknown algorithms.
    expect(unsupportedAlgReason('constructor')).toContain('"constructor" is not an algorithm');
    expect(unsupportedAlgReason('toString')).toContain('"toString" is not an algorithm');
  });
});

describe('structure errors', () => {
  it('empty input', () => {
    for (const input of ['', '   ', `${TAB}${LF}`, 'Bearer ']) expect(bad(input).code).toBe(input.startsWith('Bearer') ? 'segment-count' : 'empty');
  });

  it('too large', () => {
    expect(bad(`${'a'.repeat(MAX_JWT_CHARS - 1)}.b`).code).toBe('too-large');
    expect(bad('a'.repeat(MAX_JWT_CHARS + 1)).code).toBe('too-large');
    // The limit applies to the token itself, after a Bearer prefix is removed.
    expect(bad(`Bearer ${'a'.repeat(MAX_JWT_CHARS)}`).code).toBe('segment-count');
  });

  it('whitespace inside the token, with its position', () => {
    const t = token(HS, { a: 1 });
    expect(bad(`${t.slice(0, 10)} ${t.slice(10)}`)).toEqual({ code: 'whitespace', offset: 10 });
    expect(bad(`${t.slice(0, 20)}${LF}${t.slice(20)}`)).toEqual({ code: 'whitespace', offset: 20 });
    expect(bad(`${t.slice(0, 5)}${TAB}${t.slice(5)}`)).toEqual({ code: 'whitespace', offset: 5 });
    expect(bad(`${t.slice(0, 7)}${String.fromCharCode(0xa0)}${t.slice(7)}`)).toEqual({ code: 'whitespace', offset: 7 });
  });

  it('wrong number of segments', () => {
    const [h, p, s] = token(HS, { a: 1 }).split('.');
    expect(bad(h).code).toBe('segment-count');
    expect(bad(`${h}.${p}`).code).toBe('segment-count');
    expect(bad(`${h}.${p}.${s}.${s}`).code).toBe('segment-count');
    expect(bad(`${h}.${p}.${s}.${s}.${s}.${s}`).code).toBe('segment-count');
    expect(bad('..').code).toBe('segment-empty');
    expect(bad('.').code).toBe('segment-count');
  });

  it('five segments are reported as an encrypted token', () => {
    const [h, p, s] = token(HS, { a: 1 }).split('.');
    expect(bad(`${h}.${p}.${s}.${p}.${s}`).code).toBe('encrypted');
    expect(bad('a.b.c.d.e').code).toBe('encrypted');
    expect(bad('....').code).toBe('encrypted');
  });

  it('empty header or payload segment, with its position', () => {
    const [h, p, s] = token(HS, { a: 1 }).split('.');
    expect(bad(`.${p}.${s}`)).toEqual({ code: 'segment-empty', offset: 0 });
    expect(bad(`${h}..${s}`)).toEqual({ code: 'segment-empty', offset: h.length + 1 });
  });

  it('padding is refused in every segment', () => {
    const h = seg(HS);
    const p = seg({ a: 1 });
    expect(Buffer.from('{}').toString('base64')).toBe('e30=');
    expect(bad(`e30=.${p}.c2ln`)).toEqual({ code: 'segment-encoding', offset: 3 });
    expect(bad(`${h}.e30=.c2ln`)).toEqual({ code: 'segment-encoding', offset: h.length + 1 + 3 });
    expect(bad(`${h}.${p}.c2k=`)).toEqual({ code: 'segment-encoding', offset: h.length + p.length + 2 + 3 });
    expect(bad(`${h}.${p}.cw==`)).toEqual({ code: 'segment-encoding', offset: h.length + p.length + 2 + 2 });
  });

  it('the standard Base64 alphabet is refused in every segment', () => {
    const h = seg(HS);
    const p = seg({ a: 1 });
    expect(bad(`ab+d.${p}.c2ln`)).toEqual({ code: 'segment-encoding', offset: 2 });
    expect(bad(`${h}.ab/d.c2ln`)).toEqual({ code: 'segment-encoding', offset: h.length + 1 + 2 });
    expect(bad(`${h}.${p}.+2ln`)).toEqual({ code: 'segment-encoding', offset: h.length + p.length + 2 });
    expect(bad(`${h}.${p}.c2l/`)).toEqual({ code: 'segment-encoding', offset: h.length + p.length + 2 + 3 });
  });

  it('other invalid Base64URL is refused in every segment', () => {
    const h = seg(HS);
    const p = seg({ a: 1 });
    for (const junk of ['ab!d', 'ab$d', 'ab,d', `ab${String.fromCharCode(0xe9)}d`, 'ab~d', 'ab:d']) {
      expect(bad(`${junk}.${p}.c2ln`)).toEqual({ code: 'segment-encoding', offset: 2 });
      expect(bad(`${h}.${junk}.c2ln`)).toEqual({ code: 'segment-encoding', offset: h.length + 1 + 2 });
      expect(bad(`${h}.${p}.${junk}`)).toEqual({ code: 'segment-encoding', offset: h.length + p.length + 2 + 2 });
    }
    // One leftover character cannot hold a byte.
    expect(bad(`${h}.${p}.c2lnb`).code).toBe('segment-encoding');
    expect(bad(`${h}x.${p}.c2ln`).code).toBe('segment-encoding');
  });

  it('a signature whose last character carries stray bits is refused, so one signature has one spelling', () => {
    const h = seg(HS);
    const p = seg({ a: 1 });
    // "c2k" is the canonical encoding of the two bytes "si"; "c2l" decodes to the same bytes.
    expect(Buffer.from('c2k', 'base64url').toString()).toBe('si');
    expect(Buffer.from('c2l', 'base64url').toString()).toBe('si');
    expect(decodeJwt(`${h}.${p}.c2k`).ok).toBe(true);
    expect(bad(`${h}.${p}.c2l`).code).toBe('segment-encoding');
    expect(bad(`${h}.${p}.cx`).code).toBe('segment-encoding');
    expect(decodeJwt(`${h}.${p}.cw`).ok).toBe(true);
  });
});

describe('header errors', () => {
  const p = seg({ a: 1 });
  const withHeader = (header: string | Uint8Array) => `${b64u(header)}.${p}.c2ln`;

  it('not UTF-8', () => {
    expect(bad(withHeader(new Uint8Array([0x7b, 0xff, 0x7d]))).code).toBe('header-utf8');
    expect(bad(withHeader(new Uint8Array([0xc0, 0xaf]))).code).toBe('header-utf8');
    expect(bad(withHeader(new Uint8Array([0xed, 0xa0, 0x80]))).code).toBe('header-utf8');
  });

  it('not JSON', () => {
    for (const text of ['{', 'alg=HS256', '{"alg":"HS256",}', "{'alg':'HS256'}", '{"alg":"HS256"} x', '{"alg":HS256}', 'null x']) {
      expect(bad(withHeader(text)).code).toBe('header-json');
    }
  });

  it('a byte order mark before the header is refused, not skipped', () => {
    expect(bad(withHeader(`${BOM}{"alg":"HS256"}`)).code).toBe('header-json');
  });

  it('JSON that is not an object', () => {
    for (const text of ['["HS256"]', '"HS256"', '123', 'true', 'null', '[]']) expect(bad(withHeader(text)).code).toBe('header-not-object');
  });

  it('duplicate header names', () => {
    expect(bad(withHeader('{"alg":"HS256","alg":"none"}')).code).toBe('header-duplicate');
    expect(bad(withHeader('{"alg":"none","typ":"JWT","alg":"HS256"}')).code).toBe('header-duplicate');
    expect(bad(withHeader('{"alg":"HS256","kid":"a","kid":"b"}')).code).toBe('header-duplicate');
    // The same name written with an escape is still the same name.
    expect(bad(withHeader(`{"alg":"HS256","${String.fromCharCode(0x5c)}u0061lg":"none"}`)).code).toBe('header-duplicate');
    // The same name at different depths is not a duplicate.
    expect(decodeJwt(withHeader('{"alg":"HS256","jwk":{"alg":"x"}}')).ok).toBe(true);
  });

  it('alg missing, empty or not a string', () => {
    for (const text of ['{}', '{"typ":"JWT"}', '{"alg":""}', '{"alg":256}', '{"alg":null}', '{"alg":["HS256"]}', '{"alg":{"name":"HS256"}}', '{"alg":true}', '{"ALG":"HS256"}']) {
      expect(bad(withHeader(text)).code).toBe('alg-missing');
    }
  });
});

describe('payload handling', () => {
  const withPayload = (header: Record<string, unknown>, payload: string | Uint8Array) => `${seg(header)}.${b64u(payload)}.c2ln`;
  const notUtf8 = new Uint8Array([0x50, 0xff, 0xfe, 0x00]);

  it('not UTF-8 is an error when the header says JWT', () => {
    for (const typ of ['JWT', 'jwt', 'at+jwt', 'AT+JWT', 'application/jwt', 'application/at+jwt']) {
      expect(bad(withPayload({ alg: 'HS256', typ }, notUtf8)).code).toBe('payload-utf8');
    }
  });

  it('not UTF-8 without a JWT type is a binary signed object', () => {
    for (const header of [{ alg: 'HS256' }, { alg: 'HS256', typ: 'JOSE' }, { alg: 'HS256', typ: 5 }]) {
      const jwt = good(withPayload(header, notUtf8));
      expect(jwt.payloadKind).toBe('binary');
      expect(jwt.claims).toBeNull();
      expect(jwt.payloadText).toBeNull();
      expect([...jwt.payloadBytes]).toEqual([...notUtf8]);
      expect(jwt.notes.join(' ')).toContain('binary');
    }
  });

  it('invalid JSON is an error when the header says JWT or the payload starts with a brace', () => {
    expect(bad(withPayload({ alg: 'HS256', typ: 'JWT' }, 'Payload')).code).toBe('payload-json');
    expect(bad(withPayload({ alg: 'HS256', typ: 'JWT' }, '')).code).toBe('segment-empty');
    expect(bad(withPayload({ alg: 'HS256' }, '{"a":}')).code).toBe('payload-json');
    expect(bad(withPayload({ alg: 'HS256' }, '  {"a":1')).code).toBe('payload-json');
    expect(bad(withPayload({ alg: 'HS256' }, '{"a":1,}')).code).toBe('payload-json');
    expect(bad(withPayload({ alg: 'HS256' }, `${BOM}{"a":1}`)).code).toBe('payload-json');
  });

  it('JSON that is not an object is an error when the header says JWT', () => {
    for (const text of ['[1,2]', '"text"', '42', 'true', 'null']) {
      expect(bad(withPayload({ alg: 'HS256', typ: 'JWT' }, text)).code).toBe('payload-not-object');
    }
  });

  it('without a JWT type, a payload that is not a JSON object is shown as text', () => {
    for (const text of ['Payload', '[1,2]', '"text"', '42', 'not { json', 'x {"a":1}']) {
      const jwt = good(withPayload({ alg: 'ES512' }, text));
      expect(jwt.payloadKind).toBe('text');
      expect(jwt.payloadText).toBe(text);
      expect(jwt.claims).toBeNull();
      expect(jwt.notes.join(' ')).toContain('not a JWT claims set');
    }
  });

  it('duplicate claim names', () => {
    expect(bad(withPayload({ alg: 'HS256' }, '{"sub":"user","sub":"admin"}')).code).toBe('payload-duplicate');
    expect(bad(withPayload({ alg: 'HS256', typ: 'JWT' }, '{"exp":1,"role":"a","exp":9999999999}')).code).toBe('payload-duplicate');
    expect(decodeJwt(withPayload({ alg: 'HS256' }, '{"sub":"a","nested":{"sub":"b"}}')).ok).toBe(true);
  });

  it('an empty object is a claims set with no claims', () => {
    const jwt = good(withPayload({ alg: 'HS256', typ: 'JWT' }, '{}'));
    expect(jwt.payloadKind).toBe('claims');
    expect(jwt.claims).toEqual({});
  });
});

describe('keys named or carried by the token are never used', () => {
  it('notes jku and x5u as never fetched, jwk and x5c as ignored', () => {
    const jwt = good(token({ alg: 'RS256', jku: 'https://issuer.example/keys', x5u: 'https://issuer.example/cert', jwk: { kty: 'RSA' }, x5c: ['MIIB'] }, { a: 1 }));
    expect(jwt.notes).toHaveLength(4);
    expect(jwt.notes[0]).toContain('"jku"');
    expect(jwt.notes[0]).toContain('never fetches');
    expect(jwt.notes[1]).toContain('"x5u"');
    expect(jwt.notes[1]).toContain('never fetches');
    expect(jwt.notes[2]).toContain('"jwk"');
    expect(jwt.notes[2]).toContain('ignores');
    expect(jwt.notes[3]).toContain('"x5c"');
    expect(jwt.notes[3]).toContain('ignores');
  });

  it('adds one note per parameter present and none otherwise', () => {
    expect(good(token({ alg: 'RS256', kid: 'k1' }, {})).notes).toEqual([]);
    expect(good(token({ alg: 'RS256', jku: 'x' }, {})).notes).toHaveLength(1);
    expect(good(token({ alg: 'RS256', x5c: [] }, {})).notes).toHaveLength(1);
    // A claim with the same name is not a header parameter.
    expect(good(token({ alg: 'RS256' }, { jku: 'x', jwk: {} })).notes).toEqual([]);
  });
});

describe('nothing in a token is executed or trusted', () => {
  it('treats names like __proto__ as plain data', () => {
    const jwt = good(`${b64u('{"alg":"HS256","__proto__":{"alg":"none"}}')}.${b64u('{"__proto__":{"admin":true},"constructor":"x"}')}.c2ln`);
    expect(jwt.alg).toBe('HS256');
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(Object.keys(jwt.claims!)).toEqual(['__proto__', 'constructor']);
    expect((jwt.claims as Record<string, unknown>).admin).toBeUndefined();
  });

  it('does not take alg from the prototype chain', () => {
    expect(bad(`${b64u('{"__proto__":{"alg":"HS256"}}')}.${seg({ a: 1 })}.c2ln`).code).toBe('alg-missing');
  });
});
