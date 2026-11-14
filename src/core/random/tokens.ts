/**
 * UUIDs (RFC 9562 versions 4 and 7) and random tokens. Randomness is supplied by the caller: the
 * app passes the browser's cryptographically secure generator (crypto.getRandomValues), and tests
 * pass fixed bytes. Nothing here can fall back to a weaker generator.
 */
import { base64Encode, hexEncode } from '../codec/codec';
import { fail, ok, type Result } from '../result';

/** Fills the array with random bytes. Must be a cryptographically secure source. */
export type RandomFill = (bytes: Uint8Array) => void;

export const TOKEN_LIMITS = { minBytes: 1, maxBytes: 1024, minCount: 1, maxCount: 1000 } as const;

export type TokenKind = 'uuid-v4' | 'uuid-v7' | 'hex' | 'base64url';

function formatUuid(bytes: Uint8Array): string {
  const hex = hexEncode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID version 4: 122 random bits, with the version (4) and variant (10) bits set. */
export function uuidV4(fill: RandomFill): string {
  const bytes = new Uint8Array(16);
  fill(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** The largest timestamp a version 7 UUID can hold: 48 bits of milliseconds. */
export const UUID_V7_MAX_MS = 2 ** 48 - 1;

/**
 * UUID version 7 (RFC 9562 section 5.7): a 48-bit Unix timestamp in milliseconds, then random
 * bits. UUIDs made by one generator sort in the order they were made, using the RFC's "fixed bit
 * length dedicated counter" (section 6.2, method 1): the 12 bits after the version hold a counter
 * that starts at a random value each millisecond (with its top bit clear, leaving room to count)
 * and goes up by one for each further UUID in that millisecond. If the counter runs out, or the
 * clock goes backwards, the timestamp moves one millisecond ahead instead of repeating.
 * The last 62 bits are fresh random bits every time.
 */
export class UuidV7Generator {
  private lastMs = -1;
  private counter = 0;

  constructor(private readonly fill: RandomFill, private readonly now: () => number) {}

  next(): string {
    const bytes = new Uint8Array(16);
    this.fill(bytes);
    let ms = Math.floor(this.now());
    if (!(ms >= 0) || ms > UUID_V7_MAX_MS) throw new RangeError('The clock is outside the range a version 7 UUID can hold.');
    if (ms > this.lastMs) {
      this.counter = ((bytes[6] & 0x07) << 8) | bytes[7];
    } else {
      ms = this.lastMs;
      this.counter++;
      if (this.counter > 0xfff) {
        ms = this.lastMs + 1;
        if (ms > UUID_V7_MAX_MS) throw new RangeError('The clock is outside the range a version 7 UUID can hold.');
        this.counter = ((bytes[6] & 0x07) << 8) | bytes[7];
      }
    }
    this.lastMs = ms;
    let rest = ms;
    for (let i = 5; i >= 0; i--) {
      bytes[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    bytes[6] = 0x70 | (this.counter >> 8);
    bytes[7] = this.counter & 0xff;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(bytes);
  }
}

export interface UuidInfo {
  readonly version: number;
  /** True for the RFC 9562 variant (the 10xx bit pattern). */
  readonly rfcVariant: boolean;
  /** Version 7 only: the embedded Unix time in milliseconds. */
  readonly timestampMs: number | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads the version, variant and (for version 7) timestamp of a UUID in canonical lowercase form. */
export function inspectUuid(text: string): UuidInfo | null {
  if (!UUID_PATTERN.test(text)) return null;
  const hex = text.replace(/-/g, '');
  const version = parseInt(hex[12], 16);
  const rfcVariant = (parseInt(hex[16], 16) & 0xc) === 0x8;
  return { version, rfcVariant, timestampMs: version === 7 && rfcVariant ? parseInt(hex.slice(0, 12), 16) : null };
}

/** `count` random bytes as hex (two characters per byte) or unpadded Base64URL. */
export function randomToken(fill: RandomFill, byteLength: number, format: 'hex' | 'base64url'): string {
  const bytes = new Uint8Array(byteLength);
  fill(bytes);
  return format === 'hex' ? hexEncode(bytes) : base64Encode(bytes, { alphabet: 'url', pad: false });
}

export interface GenerateRequest {
  readonly kind: TokenKind;
  readonly count: number;
  /** Random tokens only. */
  readonly byteLength?: number;
}

export interface Generated {
  readonly values: readonly string[];
  /** Random bits in each value. */
  readonly randomBits: number;
  /** Characters in each value. */
  readonly length: number;
  /** What the numbers mean and what they do not. */
  readonly notes: readonly string[];
}

export type GenerateErrorCode = 'count' | 'bytes';

const COMMON_NOTE = 'The bits come from this browser\'s cryptographically secure generator. That number describes how hard a value is to guess, not how safe it is in use: that depends on how it is stored, sent and checked.';

export function generate(request: GenerateRequest, fill: RandomFill, now: () => number): Result<Generated, GenerateErrorCode> {
  const { kind, count } = request;
  if (!Number.isInteger(count) || count < TOKEN_LIMITS.minCount || count > TOKEN_LIMITS.maxCount) {
    return fail('count', `Enter how many to generate, from ${TOKEN_LIMITS.minCount} to ${TOKEN_LIMITS.maxCount.toLocaleString('en-US')}.`);
  }
  const values: string[] = [];
  if (kind === 'uuid-v4') {
    for (let i = 0; i < count; i++) values.push(uuidV4(fill));
    return ok({
      values, randomBits: 122, length: 36,
      notes: ['A version 4 UUID has 122 random bits; the other 6 mark the version and variant.', 'A UUID is an identifier. If you need a secret (a password reset link, an API key), use a random token instead.', COMMON_NOTE],
    });
  }
  if (kind === 'uuid-v7') {
    const generator = new UuidV7Generator(fill, now);
    for (let i = 0; i < count; i++) values.push(generator.next());
    return ok({
      values, randomBits: 62, length: 36,
      notes: [
        'A version 7 UUID starts with the time it was made (48 bits, to the millisecond), so anyone who sees it can read that time, and values sort in creation order.',
        'At least 62 bits are random. The 12 bits after the version are a counter that starts at a random value each millisecond and keeps values from one batch in order.',
        'Do not use a version 7 UUID as a secret.',
        COMMON_NOTE,
      ],
    });
  }
  const byteLength = request.byteLength ?? 0;
  if (!Number.isInteger(byteLength) || byteLength < TOKEN_LIMITS.minBytes || byteLength > TOKEN_LIMITS.maxBytes) {
    return fail('bytes', `Enter a length in bytes, from ${TOKEN_LIMITS.minBytes} to ${TOKEN_LIMITS.maxBytes.toLocaleString('en-US')}.`);
  }
  for (let i = 0; i < count; i++) values.push(randomToken(fill, byteLength, kind));
  const notes = [`Each token is ${byteLength} random ${byteLength === 1 ? 'byte' : 'bytes'} (${byteLength * 8} bits), written as ${kind === 'hex' ? 'hexadecimal (2 characters per byte)' : 'Base64URL without padding (4 characters per 3 bytes)'}.`];
  if (byteLength < 16) notes.push('Fewer than 16 bytes (128 bits) is short for a secret that attackers can try guesses against.');
  notes.push(COMMON_NOTE);
  return ok({ values, randomBits: byteLength * 8, length: values[0].length, notes });
}
