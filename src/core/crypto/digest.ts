/**
 * Hashes and HMACs. SHA digests and HMAC come from the Web Crypto API, passed in by the caller
 * (the browser's crypto.subtle; Node's in tests), so this module holds no cryptography of its own
 * apart from the legacy MD5 in md5.ts.
 */
import { base64Decode, base64Encode, hexDecode, hexEncode, utf8Encode } from '../codec/codec';
import { fail, ok, type Result } from '../result';
import { md5 } from './md5';

export type HashId = 'SHA-256' | 'SHA-384' | 'SHA-512' | 'SHA-1' | 'MD5';
export type HmacHashId = 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface HashInfo {
  readonly id: HashId;
  readonly label: string;
  readonly bits: number;
  /** Shown beside the name; legacy algorithms must never be presented as safe. */
  readonly caution: string | null;
}

export const HASHES: readonly HashInfo[] = [
  { id: 'SHA-256', label: 'SHA-256', bits: 256, caution: null },
  { id: 'SHA-384', label: 'SHA-384', bits: 384, caution: null },
  { id: 'SHA-512', label: 'SHA-512', bits: 512, caution: null },
  { id: 'SHA-1', label: 'SHA-1', bits: 160, caution: 'Legacy. Collisions have been produced; do not use it for signatures or new designs.' },
  { id: 'MD5', label: 'MD5', bits: 128, caution: 'Legacy and broken. Not suitable for anything security-sensitive; use it only to check old checksums.' },
];

export const HMAC_HASHES: readonly { id: HmacHashId; label: string; bits: number }[] = [
  { id: 'SHA-256', label: 'HMAC-SHA256', bits: 256 },
  { id: 'SHA-384', label: 'HMAC-SHA384', bits: 384 },
  { id: 'SHA-512', label: 'HMAC-SHA512', bits: 512 },
];

/** Largest file or text the hash tool reads: Web Crypto needs the whole input in memory at once. */
export const MAX_HASH_BYTES = 512 * 1024 * 1024;

/** The part of SubtleCrypto this module uses. */
export type Subtle = Pick<SubtleCrypto, 'digest' | 'importKey' | 'sign'>;

export async function digest(subtle: Subtle, id: HashId, data: Uint8Array): Promise<Uint8Array> {
  if (id === 'MD5') return md5(data);
  return new Uint8Array(await subtle.digest(id, data as BufferSource));
}

export async function hmac(subtle: Subtle, hash: HmacHashId, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (key.length === 0) throw new RangeError('An HMAC key must not be empty.');
  const imported = await subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', imported, data as BufferSource));
}

export type KeyFormat = 'text' | 'hex' | 'base64';
export type KeyErrorCode = 'key-empty' | 'key-invalid';

/**
 * Reads an HMAC key as typed: UTF-8 text exactly as entered (no trimming), hex, or Base64 in
 * either alphabet with optional padding. Hex and Base64 ignore surrounding whitespace only.
 */
export function parseKey(text: string, format: KeyFormat): Result<Uint8Array, KeyErrorCode> {
  let bytes: Uint8Array;
  if (format === 'text') {
    const encoded = utf8Encode(text);
    if (!encoded.ok) return fail('key-invalid', encoded.error.message);
    bytes = encoded.value;
  } else if (format === 'hex') {
    const decoded = hexDecode(text.trim());
    if (!decoded.ok) return fail('key-invalid', `The key is not valid hexadecimal: ${decoded.error.message}`);
    bytes = decoded.value;
  } else {
    const trimmed = text.trim();
    const url = /[-_]/.test(trimmed);
    const decoded = base64Decode(trimmed, { alphabet: url ? 'url' : 'standard', padding: 'optional' });
    if (!decoded.ok) return fail('key-invalid', `The key is not valid Base64: ${decoded.error.message}`);
    bytes = decoded.value;
  }
  if (bytes.length === 0) return fail('key-empty', 'Enter a key. An HMAC needs a secret key of at least one byte.');
  return ok(bytes);
}

export interface DigestText {
  readonly hex: string;
  readonly base64: string;
}

export function digestText(bytes: Uint8Array): DigestText {
  return { hex: hexEncode(bytes), base64: base64Encode(bytes) };
}

/**
 * Compares a digest someone published with the computed ones. Hex is compared without regard to
 * case, Base64 exactly; surrounding whitespace is ignored. Returns the index of the first match.
 */
export function matchExpected(expected: string, digests: readonly DigestText[]): { index: number; form: 'hex' | 'base64' } | null {
  const want = expected.trim();
  if (want === '') return null;
  const lower = want.toLowerCase();
  for (let i = 0; i < digests.length; i++) {
    if (digests[i].hex === lower) return { index: i, form: 'hex' };
    if (digests[i].base64 === want) return { index: i, form: 'base64' };
  }
  return null;
}
