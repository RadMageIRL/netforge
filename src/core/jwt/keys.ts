/**
 * Key material for JWT verification, exactly as the user supplies it: a shared secret, or a public
 * key as PEM (SubjectPublicKeyInfo or PKCS#1 RSA) or JWK. Private keys are refused: verification
 * never needs one, and a tool that asks for them teaches a bad habit. Nothing here fetches a key.
 */
import { base64Decode, hexDecode, utf8Encode } from '../codec/codec';
import { analyzeJson } from '../data/json';
import { fail, ok, type Result } from '../result';

export type KeyErrorCode =
  | 'key-empty'
  | 'key-encoding'
  | 'key-confusion'
  | 'key-private'
  | 'key-format'
  | 'key-pem'
  | 'key-der'
  | 'key-unsupported'
  | 'key-jwk'
  | 'key-not-found';

export type Curve = 'P-256' | 'P-384' | 'P-521';

/** What a JWK says about its own intended use; checked against the token before verifying. */
export interface JwkDeclared {
  readonly alg?: string;
  readonly use?: string;
  readonly keyOps?: readonly string[];
  readonly kid?: string;
}

export type PublicKey =
  | { readonly format: 'spki'; readonly family: 'RSA'; readonly der: Uint8Array; readonly source: string }
  | { readonly format: 'spki'; readonly family: 'EC'; readonly curve: Curve; readonly der: Uint8Array; readonly source: string }
  | { readonly format: 'jwk'; readonly family: 'RSA'; readonly jwk: { kty: 'RSA'; n: string; e: string }; readonly declared: JwkDeclared; readonly source: string }
  | { readonly format: 'jwk'; readonly family: 'EC'; readonly curve: Curve; readonly jwk: { kty: 'EC'; crv: Curve; x: string; y: string }; readonly declared: JwkDeclared; readonly source: string };

export const MAX_KEY_CHARS = 100_000;

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----/;

const CONFUSION = 'This is a public or private key, not a shared secret. Checking an HMAC (HS256, HS384, HS512) token with a public key as the secret is the "algorithm confusion" attack: anyone who knows the public key can forge such a token. NetForge refuses to do it.';

function latin1(bytes: Uint8Array, limit = 4096): string {
  let s = '';
  for (let i = 0; i < bytes.length && i < limit; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function looksLikeJwk(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  try {
    const value = JSON.parse(t) as unknown;
    return typeof value === 'object' && value !== null && ('kty' in value || 'keys' in value);
  } catch {
    return false;
  }
}

export type SecretFormat = 'text' | 'hex' | 'base64';

/**
 * A shared secret for HS256/384/512. Text is used byte for byte as typed (UTF-8). Anything that
 * is really a PEM or JWK key is refused, whatever encoding it arrives in.
 */
export function parseSecret(text: string, format: SecretFormat): Result<Uint8Array, KeyErrorCode> {
  if (text.length > MAX_KEY_CHARS) return fail('key-format', `The secret is longer than ${MAX_KEY_CHARS.toLocaleString('en-US')} characters.`);
  let bytes: Uint8Array;
  if (format === 'text') {
    if (text === '') return fail('key-empty', 'Enter the shared secret to verify the signature.');
    const encoded = utf8Encode(text);
    if (!encoded.ok) return fail('key-encoding', encoded.error.message);
    bytes = encoded.value;
  } else {
    const trimmed = text.trim();
    if (trimmed === '') return fail('key-empty', 'Enter the shared secret to verify the signature.');
    const decoded = format === 'hex'
      ? hexDecode(trimmed)
      : base64Decode(trimmed, { alphabet: /[-_]/.test(trimmed) ? 'url' : 'standard', padding: 'optional' });
    if (!decoded.ok) return fail('key-encoding', `The secret is not valid ${format === 'hex' ? 'hexadecimal' : 'Base64'}: ${decoded.error.message}`);
    bytes = decoded.value;
    if (bytes.length === 0) return fail('key-empty', 'The secret decodes to zero bytes.');
  }
  if (PEM_BLOCK.test(text) || PEM_BLOCK.test(latin1(bytes)) || looksLikeJwk(text) || looksLikeJwk(latin1(bytes, MAX_KEY_CHARS))) {
    return fail('key-confusion', CONFUSION);
  }
  return ok(bytes);
}

// DER -----------------------------------------------------------------------------------------

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

/** Reads one DER tag-length-value at `at`. Null if it is malformed or runs past `limit`. */
function readTlv(bytes: Uint8Array, at: number, limit: number): Tlv | null {
  if (at + 2 > limit) return null;
  const tag = bytes[at];
  let length = bytes[at + 1];
  let start = at + 2;
  if (length === 0x80) return null;
  if (length > 0x80) {
    const count = length & 0x7f;
    if (count > 4 || start + count > limit) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[start + i];
    start += count;
  }
  return start + length <= limit ? { tag, start, end: start + length } : null;
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const out: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest & 0xff);
  return [0x80 | out.length, ...out];
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const OID_RSA = '2a864886f70d010101';
const OID_EC = '2a8648ce3d0201';
const CURVE_OIDS: Readonly<Record<string, Curve>> = { '2a8648ce3d030107': 'P-256', '2b81040022': 'P-384', '2b81040023': 'P-521' };
const OTHER_OIDS: Readonly<Record<string, string>> = {
  '2a864886f70d01010a': 'an RSASSA-PSS key',
  '2b6570': 'an Ed25519 key',
  '2b6571': 'an Ed448 key',
  '2b656e': 'an X25519 key',
  '2b656f': 'an X448 key',
  '2a8648ce380401': 'a DSA key',
};
const OTHER_CURVES: Readonly<Record<string, string>> = { '2b8104000a': 'secp256k1', '2b81040021': 'P-224', '2a8648ce3d030101': 'P-192' };

/** Identifies a SubjectPublicKeyInfo structure: RSA, or EC on one of the three supported curves. */
function readSpki(der: Uint8Array, source: string): Result<PublicKey, KeyErrorCode> {
  const malformed = () => fail<KeyErrorCode>('key-der', 'The key\'s contents are not a well-formed public key (SubjectPublicKeyInfo). It may be truncated or damaged.');
  const outer = readTlv(der, 0, der.length);
  if (!outer || outer.tag !== 0x30 || outer.end !== der.length) return malformed();
  const algorithm = readTlv(der, outer.start, outer.end);
  if (!algorithm || algorithm.tag !== 0x30) return malformed();
  const oid = readTlv(der, algorithm.start, algorithm.end);
  if (!oid || oid.tag !== 0x06) return malformed();
  const keyBits = readTlv(der, algorithm.end, outer.end);
  if (!keyBits || keyBits.tag !== 0x03 || keyBits.end !== outer.end || keyBits.end - keyBits.start < 2) return malformed();
  const id = hex(der.subarray(oid.start, oid.end));
  if (id === OID_RSA) return ok({ format: 'spki', family: 'RSA', der, source });
  if (id === OID_EC) {
    const curveOid = readTlv(der, oid.end, algorithm.end);
    if (!curveOid || curveOid.tag !== 0x06) return fail('key-unsupported', 'This elliptic-curve key does not name a standard curve. Only P-256, P-384 and P-521 are supported.');
    const curveId = hex(der.subarray(curveOid.start, curveOid.end));
    if (Object.hasOwn(CURVE_OIDS, curveId)) return ok({ format: 'spki', family: 'EC', curve: CURVE_OIDS[curveId], der, source });
    const named = Object.hasOwn(OTHER_CURVES, curveId) ? OTHER_CURVES[curveId] : 'a curve NetForge does not know';
    return fail('key-unsupported', `This elliptic-curve key is on ${named}. Only P-256, P-384 and P-521 are supported.`);
  }
  const what = Object.hasOwn(OTHER_OIDS, id) ? OTHER_OIDS[id] : 'a key type NetForge does not know';
  return fail('key-unsupported', `This is ${what}. Only RSA keys and elliptic-curve keys on P-256, P-384 or P-521 are supported.`);
}

/** Wraps a PKCS#1 RSAPublicKey (BEGIN RSA PUBLIC KEY) in the SubjectPublicKeyInfo envelope. */
function wrapPkcs1(pkcs1: Uint8Array): Result<Uint8Array, KeyErrorCode> {
  const seq = readTlv(pkcs1, 0, pkcs1.length);
  const modulus = seq && seq.tag === 0x30 && seq.end === pkcs1.length ? readTlv(pkcs1, seq.start, seq.end) : null;
  const exponent = modulus && modulus.tag === 0x02 ? readTlv(pkcs1, modulus.end, seq!.end) : null;
  if (!exponent || exponent.tag !== 0x02 || exponent.end !== seq!.end) {
    return fail('key-der', 'The key\'s contents are not a well-formed RSA public key (PKCS#1). It may be truncated or damaged.');
  }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const bitString = [0x03, ...derLength(pkcs1.length + 1), 0x00];
  const body = algorithm.length + bitString.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(body), ...algorithm, ...bitString, ...pkcs1]);
  return ok(out);
}

// PEM -----------------------------------------------------------------------------------------

function parsePem(text: string): Result<PublicKey, KeyErrorCode> {
  const trimmed = text.trim();
  const match = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END ([A-Z0-9 ]+)-----/.exec(trimmed);
  if (!match) return fail('key-pem', 'The PEM text is incomplete: it needs a "-----BEGIN ...-----" line, the key data, and a matching "-----END ...-----" line.');
  const [whole, label, body, endLabel] = match;
  if (label !== endLabel) return fail('key-pem', `The PEM text begins as "${label}" but ends as "${endLabel}".`);
  if (trimmed.length !== whole.length) return fail('key-pem', 'There is more text after the end of the key. Paste exactly one public key.');
  if (/PRIVATE KEY$/.test(label)) {
    return fail('key-private', 'This is a private key. Verifying a signature needs only the public key, and a private key should never be pasted into a tool. NetForge does not read it.');
  }
  if (label === 'CERTIFICATE') {
    return fail('key-format', 'This is a certificate, not a bare public key. Extract the key first (for example: openssl x509 -pubkey -noout) and paste the "BEGIN PUBLIC KEY" block.');
  }
  if (label !== 'PUBLIC KEY' && label !== 'RSA PUBLIC KEY') {
    return fail('key-format', `"${label}" is not a supported PEM type. Use "PUBLIC KEY" (SubjectPublicKeyInfo) or "RSA PUBLIC KEY" (PKCS#1).`);
  }
  if (/^[A-Za-z-]+:/m.test(body)) return fail('key-format', 'The PEM block has header lines (such as Proc-Type), which are not supported.');
  const der = base64Decode(body, { alphabet: 'standard', lenient: true });
  if (!der.ok || der.value.length === 0) return fail('key-pem', `The data inside the PEM block is not valid Base64${der.ok ? '' : `: ${der.error.message}`}`);
  if (label === 'RSA PUBLIC KEY') {
    const wrapped = wrapPkcs1(der.value);
    return wrapped.ok ? ok({ format: 'spki', family: 'RSA', der: wrapped.value, source: 'PEM (PKCS#1 RSA public key)' }) : wrapped;
  }
  return readSpki(der.value, 'PEM (SubjectPublicKeyInfo)');
}

// JWK -----------------------------------------------------------------------------------------

const COORDINATE_BYTES: Readonly<Record<Curve, number>> = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

function b64urlField(jwk: Record<string, unknown>, name: string): Result<Uint8Array, KeyErrorCode> {
  const v = jwk[name];
  if (typeof v !== 'string' || v === '') return fail('key-jwk', `The JWK has no "${name}" value (a Base64URL string).`);
  const bytes = base64Decode(v, { alphabet: 'url', padding: 'forbidden' });
  return bytes.ok ? bytes : fail('key-jwk', `The JWK's "${name}" is not valid unpadded Base64URL: ${bytes.error.message}`);
}

function declaredOf(jwk: Record<string, unknown>): Result<JwkDeclared, KeyErrorCode> {
  const str = (name: string): Result<string | undefined, KeyErrorCode> => {
    const v = jwk[name];
    return v === undefined || typeof v === 'string' ? ok(v) : fail('key-jwk', `The JWK's "${name}" must be a string.`);
  };
  const alg = str('alg');
  if (!alg.ok) return alg;
  const use = str('use');
  if (!use.ok) return use;
  const kid = str('kid');
  if (!kid.ok) return kid;
  const ops = jwk.key_ops;
  if (ops !== undefined && !(Array.isArray(ops) && ops.every(o => typeof o === 'string'))) return fail('key-jwk', 'The JWK\'s "key_ops" must be an array of strings.');
  return ok({ alg: alg.value, use: use.value, kid: kid.value, keyOps: ops as string[] | undefined });
}

function parseJwkObject(jwk: Record<string, unknown>): Result<PublicKey, KeyErrorCode> {
  const kty = jwk.kty;
  if (typeof kty !== 'string') return fail('key-jwk', 'The JWK has no "kty" (key type).');
  if (kty === 'oct') {
    return fail('key-format', 'This JWK is a shared secret ("kty": "oct"), not a public key. For an HS256, HS384 or HS512 token, choose "Shared secret", format Base64, and paste the JWK\'s "k" value.');
  }
  // Any of these means the JWK includes the private half.
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(name => Object.hasOwn(jwk, name))) {
    return fail('key-private', 'This JWK contains a private key (it has a "d" value or other private parts). Verifying a signature needs only the public key. NetForge does not read it.');
  }
  const declared = declaredOf(jwk);
  if (!declared.ok) return declared;
  if (kty === 'RSA') {
    const n = b64urlField(jwk, 'n');
    if (!n.ok) return n;
    const e = b64urlField(jwk, 'e');
    if (!e.ok) return e;
    return ok({ format: 'jwk', family: 'RSA', jwk: { kty: 'RSA', n: jwk.n as string, e: jwk.e as string }, declared: declared.value, source: 'JWK (RSA)' });
  }
  if (kty === 'EC') {
    const crv = jwk.crv;
    if (crv !== 'P-256' && crv !== 'P-384' && crv !== 'P-521') {
      return fail('key-unsupported', `This elliptic-curve JWK is on ${typeof crv === 'string' ? `"${crv}"` : 'an unnamed curve'}. Only P-256, P-384 and P-521 are supported.`);
    }
    for (const name of ['x', 'y']) {
      const coordinate = b64urlField(jwk, name);
      if (!coordinate.ok) return coordinate;
      if (coordinate.value.length !== COORDINATE_BYTES[crv]) {
        return fail('key-jwk', `The JWK's "${name}" is ${coordinate.value.length} bytes; a ${crv} coordinate is exactly ${COORDINATE_BYTES[crv]}.`);
      }
    }
    return ok({ format: 'jwk', family: 'EC', curve: crv, jwk: { kty: 'EC', crv, x: jwk.x as string, y: jwk.y as string }, declared: declared.value, source: `JWK (EC ${crv})` });
  }
  return fail('key-unsupported', `JWK key type "${kty}" is not supported. Only "RSA" and "EC" public keys are.`);
}

function parseJwkText(text: string, kid: string | undefined): Result<PublicKey, KeyErrorCode> {
  const analysis = analyzeJson(text);
  if (!analysis.ok) return fail('key-jwk', `The key looks like JSON but is not valid (line ${analysis.error.location.line}, column ${analysis.error.location.column}): ${analysis.error.message}`);
  if (analysis.warnings.some(w => w.code === 'duplicate-key')) return fail('key-jwk', 'The JWK repeats a name, so it is ambiguous. NetForge rejects it.');
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('key-jwk', 'A JWK is a JSON object.');
  const object = value as Record<string, unknown>;
  if (!Object.hasOwn(object, 'keys')) return parseJwkObject(object);

  // A JWK Set that the user pasted. The token's "kid" picks the key; nothing is ever fetched.
  const keys = object.keys;
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'object' || k === null || Array.isArray(k))) return fail('key-jwk', 'The JWK Set\'s "keys" must be an array of JWK objects.');
  const list = keys as Record<string, unknown>[];
  if (list.length === 0) return fail('key-not-found', 'The JWK Set is empty.');
  if (kid === undefined) {
    if (list.length === 1) return parseJwkObject(list[0]);
    return fail('key-not-found', `The JWK Set has ${list.length} keys and the token has no "kid" to choose one. Paste the single key that should verify it.`);
  }
  const matches = list.filter(k => k.kid === kid);
  if (matches.length === 0) return fail('key-not-found', `No key in the JWK Set has the token's "kid" (${JSON.stringify(kid)}).`);
  if (matches.length > 1) return fail('key-not-found', `${matches.length} keys in the JWK Set share the token's "kid" (${JSON.stringify(kid)}), so the choice is ambiguous.`);
  return parseJwkObject(matches[0]);
}

/**
 * Reads a public key the user pasted: PEM or JWK (or a pasted JWK Set, from which the token's
 * `kid` selects a key).
 */
export function parsePublicKey(text: string, kid?: string): Result<PublicKey, KeyErrorCode> {
  const trimmed = text.trim();
  if (trimmed === '') return fail('key-empty', 'Paste the public key to verify the signature.');
  if (text.length > MAX_KEY_CHARS) return fail('key-format', `The key is longer than ${MAX_KEY_CHARS.toLocaleString('en-US')} characters.`);
  if (trimmed.startsWith('-----BEGIN')) return parsePem(trimmed);
  if (trimmed.startsWith('{')) return parseJwkText(trimmed, kid);
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)/.test(trimmed)) {
    return fail('key-format', 'This is an OpenSSH public key. Convert it to PEM first (for example: ssh-keygen -e -m PKCS8 -f key.pub).');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return fail('key-format', 'This is a URL. NetForge never fetches keys: open the address yourself, check that it is the issuer\'s, and paste the key here.');
  }
  return fail('key-format', 'This is not a key format NetForge reads. Paste a PEM public key ("-----BEGIN PUBLIC KEY-----") or a JWK (a JSON object with "kty").');
}
