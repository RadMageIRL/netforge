/**
 * Integer conversion between binary, octal, decimal and hexadecimal, at a fixed bit width or
 * without one. All arithmetic is BigInt, so no value is ever rounded.
 *
 * How input is read:
 * - Decimal input is a value. It may carry a sign, and it must fit the chosen width and signedness.
 * - Binary, octal and hexadecimal input is a bit pattern. It carries no sign and must fit in the
 *   width; in signed mode the pattern is then read as two's complement (ff at 8 bits is -1).
 * - Without a width there is no two's complement pattern: a value is a sign and a magnitude.
 */
import { ok, fail, type Result } from '../result';

export type Base = 2 | 8 | 10 | 16;
export const BASES: readonly Base[] = [2, 8, 10, 16];
export const BASE_NAME: Readonly<Record<Base, string>> = { 2: 'binary', 8: 'octal', 10: 'decimal', 16: 'hexadecimal' };
const BASE_PREFIX: Readonly<Record<Base, string>> = { 2: '0b', 8: '0o', 10: '', 16: '0x' };

export const NUMBER_LIMITS = {
  /** Longest accepted input, in characters. */
  inputChars: 5000,
  minWidth: 1,
  maxWidth: 4096,
} as const;

export const STANDARD_WIDTHS: readonly number[] = [8, 16, 32, 64, 128];

export type NumberErrorCode =
  | 'empty' | 'too-long' | 'invalid-digit' | 'prefix-mismatch' | 'sign' | 'separator' | 'no-digits'
  | 'overflow' | 'negative-unsigned' | 'width';

export interface NumberOptions {
  readonly base: Base;
  readonly signed: boolean;
  /** Bit width, or null for no fixed width. */
  readonly width: number | null;
}

export interface ParsedInteger {
  readonly negative: boolean;
  readonly magnitude: bigint;
  /** Digits read, without prefix, sign or separators. */
  readonly digits: number;
}

function digitValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

function prefixBase(text: string, at: number): Base | null {
  if (text.charCodeAt(at) !== 48) return null;
  const c = text.charAt(at + 1).toLowerCase();
  return c === 'x' ? 16 : c === 'b' ? 2 : c === 'o' ? 8 : null;
}

/** Reads digits in a base. Offsets in errors point into the text as given. */
export function parseInteger(text: string, base: Base): Result<ParsedInteger, NumberErrorCode> {
  if (text.length > NUMBER_LIMITS.inputChars) return fail('too-long', `The input is longer than ${NUMBER_LIMITS.inputChars} characters.`);
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  if (start === end) return fail('empty', 'Enter a number.');
  let i = start;
  let negative = false;
  const first = text.charAt(i);
  if (first === '-' || first === '+') {
    if (base !== 10) return fail('sign', `A sign is only read in decimal. In ${BASE_NAME[base]}, enter the bit pattern, or switch the input base to decimal for a negative value.`, i);
    negative = first === '-';
    i++;
  }
  const prefix = prefixBase(text, i);
  // In hexadecimal "0b1" is three hex digits, not a binary prefix, so only a prefix that cannot be digits counts.
  if (prefix !== null && !(base === 16 && prefix === 2)) {
    if (prefix !== base) return fail('prefix-mismatch', `The prefix ${text.slice(i, i + 2)} marks ${BASE_NAME[prefix]}, but the input base is ${BASE_NAME[base]}.`, i);
    i += 2;
  }
  if (i === end) return fail('no-digits', 'There are no digits after the sign or prefix.', i);
  let magnitude = 0n;
  let digits = 0;
  let lastWasSeparator = true;
  const big = BigInt(base);
  for (; i < end; i++) {
    const ch = text.charAt(i);
    if (ch === '_' || ch === ' ') {
      if (lastWasSeparator) return fail('separator', 'A separator must sit between two digits.', i);
      lastWasSeparator = true;
      continue;
    }
    const d = digitValue(text.charCodeAt(i));
    if (d < 0 || d >= base) return fail('invalid-digit', `"${ch}" is not a ${BASE_NAME[base]} digit.`, i);
    magnitude = magnitude * big + BigInt(d);
    digits++;
    lastWasSeparator = false;
  }
  if (lastWasSeparator) return fail('separator', 'A separator must sit between two digits.', end - 1);
  return ok({ negative: negative && magnitude !== 0n, magnitude, digits });
}

export function checkWidth(width: number): Result<number, NumberErrorCode> {
  if (!Number.isInteger(width) || width < NUMBER_LIMITS.minWidth || width > NUMBER_LIMITS.maxWidth) {
    return fail('width', `The bit width must be a whole number from ${NUMBER_LIMITS.minWidth} to ${NUMBER_LIMITS.maxWidth}.`);
  }
  return ok(width);
}

/** The lowest and highest value a width holds. */
export function widthRange(width: number, signed: boolean): { min: bigint; max: bigint } {
  const w = BigInt(width);
  return signed ? { min: -(1n << (w - 1n)), max: (1n << (w - 1n)) - 1n } : { min: 0n, max: (1n << w) - 1n };
}

/** Bits needed to hold a value: as written for unsigned, in two's complement (with the sign bit) for signed. */
export function bitsNeeded(value: bigint, signed: boolean): number {
  const magnitudeBits = (v: bigint) => (v === 0n ? 0 : v.toString(2).length);
  if (!signed) return Math.max(1, magnitudeBits(value));
  return (value < 0n ? magnitudeBits(-value - 1n) : magnitudeBits(value)) + 1;
}

export interface Conversion {
  /** The value as read with the chosen signedness. */
  readonly value: bigint;
  readonly width: number | null;
  readonly signed: boolean;
  /** The bits as an unsigned number, or null without a width. */
  readonly pattern: bigint | null;
  /** The same bits read as unsigned and as two's complement, or null without a width. */
  readonly unsignedReading: bigint | null;
  readonly signedReading: bigint | null;
  /** Digits only. With a width: the bit pattern, zero-padded. Without: the magnitude, with a minus sign when negative. */
  readonly binary: string;
  readonly octal: string;
  readonly hex: string;
  /** The value in decimal. */
  readonly decimal: string;
  /** Bytes as two hex digits each, most significant first, or null when there is no whole number of bytes. */
  readonly bytesBigEndian: readonly string[] | null;
  readonly bytesLittleEndian: readonly string[] | null;
  /** Why there are no bytes, when there are none. */
  readonly bytesNote: string | null;
  /** Fewest bits that hold the value with the chosen signedness. */
  readonly bitsNeeded: number;
  readonly notes: readonly string[];
}

function describeRange(width: number, signed: boolean): string {
  const r = widthRange(width, signed);
  const show = (v: bigint) => { const s = v.toString(); return s.length > 45 ? `${s.slice(0, 12)}...${s.slice(-6)} (${s.replace('-', '').length} digits)` : s; };
  return `${show(r.min)} to ${show(r.max)}`;
}

export function convert(text: string, options: NumberOptions): Result<Conversion, NumberErrorCode> {
  const { base, signed, width } = options;
  if (width !== null) {
    const w = checkWidth(width);
    if (!w.ok) return w;
  }
  const parsed = parseInteger(text, base);
  if (!parsed.ok) return parsed;
  const { negative, magnitude } = parsed.value;
  const notes: string[] = [];

  if (width === null) {
    if (negative && !signed) return fail('negative-unsigned', 'A negative value cannot be read as unsigned. Choose signed.');
    const value = negative ? -magnitude : magnitude;
    const sign = negative ? '-' : '';
    let bytes: string[] | null = null;
    let bytesNote: string | null = null;
    if (negative) {
      bytesNote = 'A negative value has no byte representation without a bit width.';
      notes.push('Without a bit width there is no two\'s complement pattern, so a negative value is shown as a minus sign and its magnitude.');
    } else {
      const hex = magnitude.toString(16);
      const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
      bytes = padded.match(/../g) as string[];
    }
    return ok({
      value, width: null, signed, pattern: null, unsignedReading: null, signedReading: null,
      binary: sign + magnitude.toString(2), octal: sign + magnitude.toString(8), hex: sign + magnitude.toString(16), decimal: value.toString(),
      bytesBigEndian: bytes, bytesLittleEndian: bytes ? [...bytes].reverse() : null, bytesNote,
      bitsNeeded: bitsNeeded(value, signed), notes,
    });
  }

  const w = BigInt(width);
  const modulus = 1n << w;
  let pattern: bigint;
  if (base === 10) {
    const value = negative ? -magnitude : magnitude;
    if (negative && !signed) return fail('negative-unsigned', `A negative value cannot be stored as unsigned. Unsigned ${width}-bit values run from ${describeRange(width, false)}.`);
    const range = widthRange(width, signed);
    if (value < range.min || value > range.max) {
      return fail('overflow', `${value.toString().length > 60 ? 'The value' : value.toString()} does not fit in ${width} ${width === 1 ? 'bit' : 'bits'} ${signed ? 'signed' : 'unsigned'}. The range is ${describeRange(width, signed)}.`);
    }
    pattern = value < 0n ? value + modulus : value;
  } else {
    if (magnitude >= modulus) {
      return fail('overflow', `The ${BASE_NAME[base]} input needs ${magnitude.toString(2).length} bits and does not fit in ${width}.`);
    }
    pattern = magnitude;
  }
  const signBit = 1n << (w - 1n);
  const signedReading = pattern >= signBit ? pattern - modulus : pattern;
  const value = signed ? signedReading : pattern;
  let bytes: string[] | null = null;
  let bytesNote: string | null = null;
  if (width % 8 === 0) {
    bytes = pattern.toString(16).padStart(width / 4, '0').match(/../g) as string[];
  } else {
    bytesNote = `${width} bits is not a whole number of bytes, so there is no byte order to show.`;
  }
  if (base !== 10 && signed && signedReading < 0n) notes.push(`The ${BASE_NAME[base]} input is a bit pattern. Its top bit is set, so as a signed ${width}-bit number it is negative.`);
  return ok({
    value, width, signed, pattern, unsignedReading: pattern, signedReading,
    binary: pattern.toString(2).padStart(width, '0'),
    octal: pattern.toString(8).padStart(Math.ceil(width / 3), '0'),
    hex: pattern.toString(16).padStart(Math.ceil(width / 4), '0'),
    decimal: value.toString(),
    bytesBigEndian: bytes, bytesLittleEndian: bytes ? [...bytes].reverse() : null, bytesNote,
    bitsNeeded: bitsNeeded(value, signed), notes,
  });
}

/** Digits in groups counted from the right: groupDigits('1010101', 4) is '101 0101'. A leading minus sign stays in front. */
export function groupDigits(digits: string, size: number, separator = ' '): string {
  const negative = digits.startsWith('-');
  const body = negative ? digits.slice(1) : digits;
  const parts: string[] = [];
  for (let end = body.length; end > 0; end -= size) parts.unshift(body.slice(Math.max(0, end - size), end));
  return (negative ? '-' : '') + parts.join(separator);
}

/** A value with the conventional prefix: 0b, 0o or 0x (none for decimal). */
export function withPrefix(digits: string, base: Base): string {
  return digits.startsWith('-') ? `-${BASE_PREFIX[base]}${digits.slice(1)}` : `${BASE_PREFIX[base]}${digits}`;
}
