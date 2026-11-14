/**
 * Timestamp parsing and formatting: Unix seconds, Unix milliseconds and ISO 8601 / RFC 3339.
 * Numeric input is converted with integer arithmetic (bigint), never with floating-point
 * multiplication, so 1700000000.123 is exactly 1700000000123 ms.
 */
import { fail, ok, type Fail, type Result } from '../result';
import { formatOffset, offsetAt, resolveWall, utcFromWall, wallInZone, type WallResolution, type WallTime } from './zones';

/** 0001-01-01T00:00:00.000Z */
export const MIN_EPOCH_MS = -62_135_596_800_000;
/** 9999-12-31T23:59:59.999Z */
export const MAX_EPOCH_MS = 253_402_300_799_999;
/**
 * In Auto mode a number whose integer part is at least this large is read as milliseconds, and
 * anything smaller as seconds. 1e11 seconds is in the year 5138; 1e11 milliseconds is 1973-03-03.
 */
export const AUTO_MS_THRESHOLD = 100_000_000_000n;

export type TimestampMode = 'auto' | 'seconds' | 'milliseconds' | 'iso';

export type TimestampErrorCode =
  | 'empty'
  | 'unrecognized'
  | 'not-a-number'
  | 'digit-separators'
  | 'exponent'
  | 'out-of-range'
  | 'iso-basic-format'
  | 'iso-invalid'
  | 'iso-month'
  | 'iso-day'
  | 'iso-hour'
  | 'iso-minute'
  | 'iso-second'
  | 'leap-second'
  | 'hour-24'
  | 'iso-offset';

export type ParsedTimestamp =
  | {
      readonly kind: 'instant';
      readonly epochMs: number;
      readonly source: 'seconds' | 'milliseconds' | 'iso';
      /** True when Auto mode chose seconds or milliseconds from the number's size. */
      readonly autoDetected: boolean;
      /** The offset written in ISO input, if any. */
      readonly writtenOffsetMs: number | null;
      readonly warnings: readonly string[];
    }
  | {
      /** ISO input without an offset: a wall time that only means an instant in a chosen zone. */
      readonly kind: 'wall';
      readonly wall: WallTime;
      readonly dateOnly: boolean;
      readonly warnings: readonly string[];
    };

const NUMERIC = /^([+-]?)([0-9]+)(?:[.]([0-9]+))?$/;
const ISO = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]+))?)?(Z|z|[+-][0-9]{2}(?::?[0-9]{2})?)?)?$/;
const SUBMS_WARNING = 'Digits finer than a millisecond were ignored: NetForge works to the millisecond.';

export function parseTimestamp(raw: string, mode: TimestampMode): Result<ParsedTimestamp, TimestampErrorCode> {
  const text = raw.trim();
  if (text === '') return fail('empty', 'Enter a Unix timestamp or an ISO 8601 date and time.');
  const numeric = NUMERIC.exec(text);

  if (mode === 'seconds' || mode === 'milliseconds') {
    if (!numeric) return numericProblem(text) ?? fail('not-a-number', `"${text}" is not a number. Enter whole or decimal ${mode} since 1970-01-01T00:00:00Z.`);
    return fromNumber(numeric, mode, false);
  }
  if (mode === 'iso') return parseIso(text);

  if (numeric) {
    const unit = BigInt(numeric[2]) >= AUTO_MS_THRESHOLD ? 'milliseconds' : 'seconds';
    return fromNumber(numeric, unit, true);
  }
  if (/^[0-9]{4}-/.test(text) || /^[0-9]{8}[Tt]/.test(text)) return parseIso(text);
  return numericProblem(text) ?? fail('unrecognized', 'Not a recognized format. Enter Unix seconds, Unix milliseconds, or an ISO 8601 date such as 2026-11-14T08:30:00Z.');
}

function numericProblem(text: string): Fail<TimestampErrorCode> | null {
  if (/^[+-]?[0-9]+([,_ ][0-9]+)+([.][0-9]+)?$/.test(text)) return fail('digit-separators', 'Remove the digit separators (commas, spaces or underscores) and enter the digits only.');
  if (/^[+-]?[0-9]+([.][0-9]+)?[eE][+-]?[0-9]+$/.test(text)) return fail('exponent', 'Exponent notation is not accepted. Enter the full number.');
  return null;
}

function fromNumber(match: RegExpExecArray, unit: 'seconds' | 'milliseconds', autoDetected: boolean): Result<ParsedTimestamp, TimestampErrorCode> {
  const negative = match[1] === '-';
  const whole = BigInt(match[2]);
  const fraction = match[3] ?? '';
  const warnings: string[] = [];
  let ms: bigint;
  if (unit === 'seconds') {
    ms = whole * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, '0'));
    if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);
  } else {
    ms = whole;
    if (/[1-9]/.test(fraction)) warnings.push(SUBMS_WARNING);
  }
  if (negative) ms = -ms;
  if (ms < BigInt(MIN_EPOCH_MS) || ms > BigInt(MAX_EPOCH_MS)) {
    const digits = match[2].length;
    const hint = digits >= 16 ? ` A ${digits}-digit timestamp is usually in microseconds (16 digits) or nanoseconds (19 digits), which this converter does not read.` : '';
    return fail('out-of-range', `This ${unit === 'seconds' ? 'seconds' : 'milliseconds'} value is outside the supported range, years 0001 to 9999.${hint}`);
  }
  return ok({ kind: 'instant', epochMs: Number(ms), source: unit, autoDetected, writtenOffsetMs: null, warnings });
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIso(text: string): Result<ParsedTimestamp, TimestampErrorCode> {
  if (/^[0-9]{8}([Tt]|$)/.test(text)) return fail('iso-basic-format', 'Use the extended ISO 8601 format with separators, such as 2026-11-14T08:30:00Z.');
  const m = ISO.exec(text);
  if (!m) return fail('iso-invalid', 'Not a valid ISO 8601 date. Use YYYY-MM-DD, optionally followed by THH:MM, :SS, a fraction, and Z or an offset such as +02:00.');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return fail('iso-month', `Month ${m[2]} does not exist: months are 01 to 12.`);
  if (day < 1 || day > daysInMonth(year, month)) return fail('iso-day', `${m[1]}-${m[2]} has no day ${m[3]}.`);
  const hasTime = m[4] !== undefined;
  const hour = hasTime ? Number(m[4]) : 0;
  const minute = hasTime ? Number(m[5]) : 0;
  const second = m[6] !== undefined ? Number(m[6]) : 0;
  const fraction = m[7] ?? '';
  if (hour === 24) return fail('hour-24', '24:00 is not accepted. Use 00:00 on the following day.');
  if (hour > 23) return fail('iso-hour', `Hour ${m[4]} does not exist: hours are 00 to 23.`);
  if (minute > 59) return fail('iso-minute', `Minute ${m[5]} does not exist: minutes are 00 to 59.`);
  if (second === 60) return fail('leap-second', 'Leap seconds (:60) cannot be represented in Unix time.');
  if (second > 59) return fail('iso-second', `Second ${m[6]} does not exist: seconds are 00 to 59.`);
  const warnings: string[] = [];
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) warnings.push(SUBMS_WARNING);
  const wall: WallTime = { year, month, day, hour, minute, second, millisecond: Number(fraction.slice(0, 3).padEnd(3, '0')) };

  const zone = m[8];
  if (zone === undefined) return ok({ kind: 'wall', wall, dateOnly: !hasTime, warnings });
  let offsetMs = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (oh > 23 || om > 59) return fail('iso-offset', `The offset ${zone} is not valid: hours 00 to 23 and minutes 00 to 59.`);
    offsetMs = sign * (oh * 3600 + om * 60) * 1000;
  }
  const epochMs = utcFromWall(wall) - offsetMs;
  if (epochMs < MIN_EPOCH_MS || epochMs > MAX_EPOCH_MS) return fail('out-of-range', 'This date is outside the supported range, years 0001 to 9999 in UTC.');
  return ok({ kind: 'instant', epochMs, source: 'iso', autoDetected: false, writtenOffsetMs: offsetMs, warnings });
}

export type ResolvedTimestamp =
  | { readonly kind: 'instant'; readonly epochMs: number }
  | WallResolution;

/** Turns parsed input into instants: wall times are placed in `zone`. Out-of-range results fail. */
export function resolveTimestamp(parsed: ParsedTimestamp, zone: string): Result<ResolvedTimestamp, 'out-of-range'> {
  if (parsed.kind === 'instant') return ok({ kind: 'instant', epochMs: parsed.epochMs });
  const resolution = resolveWall(parsed.wall, zone);
  const instants = resolution.kind === 'exact' ? [resolution.instant.epochMs]
    : resolution.kind === 'ambiguous' ? [resolution.earlier.epochMs, resolution.later.epochMs] : [];
  if (instants.some(t => t < MIN_EPOCH_MS || t > MAX_EPOCH_MS)) return fail('out-of-range', 'This date is outside the supported range, years 0001 to 9999 in UTC.');
  return ok(resolution);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return (year < 0 ? '-' : '+') + pad(Math.abs(year), 6);
}

/** YYYY-MM-DDTHH:MM:SS with .mmm only when the milliseconds are not zero. */
export function formatWallIso(w: WallTime): string {
  const ms = w.millisecond === 0 ? '' : `.${pad(w.millisecond, 3)}`;
  return `${formatYear(w.year)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${ms}`;
}

/** ISO 8601 in UTC with a Z suffix. */
export function formatIsoUtc(epochMs: number): string {
  return `${formatWallIso(wallInZone(epochMs, 'UTC'))}Z`;
}

/** ISO 8601 as clocks in `zone` show it, with that zone's offset at that instant. */
export function formatIsoInZone(epochMs: number, zone: string): string {
  return `${formatWallIso(wallInZone(epochMs, zone))}${formatOffset(offsetAt(epochMs, zone))}`;
}

/** Exact decimal seconds: 1700000000, 1700000000.5, -1.25. */
export function formatUnixSeconds(epochMs: number): string {
  const negative = epochMs < 0;
  const abs = BigInt(Math.abs(epochMs));
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const readableFormats = new Map<string, Intl.DateTimeFormat>();

/** A long, localized date and time with the zone's abbreviation or offset. */
export function formatReadable(epochMs: number, zone: string, locale?: string): string {
  const key = `${locale ?? ''}|${zone}`;
  let f = readableFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: zone, calendar: 'gregory', dateStyle: 'full', timeStyle: 'long' });
    readableFormats.set(key, f);
  }
  return f.format(new Date(epochMs));
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365.2425 * 86_400_000],
  ['month', 30.436875 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
];

/** "3 days ago", "in 2 hours": rounded to the largest whole unit. */
export function formatRelative(epochMs: number, nowMs: number, locale?: string): string {
  const diff = epochMs - nowMs;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= size || unit === 'second') return format.format(Math.trunc(diff / size), unit);
  }
  return format.format(0, 'second');
}
