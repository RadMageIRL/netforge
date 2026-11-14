/**
 * JSON Web Token inspection (RFC 7519 claims in an RFC 7515 compact JWS). Decoding only reads the
 * token: nothing in it is executed, fetched or trusted. Verification lives in verify.ts.
 */
import { base64Decode, utf8Decode } from '../codec/codec';
import { analyzeJson } from '../data/json';
import { fail, ok, type Result } from '../result';

export type JwtErrorCode =
  | 'empty'
  | 'too-large'
  | 'whitespace'
  | 'segment-count'
  | 'encrypted'
  | 'segment-empty'
  | 'segment-encoding'
  | 'header-utf8'
  | 'header-json'
  | 'header-not-object'
  | 'header-duplicate'
  | 'alg-missing'
  | 'payload-utf8'
  | 'payload-json'
  | 'payload-not-object'
  | 'payload-duplicate';

export const MAX_JWT_CHARS = 200_000;

export type AlgFamily = 'HMAC' | 'RSA' | 'EC';

export interface AlgInfo {
  readonly name: string;
  readonly family: AlgFamily;
  readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
  readonly description: string;
  /** EC only. */
  readonly curve?: 'P-256' | 'P-384' | 'P-521';
  /** Exact signature size in bytes for HMAC and EC; RSA signatures are as long as the modulus. */
  readonly signatureBytes?: number;
}

export const SUPPORTED_ALGS: Readonly<Record<string, AlgInfo>> = {
  HS256: { name: 'HS256', family: 'HMAC', hash: 'SHA-256', signatureBytes: 32, description: 'HMAC with SHA-256 (a shared secret)' },
  HS384: { name: 'HS384', family: 'HMAC', hash: 'SHA-384', signatureBytes: 48, description: 'HMAC with SHA-384 (a shared secret)' },
  HS512: { name: 'HS512', family: 'HMAC', hash: 'SHA-512', signatureBytes: 64, description: 'HMAC with SHA-512 (a shared secret)' },
  RS256: { name: 'RS256', family: 'RSA', hash: 'SHA-256', description: 'RSASSA-PKCS1-v1_5 with SHA-256 (an RSA key pair)' },
  RS384: { name: 'RS384', family: 'RSA', hash: 'SHA-384', description: 'RSASSA-PKCS1-v1_5 with SHA-384 (an RSA key pair)' },
  RS512: { name: 'RS512', family: 'RSA', hash: 'SHA-512', description: 'RSASSA-PKCS1-v1_5 with SHA-512 (an RSA key pair)' },
  ES256: { name: 'ES256', family: 'EC', hash: 'SHA-256', curve: 'P-256', signatureBytes: 64, description: 'ECDSA with P-256 and SHA-256 (an elliptic-curve key pair)' },
  ES384: { name: 'ES384', family: 'EC', hash: 'SHA-384', curve: 'P-384', signatureBytes: 96, description: 'ECDSA with P-384 and SHA-384 (an elliptic-curve key pair)' },
  ES512: { name: 'ES512', family: 'EC', hash: 'SHA-512', curve: 'P-521', signatureBytes: 132, description: 'ECDSA with P-521 and SHA-512 (an elliptic-curve key pair)' },
};

/** Algorithms that exist but that NetForge does not verify, with what to tell the user. */
const KNOWN_UNSUPPORTED: Readonly<Record<string, string>> = {
  none: 'The token is unsecured ("alg": "none"): it has no signature at all, so anyone could have written it and nothing can be verified.',
  PS256: 'RSASSA-PSS (PS256) is not supported here.',
  PS384: 'RSASSA-PSS (PS384) is not supported here.',
  PS512: 'RSASSA-PSS (PS512) is not supported here.',
  EdDSA: 'EdDSA is not supported here.',
  Ed25519: 'Ed25519 is not supported here.',
  ES256K: 'ECDSA with secp256k1 (ES256K) is not supported here.',
};

export function unsupportedAlgReason(alg: string): string {
  if (Object.hasOwn(KNOWN_UNSUPPORTED, alg)) return KNOWN_UNSUPPORTED[alg];
  const close = Object.keys(SUPPORTED_ALGS).find(name => name.toLowerCase() === alg.toLowerCase());
  if (close) return `"${alg}" is not a JWS algorithm name. Names are case-sensitive: did the issuer mean "${close}"? NetForge does not guess.`;
  return `"${alg}" is not an algorithm NetForge verifies. Supported: ${Object.keys(SUPPORTED_ALGS).join(', ')}.`;
}

export type PayloadKind = 'claims' | 'text' | 'binary';

export interface DecodedJwt {
  /** The token as verified: three Base64URL segments joined by dots, nothing else. */
  readonly token: string;
  readonly segments: readonly [string, string, string];
  /** The exact ASCII text the signature covers: header segment, a dot, payload segment. */
  readonly signingInput: string;
  readonly header: Readonly<Record<string, unknown>>;
  readonly headerJson: string;
  readonly alg: string;
  /** Null when the algorithm is not one NetForge verifies. */
  readonly algInfo: AlgInfo | null;
  readonly payloadKind: PayloadKind;
  /** The claims object, when the payload is a JSON object. */
  readonly claims: Readonly<Record<string, unknown>> | null;
  /** Formatted JSON for a claims payload; the text itself for a text payload; null for binary. */
  readonly payloadText: string | null;
  readonly payloadBytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly notes: readonly string[];
}

const SEGMENT_NAMES = ['header', 'payload', 'signature'] as const;

function parseObject(text: string, what: 'header' | 'payload'): Result<{ value: Record<string, unknown>; pretty: string }, JwtErrorCode> {
  // The JSON analyzer skips a leading byte order mark with a warning; JSON.parse does not. A JOSE
  // header or claims set never starts with one (RFC 8259 section 8.1), so it is an error here.
  if (text.charCodeAt(0) === 0xfeff) {
    return fail(`${what}-json`, `The ${what} is not valid JSON: it starts with a byte order mark (U+FEFF), which JSON does not allow.`);
  }
  const analysis = analyzeJson(text, { kind: 'pretty', indent: '  ' });
  if (!analysis.ok) {
    const { line, column } = analysis.error.location;
    return fail(`${what}-json`, `The ${what} is not valid JSON (line ${line}, column ${column}): ${analysis.error.message}`);
  }
  if (analysis.stats.rootType !== 'object') {
    return fail(`${what}-not-object`, `The ${what} is JSON, but ${analysis.stats.rootType === 'array' ? 'an array' : `a ${analysis.stats.rootType}`} rather than an object.`);
  }
  const duplicate = analysis.warnings.find(w => w.code === 'duplicate-key');
  if (duplicate) {
    return fail(`${what}-duplicate`, `The ${what} repeats a name (${duplicate.message}). Parsers disagree about which value wins, so a token like this can mean different things to different systems; NetForge rejects it.`);
  }
  return ok({ value: JSON.parse(text) as Record<string, unknown>, pretty: analysis.output ?? text });
}

/**
 * Splits and decodes a compact JWS. Structure is checked strictly: exactly three segments, each
 * unpadded Base64URL, a JSON object header with a string "alg". A payload that is not a JSON
 * object is still decoded (a JWS can sign anything) and labeled as not being a claims set.
 */
export function decodeJwt(input: string): Result<DecodedJwt, JwtErrorCode> {
  const notes: string[] = [];
  let token = input.trim();
  if (token === '') return fail('empty', 'Paste a token to decode it.');
  const bearer = /^Bearer[ \t]+/i.exec(token);
  if (bearer) {
    token = token.slice(bearer[0].length).trim();
    notes.push('A leading "Bearer" (the HTTP Authorization scheme) was removed; it is not part of the token.');
  }
  if (token.length > MAX_JWT_CHARS) {
    return fail('too-large', `The token has ${token.length.toLocaleString('en-US')} characters; the limit is ${MAX_JWT_CHARS.toLocaleString('en-US')}. Nothing was decoded.`);
  }
  const space = /\s/.exec(token);
  if (space) {
    return fail('whitespace', `The token contains whitespace at position ${space.index + 1}. A token is one unbroken run of characters; remove line breaks or spaces added by copying.`, space.index);
  }
  const segments = token.split('.');
  if (segments.length === 5) {
    return fail('encrypted', 'This has five segments, which is an encrypted token (JWE). Its contents cannot be read without the decryption key, and NetForge does not decrypt tokens.');
  }
  if (segments.length !== 3) {
    return fail('segment-count', `A signed token has exactly three segments separated by dots (header.payload.signature); this has ${segments.length}.`);
  }
  const decoded: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < 3; i++) {
    if (i < 2 && segments[i] === '') return fail('segment-empty', `The ${SEGMENT_NAMES[i]} segment is empty.`, offset);
    const bytes = base64Decode(segments[i], { alphabet: 'url', padding: 'forbidden' });
    if (!bytes.ok) {
      return fail('segment-encoding', `The ${SEGMENT_NAMES[i]} segment is not valid unpadded Base64URL: ${bytes.error.message}`, offset + (bytes.error.offset ?? 0));
    }
    decoded.push(bytes.value);
    offset += segments[i].length + 1;
  }

  const headerText = utf8Decode(decoded[0]);
  if (!headerText.ok) return fail('header-utf8', `The header is not valid UTF-8: ${headerText.error.message}`);
  const header = parseObject(headerText.value, 'header');
  if (!header.ok) return header;
  const alg = header.value.value.alg;
  if (typeof alg !== 'string' || alg === '') {
    return fail('alg-missing', 'The header has no "alg" value (or it is not a string), so the token does not say how it was signed.');
  }

  let payloadKind: PayloadKind;
  let claims: Record<string, unknown> | null = null;
  let payloadText: string | null;
  const payloadUtf8 = utf8Decode(decoded[1]);
  // A JWS can sign any bytes. The payload must be a claims object when the header says the token
  // is a JWT, or when it plainly sets out to be a JSON object; otherwise it is shown as it is.
  const typ = header.value.value.typ;
  const declaredJwt = typeof typ === 'string' && /^(application\/)?(at\+)?jwt$/i.test(typ);
  if (!payloadUtf8.ok) {
    if (declaredJwt) return fail('payload-utf8', `The header says this is a JWT, but the payload is not valid UTF-8: ${payloadUtf8.error.message}`);
    payloadKind = 'binary';
    payloadText = null;
    notes.push('The payload is not UTF-8 text, so this is a signed object (JWS) carrying binary data, not a JWT claims set.');
  } else {
    const payload = parseObject(payloadUtf8.value, 'payload');
    if (payload.ok) {
      payloadKind = 'claims';
      claims = payload.value.value;
      payloadText = payload.value.pretty;
    } else if (declaredJwt || /^\s*\{/.test(payloadUtf8.value)) {
      return payload;
    } else {
      payloadKind = 'text';
      payloadText = payloadUtf8.value;
      notes.push('The payload is text but not a JSON object, so this is a signed object (JWS), not a JWT claims set.');
    }
  }

  for (const name of ['jku', 'x5u', 'jwk', 'x5c'] as const) {
    if (Object.hasOwn(header.value.value, name)) {
      notes.push(name === 'jku' || name === 'x5u'
        ? `The header has "${name}", a URL where the issuer says its keys are. NetForge never fetches it: a token must not choose the key that verifies it.`
        : `The header carries a key in "${name}". NetForge ignores it: a token must not supply the key that verifies it.`);
    }
  }

  return ok({
    token,
    segments: [segments[0], segments[1], segments[2]],
    signingInput: `${segments[0]}.${segments[1]}`,
    header: header.value.value,
    headerJson: header.value.pretty,
    alg,
    algInfo: Object.hasOwn(SUPPORTED_ALGS, alg) ? SUPPORTED_ALGS[alg] : null,
    payloadKind,
    claims,
    payloadText,
    payloadBytes: decoded[1],
    signature: decoded[2],
    notes,
  });
}
