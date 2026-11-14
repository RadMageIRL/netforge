/**
 * Storage units: bits, bytes, decimal multiples (kB = 1000 bytes ... EB) and binary multiples
 * (KiB = 1024 bytes ... EiB). Amounts are exact fractions of BigInt, never floating point.
 *
 * Every unit is a power of two times a power of ten bits, and input is decimal text, so every
 * result has a decimal expansion that ends. Results are therefore always shown exactly; a long
 * one also gets a rounded form, labeled as rounded.
 */
import { ok, fail, type Result } from '../result';

export type UnitId = 'bit' | 'B' | 'kB' | 'MB' | 'GB' | 'TB' | 'PB' | 'EB' | 'KiB' | 'MiB' | 'GiB' | 'TiB' | 'PiB' | 'EiB';
export type UnitFamily = 'base' | 'decimal' | 'binary';

export interface Unit {
  readonly id: UnitId;
  readonly name: string;
  readonly family: UnitFamily;
  /** Size in bits. */
  readonly bits: bigint;
}

const DECIMAL_NAMES = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte', 'exabyte'];
const BINARY_NAMES = ['kibibyte', 'mebibyte', 'gibibyte', 'tebibyte', 'pebibyte', 'exbibyte'];
const DECIMAL_IDS: readonly UnitId[] = ['kB', 'MB', 'GB', 'TB', 'PB', 'EB'];
const BINARY_IDS: readonly UnitId[] = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

export const UNITS: readonly Unit[] = [
  { id: 'bit', name: 'bit', family: 'base', bits: 1n },
  { id: 'B', name: 'byte', family: 'base', bits: 8n },
  ...DECIMAL_IDS.map((id, i): Unit => ({ id, name: DECIMAL_NAMES[i], family: 'decimal', bits: 8n * 1000n ** BigInt(i + 1) })),
  ...BINARY_IDS.map((id, i): Unit => ({ id, name: BINARY_NAMES[i], family: 'binary', bits: 8n * 1024n ** BigInt(i + 1) })),
];

export const UNIT_LIMITS = {
  /** Longest accepted amount, in characters. */
  amountChars: 60,
  /** Significant digits in a rounded form. */
  roundedDigits: 12,
  /** Fraction digits beyond which a rounded form is shown as well. */
  longFraction: 12,
} as const;

export type UnitErrorCode = 'empty' | 'too-long' | 'invalid-amount' | 'unit';

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function reduce(num: bigint, den: bigint): Rational {
  const g = gcd(num, den);
  return g === 0n ? { num: 0n, den: 1n } : { num: num / g, den: den / g };
}

/** A non-negative decimal amount such as "1536", "1.5" or ".25", as an exact fraction. */
export function parseAmount(text: string): Result<Rational, UnitErrorCode> {
  const t = text.trim();
  if (t === '') return fail('empty', 'Enter an amount.');
  if (t.length > UNIT_LIMITS.amountChars) return fail('too-long', `Keep the amount to ${UNIT_LIMITS.amountChars} characters.`);
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) {
    return fail('invalid-amount', 'Enter a plain decimal amount such as 1536 or 1.5: digits and at most one decimal point, with no sign, exponent or grouping.');
  }
  const fraction = m[2] ?? '';
  return ok(reduce(BigInt((m[1] || '0') + fraction), 10n ** BigInt(fraction.length)));
}

/** The exact decimal text of a fraction whose denominator has no prime factors but 2 and 5, or null for any other. */
export function exactDecimal(r: Rational): string | null {
  let den = r.den;
  let twos = 0;
  let fives = 0;
  while (den % 2n === 0n) { den /= 2n; twos++; }
  while (den % 5n === 0n) { den /= 5n; fives++; }
  if (den !== 1n) return null;
  const places = Math.max(twos, fives);
  const scaled = (r.num * 10n ** BigInt(places)) / r.den;
  if (places === 0) return scaled.toString();
  const digits = scaled.toString().padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/** A fraction rounded to a number of significant digits, halves away from zero, without trailing zeros. */
export function roundedDecimal(r: Rational, significant: number): string {
  if (r.num === 0n) return '0';
  // Find e with 10^e <= value < 10^(e+1).
  let e = r.num.toString().length - r.den.toString().length;
  const atLeast = (exp: number) => (exp >= 0 ? r.num >= r.den * 10n ** BigInt(exp) : r.num * 10n ** BigInt(-exp) >= r.den);
  while (!atLeast(e)) e--;
  while (atLeast(e + 1)) e++;
  // Scale so the integer part has exactly `significant` digits, then round half up.
  const shift = significant - 1 - e;
  const num = shift >= 0 ? r.num * 10n ** BigInt(shift) : r.num;
  const den = shift >= 0 ? r.den : r.den * 10n ** BigInt(-shift);
  const q = (2n * num + den) / (2n * den);
  if (shift <= 0) return (q * 10n ** BigInt(-shift)).toString();
  const digits = q.toString().padStart(shift + 1, '0');
  const whole = digits.slice(0, -shift);
  const fraction = digits.slice(-shift).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

export interface UnitRow {
  readonly unit: Unit;
  /** The exact amount in this unit. */
  readonly exact: string;
  /** A rounded form, when the exact one has a long fraction. */
  readonly rounded: string | null;
}

export interface UnitConversion {
  readonly from: Unit;
  readonly bits: Rational;
  /** The whole number of bytes, or null when the amount is not a whole number of bytes. */
  readonly wholeBytes: bigint | null;
  /** The whole number of bits, or null when the amount is a fraction of a bit. */
  readonly wholeBits: bigint | null;
  readonly rows: readonly UnitRow[];
}

export function findUnit(id: string): Unit | null {
  return UNITS.find(u => u.id === id) ?? null;
}

export function convertAmount(text: string, fromId: string): Result<UnitConversion, UnitErrorCode> {
  const from = findUnit(fromId);
  if (!from) return fail('unit', 'Choose a unit from the list.');
  const amount = parseAmount(text);
  if (!amount.ok) return amount;
  const bits = reduce(amount.value.num * from.bits, amount.value.den);
  const bytes = reduce(bits.num, bits.den * 8n);
  const rows = UNITS.map((unit): UnitRow => {
    const value = reduce(bits.num, bits.den * unit.bits);
    const exact = exactDecimal(value) as string;
    const fractionDigits = exact.includes('.') ? exact.length - exact.indexOf('.') - 1 : 0;
    return { unit, exact, rounded: fractionDigits > UNIT_LIMITS.longFraction ? roundedDecimal(value, UNIT_LIMITS.roundedDigits) : null };
  });
  return ok({ from, bits, wholeBytes: bytes.den === 1n ? bytes.num : null, wholeBits: bits.den === 1n ? bits.num : null, rows });
}
