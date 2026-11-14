/**
 * Byte encodings: UTF-8, Base64 (RFC 4648 standard and URL-safe alphabets), hexadecimal and URL
 * percent-encoding (RFC 3986). Everything is strict by default: malformed input is an error that
 * points at the offending position, never a silent repair. The lenient options are explicit.
 */
import { fail, ok, type Result } from '../result';
import { describeCharAt } from '../text';

export type CodecErrorCode =
  | 'invalid-utf8'
  | 'lone-surrogate'
  | 'base64-character'
  | 'base64-alphabet'
  | 'base64-length'
  | 'base64-padding'
  | 'base64-trailing-bits'
  | 'hex-character'
  | 'hex-odd-length'
  | 'percent-incomplete'
  | 'percent-hex';

const REPLACEMENT = String.fromCharCode(0xfffd);

// UTF-8 ---------------------------------------------------------------------------------------

/**
 * Offset of the first lone surrogate (a UTF-16 half without its partner), or -1. A JavaScript
 * string can hold one; UTF-8 cannot.
 */
export function findLoneSurrogate(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else return i;
    } else if (code >= 0xdc00 && code <= 0xdfff) return i;
  }
  return -1;
}

/** Text to UTF-8 bytes. A lone surrogate is an error unless `replace` turns it into U+FFFD. */
export function utf8Encode(text: string, options: { replace?: boolean } = {}): Result<Uint8Array, CodecErrorCode> {
  const lone = findLoneSurrogate(text);
  if (lone >= 0 && !options.replace) {
    const code = text.charCodeAt(lone).toString(16).toUpperCase();
    return fail('lone-surrogate', `The text has an unpaired surrogate (U+${code}) at position ${lone + 1}, which has no UTF-8 encoding.`, lone);
  }
  // TextEncoder replaces lone surrogates with U+FFFD, which is exactly the explicit replace mode.
  return ok(new TextEncoder().encode(text));
}

/**
 * Offset of the first byte that is not part of a well-formed UTF-8 sequence (Unicode table 3-7:
 * no overlong forms, no surrogates, nothing above U+10FFFF, no truncated sequences), or -1.
 */
export function findInvalidUtf8(bytes: Uint8Array): number {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) { i++; continue; }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b === 0xe0) { need = 2; lo = 0xa0; }
    else if (b >= 0xe1 && b <= 0xec) need = 2;
    else if (b === 0xed) { need = 2; hi = 0x9f; }
    else if (b === 0xee || b === 0xef) need = 2;
    else if (b === 0xf0) { need = 3; lo = 0x90; }
    else if (b >= 0xf1 && b <= 0xf3) need = 3;
    else if (b === 0xf4) { need = 3; hi = 0x8f; }
    else return i;
    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return i;
      const c = bytes[i + k];
      if (k === 1 ? c < lo || c > hi : c < 0x80 || c > 0xbf) return i;
    }
    i += need + 1;
  }
  return -1;
}

/**
 * UTF-8 bytes to text. Invalid bytes are an error with the byte offset unless `replace` asks for
 * U+FFFD in their place. A leading byte order mark is kept as a character, never dropped.
 */
export function utf8Decode(bytes: Uint8Array, options: { replace?: boolean } = {}): Result<string, CodecErrorCode> {
  if (!options.replace) {
    const bad = findInvalidUtf8(bytes);
    if (bad >= 0) {
      return fail('invalid-utf8', `The bytes are not valid UTF-8: byte ${bad + 1} (0x${hexByte(bytes[bad])}) does not start or continue a valid sequence.`, bad);
    }
  }
  return ok(new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes));
}

/** How many U+FFFD characters replace-mode decoding would insert that the bytes did not contain. */
export function countReplacements(bytes: Uint8Array): number {
  const decoded = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes);
  let inText = 0;
  for (let i = 0; i < decoded.length; i++) if (decoded[i] === REPLACEMENT) inText++;
  // A real U+FFFD in the data is EF BF BD.
  let genuine = 0;
  for (let i = 0; i + 2 < bytes.length; i++) if (bytes[i] === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd) genuine++;
  return inText - genuine;
}

// Hex -----------------------------------------------------------------------------------------

const HEX_LOWER = '0123456789abcdef';
const HEX_UPPER = '0123456789ABCDEF';

function hexByte(b: number): string {
  return HEX_UPPER[b >> 4] + HEX_UPPER[b & 15];
}

export function hexEncode(bytes: Uint8Array, upper = false): string {
  const digits = upper ? HEX_UPPER : HEX_LOWER;
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i++) {
    chunk += digits[bytes[i] >> 4] + digits[bytes[i] & 15];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

const isAsciiSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;

/**
 * Hex digits to bytes. Strict: digits only, an even number of them. Lenient: whitespace, colons,
 * hyphens and commas between bytes are ignored, as is a 0x prefix at the start of a group.
 */
export function hexDecode(text: string, options: { lenient?: boolean } = {}): Result<Uint8Array, CodecErrorCode> {
  const out = new Uint8Array(text.length >> 1);
  let count = 0;
  let high = -1;
  let boundary = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (options.lenient) {
      if (isAsciiSpace(code) || code === 0x3a || code === 0x2d || code === 0x2c) { boundary = true; continue; }
      if (boundary && code === 0x30 && (text.charCodeAt(i + 1) | 0x20) === 0x78) { i++; boundary = false; continue; }
    }
    boundary = false;
    const v = hexValue(code);
    if (v < 0) {
      const hint = !options.lenient && (isAsciiSpace(code) || code === 0x3a || code === 0x2d) ? ' Turn on "Ignore whitespace and separators" to allow it.' : '';
      return fail('hex-character', `${describeCharAt(text, i)} at position ${i + 1} is not a hexadecimal digit.${hint}`, i);
    }
    if (high < 0) high = v;
    else { out[count++] = (high << 4) | v; high = -1; }
  }
  if (high >= 0) return fail('hex-odd-length', `Hexadecimal needs two digits per byte, and this has an odd number of digits (${count * 2 + 1}).`, text.length);
  return ok(out.subarray(0, count));
}

// Base64 --------------------------------------------------------------------------------------

export type Base64Alphabet = 'standard' | 'url';
/** required: RFC 4648 section 4 padding; forbidden: none at all (JWS); optional: none or complete. */
export type Base64Padding = 'required' | 'forbidden' | 'optional';

const B64_STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function reverseTable(alphabet: string): Int8Array {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i;
  return table;
}
const REV_STANDARD = reverseTable(B64_STANDARD);
const REV_URL = reverseTable(B64_URL);

export function base64Encode(bytes: Uint8Array, options: { alphabet?: Base64Alphabet; pad?: boolean } = {}): string {
  const alphabet = options.alphabet === 'url' ? B64_URL : B64_STANDARD;
  const pad = options.pad ?? options.alphabet !== 'url';
  const parts: string[] = [];
  let chunk = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += alphabet[v >> 18] + alphabet[(v >> 12) & 63] + alphabet[(v >> 6) & 63] + alphabet[v & 63];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    chunk += alphabet[v >> 18] + alphabet[(v >> 12) & 63] + (pad ? '==' : '');
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunk += alphabet[v >> 18] + alphabet[(v >> 12) & 63] + alphabet[(v >> 6) & 63] + (pad ? '=' : '');
  }
  parts.push(chunk);
  return parts.join('');
}

export interface Base64DecodeOptions {
  readonly alphabet?: Base64Alphabet;
  /** Default: required for the standard alphabet, optional for the URL alphabet. */
  readonly padding?: Base64Padding;
  /** Ignore ASCII whitespace, accept missing padding and nonzero unused bits. */
  readonly lenient?: boolean;
}

/**
 * Base64 text to bytes. Strict mode accepts exactly what an RFC 4648 encoder produces: the chosen
 * alphabet only, no whitespace, correct padding, and zero in the unused bits of the last character
 * (so two different texts never decode to the same bytes).
 */
export function base64Decode(text: string, options: Base64DecodeOptions = {}): Result<Uint8Array, CodecErrorCode> {
  const url = options.alphabet === 'url';
  const table = url ? REV_URL : REV_STANDARD;
  const other = url ? REV_STANDARD : REV_URL;
  const lenient = options.lenient === true;
  const padding: Base64Padding = lenient ? 'optional' : options.padding ?? (url ? 'optional' : 'required');
  const name = url ? 'Base64URL' : 'Base64';

  const out = new Uint8Array(Math.floor(text.length * 3 / 4) + 3);
  let count = 0;
  let acc = 0;
  let have = 0;
  let digits = 0;
  let pads = 0;
  let firstPad = -1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (lenient && isAsciiSpace(code)) continue;
    if (code === 0x3d) {
      if (firstPad < 0) firstPad = i;
      pads++;
      continue;
    }
    const v = code < 128 ? table[code] : -1;
    if (v < 0) {
      if (code < 128 && other[code] >= 0) {
        return fail('base64-alphabet', `'${text[i]}' at position ${i + 1} belongs to the ${url ? 'standard Base64' : 'Base64URL'} alphabet, not ${name}. ${name} uses ${url ? '"-" and "_"' : '"+" and "/"'}.`, i);
      }
      const hint = !lenient && isAsciiSpace(code) ? ' Turn on "Ignore whitespace and separators" to allow line breaks and spaces.' : '';
      return fail('base64-character', `${describeCharAt(text, i)} at position ${i + 1} is not a ${name} character.${hint}`, i);
    }
    if (pads > 0) return fail('base64-padding', `Padding ("=") can only come at the end, but more data follows it at position ${i + 1}.`, firstPad);
    digits++;
    acc = (acc << 6) | v;
    have += 6;
    if (have >= 8) {
      have -= 8;
      out[count++] = (acc >> have) & 0xff;
      acc &= (1 << have) - 1;
    }
  }
  const tail = digits % 4;
  if (tail === 1) {
    return fail('base64-length', `${name} text cannot have ${digits} characters (not counting padding): a single leftover character holds only 6 bits, less than a byte.`, text.length);
  }
  const expectedPads = tail === 0 ? 0 : 4 - tail;
  if (pads > 0) {
    if (padding === 'forbidden') return fail('base64-padding', 'Padding ("=") is not allowed here.', firstPad);
    if (pads !== expectedPads) {
      return fail('base64-padding', `Wrong padding: ${digits} characters need ${expectedPads === 0 ? 'no padding' : `${expectedPads} "="`}, but there ${pads === 1 ? 'is' : 'are'} ${pads}.`, firstPad);
    }
  } else if (expectedPads > 0 && padding === 'required') {
    return fail('base64-padding', `Padding is missing: ${digits} characters need ${expectedPads} "=" at the end. Unpadded text is accepted as Base64URL, or with "Ignore whitespace and separators" on.`, text.length);
  }
  if (!lenient && acc !== 0) {
    return fail('base64-trailing-bits', `The last character carries bits that are not part of any byte. An encoder would never produce it, so the text is damaged or truncated.`, text.length);
  }
  return ok(out.subarray(0, count));
}

// Percent-encoding ----------------------------------------------------------------------------

function isUnreserved(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
}

/**
 * Percent-encodes bytes for use as a URL component. Only RFC 3986 unreserved characters
 * (letters, digits, "-", ".", "_", "~") stay as they are; every other byte becomes %XX.
 */
export function percentEncode(bytes: Uint8Array, options: { spaceAsPlus?: boolean } = {}): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (isUnreserved(b)) chunk += String.fromCharCode(b);
    else if (b === 0x20 && options.spaceAsPlus) chunk += '+';
    else chunk += `%${hexByte(b)}`;
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return parts.join('');
}

/**
 * Percent-decodes text to bytes. Every "%" must be followed by two hex digits. Characters written
 * without encoding are kept (as their UTF-8 bytes). "+" is a plus sign unless `plusAsSpace` reads
 * it as a space, the way HTML form encoding does.
 */
export function percentDecode(text: string, options: { plusAsSpace?: boolean } = {}): Result<Uint8Array, CodecErrorCode> {
  const lone = findLoneSurrogate(text);
  if (lone >= 0) return fail('lone-surrogate', `The text has an unpaired surrogate at position ${lone + 1}, which has no UTF-8 encoding.`, lone);
  const out: number[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x25) {
      if (i + 2 >= text.length) return fail('percent-incomplete', `"%" at position ${i + 1} must be followed by two hexadecimal digits, but the text ends first. A literal percent sign is written %25.`, i);
      const hi = hexValue(text.charCodeAt(i + 1));
      const lo = hexValue(text.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return fail('percent-hex', `"%" at position ${i + 1} must be followed by two hexadecimal digits, not "${text.slice(i + 1, i + 3)}". A literal percent sign is written %25.`, i);
      out.push((hi << 4) | lo);
      i += 3;
    } else if (code === 0x2b && options.plusAsSpace) {
      out.push(0x20);
      i++;
    } else if (code < 0x80) {
      out.push(code);
      i++;
    } else {
      const end = code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1;
      for (const b of encoder.encode(text.slice(i, end))) out.push(b);
      i = end;
    }
  }
  return ok(Uint8Array.from(out));
}
