/**
 * JWT signature verification with a key the user supplies, through the Web Crypto API.
 *
 * The rules that matter for safety are all here, before any cryptography runs:
 * - the algorithm must be one of nine known names, matched exactly;
 * - the key must be of the type the algorithm uses (a secret for HS, RSA for RS, the right curve
 *   for ES), so a public key can never be used as an HMAC secret;
 * - the signature must have the exact size the algorithm produces;
 * - tokens that demand extensions ("crit") are refused rather than half-understood.
 *
 * "Verified" means one thing only: this key produced this signature over this header and payload.
 * It does not mean the token is authorized, current, or issued by anyone in particular.
 */
import type { DecodedJwt } from './jwt';
import { unsupportedAlgReason } from './jwt';
import { parsePublicKey, parseSecret, type KeyErrorCode, type PublicKey, type SecretFormat } from './keys';

export type KeyInput =
  | { readonly kind: 'secret'; readonly text: string; readonly format: SecretFormat }
  | { readonly kind: 'public'; readonly text: string };

export type VerifyRejectCode =
  | KeyErrorCode
  | 'alg-none'
  | 'alg-unsupported'
  | 'critical-header'
  | 'key-type-mismatch'
  | 'curve-mismatch'
  | 'key-use'
  | 'key-alg'
  | 'signature-malformed'
  | 'key-import'
  | 'crypto-unavailable';

export type VerifyOutcome =
  | { readonly status: 'verified'; readonly alg: string; readonly keySource: string; readonly warnings: readonly string[] }
  | { readonly status: 'failed'; readonly alg: string; readonly message: string; readonly warnings: readonly string[] }
  | { readonly status: 'rejected'; readonly code: VerifyRejectCode; readonly message: string };

/** The part of SubtleCrypto verification uses. */
export type VerifySubtle = Pick<SubtleCrypto, 'importKey' | 'verify'>;

const HASH_BYTES = { 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 } as const;
/** RFC 7518 section 3.3: RSA keys for JWS must be 2048 bits or larger. */
export const MIN_RSA_BITS = 2048;

const reject = (code: VerifyRejectCode, message: string): VerifyOutcome => ({ status: 'rejected', code, message });

const FAILED = 'The signature does not match. Either the token was changed after it was signed, or it was signed with a different key than the one given here.';

export async function verifyJwt(subtle: VerifySubtle | undefined, jwt: DecodedJwt, key: KeyInput): Promise<VerifyOutcome> {
  const info = jwt.algInfo;
  if (jwt.alg === 'none') return reject('alg-none', unsupportedAlgReason('none'));
  if (!info) return reject('alg-unsupported', unsupportedAlgReason(jwt.alg));
  if (Object.hasOwn(jwt.header, 'crit') || jwt.header.b64 === false) {
    return reject('critical-header', 'The header marks extensions as critical ("crit"), which a verifier must understand or else reject the token. NetForge supports none, so it does not verify this token.');
  }
  if (!subtle) {
    return reject('crypto-unavailable', 'This page cannot reach the browser\'s Web Crypto API, which is only available on HTTPS or localhost. The signature was not checked.');
  }

  const data = new TextEncoder().encode(jwt.signingInput);
  const signature = jwt.signature;
  const warnings: string[] = [];

  if (info.family === 'HMAC') {
    if (key.kind !== 'secret') {
      return reject('key-type-mismatch', `${info.name} is an HMAC algorithm: it is verified with the shared secret, never with a public key. If you expected a public-key signature (RS256 or ES256), this token is not what you expected.`);
    }
    const secret = parseSecret(key.text, key.format);
    if (!secret.ok) return reject(secret.error.code, secret.error.message);
    const size = HASH_BYTES[info.hash];
    if (signature.length !== size) {
      return reject('signature-malformed', `An ${info.name} signature is exactly ${size} bytes; this one is ${signature.length}. The token is malformed.`);
    }
    if (secret.value.length < size) {
      warnings.push(`The secret is ${secret.value.length} bytes. RFC 7518 requires at least ${size} bytes for ${info.name}; a short secret can be guessed by trying candidates against a captured token.`);
    }
    let imported: CryptoKey;
    try {
      imported = await subtle.importKey('raw', secret.value as BufferSource, { name: 'HMAC', hash: info.hash }, false, ['verify']);
    } catch (error) {
      return reject('key-import', `The browser could not use this secret: ${(error as Error).message}`);
    }
    const good = await subtle.verify('HMAC', imported, signature as BufferSource, data as BufferSource);
    return good ? { status: 'verified', alg: info.name, keySource: 'shared secret', warnings } : { status: 'failed', alg: info.name, message: FAILED, warnings };
  }

  if (key.kind !== 'public') {
    return reject('key-type-mismatch', `${info.name} is a public-key algorithm: it is verified with the issuer's ${info.family === 'RSA' ? 'RSA' : 'elliptic-curve'} public key, not a shared secret.`);
  }
  const kid = typeof jwt.header.kid === 'string' ? jwt.header.kid : undefined;
  const parsed = parsePublicKey(key.text, kid);
  if (!parsed.ok) return reject(parsed.error.code, parsed.error.message);
  const publicKey: PublicKey = parsed.value;

  if (publicKey.family !== info.family) {
    const have = publicKey.family === 'RSA' ? 'an RSA key' : `an elliptic-curve key (${publicKey.curve})`;
    return reject('key-type-mismatch', `The token says ${info.name}, which needs ${info.family === 'RSA' ? 'an RSA key' : `an elliptic-curve key on ${info.curve}`}, but this is ${have}.`);
  }
  if (publicKey.family === 'EC' && publicKey.curve !== info.curve) {
    return reject('curve-mismatch', `${info.name} uses curve ${info.curve}, but this key is on ${publicKey.curve}.`);
  }
  if (publicKey.format === 'jwk') {
    const d = publicKey.declared;
    if (d.use !== undefined && d.use !== 'sig') return reject('key-use', `This JWK is marked for "${d.use}" ("use"), not for signatures ("sig").`);
    if (d.keyOps !== undefined && !d.keyOps.includes('verify')) return reject('key-use', 'This JWK\'s "key_ops" does not include "verify".');
    if (d.alg !== undefined && d.alg !== info.name) return reject('key-alg', `This JWK is restricted to ${d.alg} ("alg"), but the token says ${info.name}.`);
  }

  const algorithm = info.family === 'RSA'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: info.hash }
    : { name: 'ECDSA', namedCurve: info.curve! };
  let imported: CryptoKey;
  try {
    imported = publicKey.format === 'spki'
      ? await subtle.importKey('spki', publicKey.der as BufferSource, algorithm, false, ['verify'])
      : await subtle.importKey('jwk', publicKey.jwk, algorithm, false, ['verify']);
  } catch (error) {
    const name = (error as Error).name;
    return reject('key-import', name === 'NotSupportedError'
      ? `This browser's Web Crypto does not support ${info.family === 'EC' ? `curve ${info.curve}` : 'this key'}, so the signature was not checked.`
      : 'The browser rejected this key: its contents are not a valid public key of the stated type.');
  }

  if (info.family === 'RSA') {
    const bits = (imported.algorithm as RsaHashedKeyAlgorithm).modulusLength;
    const size = Math.ceil(bits / 8);
    if (signature.length !== size) {
      return reject('signature-malformed', `An RSA signature is as long as the key: ${size} bytes for this ${bits}-bit key. This one is ${signature.length} bytes, so it was not made with this key or the token is malformed.`);
    }
    if (bits < MIN_RSA_BITS) warnings.push(`This RSA key is ${bits} bits. RFC 7518 requires at least ${MIN_RSA_BITS}; smaller keys can be broken.`);
  } else if (signature.length !== info.signatureBytes) {
    return reject('signature-malformed', `An ${info.name} signature is exactly ${info.signatureBytes} bytes (two ${info.signatureBytes! / 2}-byte numbers); this one is ${signature.length}. Signatures in ASN.1 (DER) form are not valid in a JWT.`);
  }

  const good = info.family === 'RSA'
    ? await subtle.verify('RSASSA-PKCS1-v1_5', imported, signature as BufferSource, data as BufferSource)
    : await subtle.verify({ name: 'ECDSA', hash: info.hash }, imported, signature as BufferSource, data as BufferSource);
  return good
    ? { status: 'verified', alg: info.name, keySource: publicKey.source, warnings }
    : { status: 'failed', alg: info.name, message: FAILED, warnings };
}
