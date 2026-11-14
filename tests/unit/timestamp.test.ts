/**
 * Timestamp parsing and formatting. Reference instants: 1700000000 s is 2023-11-14T22:13:20Z,
 * 1e11 s is 5138-11-16T09:46:40Z and 1e11 ms is 1973-03-03T09:46:40Z. UTC formatting is also
 * checked against Date.prototype.toISOString, an independent implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_MS_THRESHOLD, formatIsoInZone, formatIsoUtc, formatRelative, formatUnixSeconds, formatWallIso,
  MAX_EPOCH_MS, MIN_EPOCH_MS, parseTimestamp, resolveTimestamp, type ParsedTimestamp, type TimestampMode,
} from '../../src/core/time/timestamp';
import { rng } from '../helpers';

function parsed(text: string, mode: TimestampMode = 'auto'): ParsedTimestamp {
  const r = parseTimestamp(text, mode);
  if (!r.ok) throw new Error(`expected ${text} to parse: ${r.error.message}`);
  return r.value;
}

function instant(text: string, mode: TimestampMode = 'auto'): number {
  const p = parsed(text, mode);
  if (p.kind !== 'instant') throw new Error(`expected an instant for ${text}`);
  return p.epochMs;
}

function code(text: string, mode: TimestampMode = 'auto'): string {
  const r = parseTimestamp(text, mode);
  if (r.ok) throw new Error(`expected ${text} to be rejected`);
  return r.error.code;
}

describe('range constants', () => {
  it('are the first and last milliseconds of years 0001 and 9999', () => {
    expect(new Date(MIN_EPOCH_MS).toISOString()).toBe('0001-01-01T00:00:00.000Z');
    expect(new Date(MAX_EPOCH_MS).toISOString()).toBe('9999-12-31T23:59:59.999Z');
  });
});

describe('Unix numbers', () => {
  it('reads a 10-digit number as seconds in Auto', () => {
    const p = parsed('1700000000');
    expect(p).toMatchObject({ kind: 'instant', epochMs: 1_700_000_000_000, source: 'seconds', autoDetected: true });
    expect(formatIsoUtc(1_700_000_000_000)).toBe('2023-11-14T22:13:20Z');
  });

  it('reads a 13-digit number as milliseconds in Auto', () => {
    expect(parsed('1700000000000')).toMatchObject({ epochMs: 1_700_000_000_000, source: 'milliseconds', autoDetected: true });
  });

  it('switches from seconds to milliseconds exactly at the Auto threshold', () => {
    expect(AUTO_MS_THRESHOLD).toBe(100_000_000_000n);
    expect(parsed('99999999999')).toMatchObject({ source: 'seconds', epochMs: 99_999_999_999_000 });
    expect(formatIsoUtc(99_999_999_999_000)).toBe('5138-11-16T09:46:39Z');
    expect(parsed('100000000000')).toMatchObject({ source: 'milliseconds', epochMs: 100_000_000_000 });
    expect(formatIsoUtc(100_000_000_000)).toBe('1973-03-03T09:46:40Z');
    // Negative numbers are judged by magnitude too.
    expect(parsed('-62135596800')).toMatchObject({ source: 'seconds', epochMs: MIN_EPOCH_MS });
    expect(parsed('-100000000000')).toMatchObject({ source: 'milliseconds', epochMs: -100_000_000_000 });
  });

  it('obeys an explicit unit whatever the size', () => {
    expect(parsed('1700000000', 'seconds')).toMatchObject({ kind: 'instant', source: 'seconds', autoDetected: false, epochMs: 1_700_000_000_000 });
    expect(parsed('1700000000', 'milliseconds')).toMatchObject({ source: 'milliseconds', autoDetected: false, epochMs: 1_700_000_000 });
    expect(parsed('100000000000', 'seconds')).toMatchObject({ source: 'seconds', epochMs: 100_000_000_000_000 });
    expect(code('1700000000000', 'seconds')).toBe('out-of-range');
  });

  it('converts decimal seconds exactly, without floating-point error', () => {
    expect(instant('1700000000.123')).toBe(1_700_000_000_123);
    expect(instant('0.001')).toBe(1);
    expect(instant('-1.5')).toBe(-1500);
    expect(instant('+5')).toBe(5000);
    expect(instant('1700000000.1230000').valueOf()).toBe(1_700_000_000_123);
    expect(parsed('1700000000.1230000').warnings).toEqual([]);
  });

  it('warns from the first digit beyond milliseconds, and not before', () => {
    expect(parsed('1700000000.123').warnings).toEqual([]);
    expect(parsed('1700000000.1234').warnings).toHaveLength(1);
    expect(parsed('1700000000.1230').warnings).toEqual([]);
    expect(parsed('2026-11-14T08:30:00.123Z').warnings).toEqual([]);
    expect(parsed('2026-11-14T08:30:00.1234Z').warnings).toHaveLength(1);
    expect(parsed('2026-11-14T08:30:00.1230Z').warnings).toEqual([]);
  });

  it('warns when digits finer than a millisecond are dropped', () => {
    expect(parsed('1700000000.1234567')).toMatchObject({ epochMs: 1_700_000_000_123 });
    expect(parsed('1700000000.1234567').warnings).toHaveLength(1);
    expect(parsed('1700000000000.5', 'milliseconds').warnings).toHaveLength(1);
    expect(parsed('1700000000000.0', 'milliseconds').warnings).toEqual([]);
  });

  it('accepts the first and last supported instants and rejects one beyond each', () => {
    expect(instant('-62135596800', 'seconds')).toBe(MIN_EPOCH_MS);
    expect(code('-62135596801', 'seconds')).toBe('out-of-range');
    expect(instant('253402300799', 'seconds')).toBe(MAX_EPOCH_MS - 999);
    expect(code('253402300800', 'seconds')).toBe('out-of-range');
    expect(instant('253402300799999', 'milliseconds')).toBe(MAX_EPOCH_MS);
    expect(code('253402300800000', 'milliseconds')).toBe('out-of-range');
  });

  it('suggests microseconds or nanoseconds for 16- and 19-digit values', () => {
    for (const text of ['1700000000000000', '1700000000000000000']) {
      const r = parseTimestamp(text, 'auto');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('out-of-range');
        expect(r.error.message).toContain('microseconds');
      }
    }
  });

  it.each([
    ['', 'auto', 'empty'],
    ['   ', 'auto', 'empty'],
    ['1,700,000,000', 'auto', 'digit-separators'],
    ['1_700_000_000', 'auto', 'digit-separators'],
    ['1 700 000 000', 'auto', 'digit-separators'],
    ['1.7e9', 'auto', 'exponent'],
    ['1E10', 'seconds', 'exponent'],
    ['abc', 'auto', 'unrecognized'],
    ['yesterday', 'auto', 'unrecognized'],
    ['0x10', 'auto', 'unrecognized'],
    ['abc', 'seconds', 'not-a-number'],
    ['2026-01-01', 'milliseconds', 'not-a-number'],
    ['1.', 'auto', 'unrecognized'],
    ['.5', 'auto', 'unrecognized'],
  ] as const)('rejects %j in %s mode with %s', (text, mode, expected) => {
    expect(code(text, mode)).toBe(expected);
  });
});

describe('ISO 8601', () => {
  it('reads UTC and offsets', () => {
    expect(instant('2026-11-14T08:30:00Z')).toBe(Date.UTC(2026, 10, 14, 8, 30));
    expect(instant('2026-11-14T08:30:00z')).toBe(Date.UTC(2026, 10, 14, 8, 30));
    expect(instant('2026-11-14t08:30:00+05:30')).toBe(Date.UTC(2026, 10, 14, 3, 0));
    expect(instant('2026-11-14T08:30:00-0800')).toBe(Date.UTC(2026, 10, 14, 16, 30));
    expect(instant('2026-11-14T08:30+01')).toBe(Date.UTC(2026, 10, 14, 7, 30));
    expect(instant('2026-11-14 08:30:00Z')).toBe(Date.UTC(2026, 10, 14, 8, 30));
  });

  it('records the written offset', () => {
    expect(parsed('2026-11-14T08:30:00-08:00')).toMatchObject({ source: 'iso', writtenOffsetMs: -8 * 3_600_000 });
  });

  it('reads fractions with a dot or a comma', () => {
    expect(instant('2026-11-14T08:30:00.5Z')).toBe(Date.UTC(2026, 10, 14, 8, 30, 0, 500));
    expect(instant('2026-11-14T08:30:00,25Z')).toBe(Date.UTC(2026, 10, 14, 8, 30, 0, 250));
    expect(instant('2026-11-14T08:30:00.123456789Z')).toBe(Date.UTC(2026, 10, 14, 8, 30, 0, 123));
    expect(parsed('2026-11-14T08:30:00.123456789Z').warnings).toHaveLength(1);
  });

  it('returns a wall time, not an instant, when there is no offset', () => {
    expect(parsed('2026-11-14T08:30')).toEqual({ kind: 'wall', wall: { year: 2026, month: 11, day: 14, hour: 8, minute: 30, second: 0, millisecond: 0 }, dateOnly: false, warnings: [] });
    expect(parsed('2026-11-14')).toMatchObject({ kind: 'wall', dateOnly: true, wall: { hour: 0, minute: 0 } });
  });

  it('knows leap years', () => {
    expect(parsed('2024-02-29').kind).toBe('wall');
    expect(parsed('2000-02-29').kind).toBe('wall');
    expect(code('2026-02-29')).toBe('iso-day');
    expect(code('1900-02-29')).toBe('iso-day');
  });

  it('accepts the ends of the supported range and rejects beyond them', () => {
    expect(instant('0001-01-01T00:00:00Z')).toBe(MIN_EPOCH_MS);
    expect(instant('9999-12-31T23:59:59.999Z')).toBe(MAX_EPOCH_MS);
    expect(code('0000-12-31T23:59:59Z')).toBe('out-of-range');
    expect(code('9999-12-31T23:59:59-01:00')).toBe('out-of-range');
  });

  it.each([
    ['2026-13-01', 'iso-month'],
    ['2026-00-10', 'iso-month'],
    ['2026-04-31', 'iso-day'],
    ['2026-01-00', 'iso-day'],
    ['2026-11-14T24:00', 'hour-24'],
    ['2026-11-14T25:00', 'iso-hour'],
    ['2026-11-14T08:60', 'iso-minute'],
    ['2026-12-31T23:59:60Z', 'leap-second'],
    ['2026-11-14T08:30:61', 'iso-second'],
    ['2026-11-14T08:30+24:00', 'iso-offset'],
    ['2026-11-14T08:30+05:60', 'iso-offset'],
    ['20261114T083000Z', 'iso-basic-format'],
    ['2026-1-1', 'iso-invalid'],
    ['2026-11-14Z', 'iso-invalid'],
    ['2026-11-14T8:30', 'iso-invalid'],
    ['2026-11-14T08:30:00 Z', 'iso-invalid'],
  ])('rejects %j with %s', (text, expected) => {
    expect(code(text)).toBe(expected);
  });

  it('reads plain digits as ISO only in ISO mode', () => {
    expect(code('20261114', 'iso')).toBe('iso-basic-format');
    expect(parsed('20261114')).toMatchObject({ source: 'seconds' });
  });
});

describe('resolveTimestamp', () => {
  it('places a wall time in the chosen zone', () => {
    const p = parsed('2026-07-01T12:00');
    expect(resolveTimestamp(p, 'America/New_York')).toEqual({ ok: true, value: { kind: 'exact', instant: { epochMs: Date.UTC(2026, 6, 1, 16), offsetMs: -4 * 3_600_000 } } });
    expect(resolveTimestamp(p, 'UTC')).toMatchObject({ ok: true, value: { kind: 'exact', instant: { epochMs: Date.UTC(2026, 6, 1, 12) } } });
  });

  it('passes instants through unchanged whatever the zone', () => {
    expect(resolveTimestamp(parsed('1700000000'), 'Asia/Tokyo')).toEqual({ ok: true, value: { kind: 'instant', epochMs: 1_700_000_000_000 } });
  });

  it('reports gaps and overlaps', () => {
    expect(resolveTimestamp(parsed('2026-03-08 02:30'), 'America/New_York')).toMatchObject({ ok: true, value: { kind: 'gap' } });
    expect(resolveTimestamp(parsed('2026-11-01 01:30'), 'America/New_York')).toMatchObject({ ok: true, value: { kind: 'ambiguous' } });
  });

  it('rejects wall times whose instant falls outside the supported range', () => {
    expect(resolveTimestamp(parsed('0001-01-01T00:00'), 'Asia/Tokyo')).toMatchObject({ ok: false, error: { code: 'out-of-range' } });
    expect(resolveTimestamp(parsed('9999-12-31T23:00'), 'America/New_York')).toMatchObject({ ok: false, error: { code: 'out-of-range' } });
  });
});

describe('formatting', () => {
  it('matches toISOString in UTC for 3,000 random instants across the whole range', () => {
    const random = rng(3339);
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const ms = Math.floor(MIN_EPOCH_MS + random() * (MAX_EPOCH_MS - MIN_EPOCH_MS));
      const iso = new Date(ms).toISOString();
      const want = ms % 1000 === 0 ? iso.replace('.000Z', 'Z') : iso;
      if (formatIsoUtc(ms) !== want) mismatches.push(`${ms}: ${formatIsoUtc(ms)} vs ${want}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('shows the zone offset at that instant', () => {
    expect(formatIsoInZone(Date.UTC(2026, 0, 15, 12), 'America/New_York')).toBe('2026-01-15T07:00:00-05:00');
    expect(formatIsoInZone(Date.UTC(2026, 6, 15, 12), 'America/New_York')).toBe('2026-07-15T08:00:00-04:00');
    // 22:13:20.123 UTC plus 5:45 is 03:58:20.123 the next day.
    expect(formatIsoInZone(1_700_000_000_123, 'Asia/Kathmandu')).toBe('2023-11-15T03:58:20.123+05:45');
    expect(formatIsoInZone(0, 'UTC')).toBe('1970-01-01T00:00:00+00:00');
  });

  it('writes Unix seconds as an exact decimal', () => {
    expect(formatUnixSeconds(0)).toBe('0');
    expect(formatUnixSeconds(1500)).toBe('1.5');
    expect(formatUnixSeconds(-1)).toBe('-0.001');
    expect(formatUnixSeconds(-1500)).toBe('-1.5');
    expect(formatUnixSeconds(1_700_000_000_000)).toBe('1700000000');
    expect(formatUnixSeconds(1_700_000_000_120)).toBe('1700000000.12');
    expect(formatUnixSeconds(MIN_EPOCH_MS)).toBe('-62135596800');
  });

  it('pads years below 1000 and writes wall times', () => {
    expect(formatWallIso({ year: 999, month: 1, day: 2, hour: 3, minute: 4, second: 5, millisecond: 6 })).toBe('0999-01-02T03:04:05.006');
    expect(formatWallIso({ year: 0, month: 12, day: 31, hour: 0, minute: 0, second: 0, millisecond: 0 })).toBe('0000-12-31T00:00:00');
    expect(formatWallIso({ year: -1, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 })).toBe('-000001-01-01T00:00:00');
  });

  it('describes relative times in words', () => {
    const now = Date.UTC(2026, 10, 14, 12);
    expect(formatRelative(now - 3 * 86_400_000, now, 'en-US')).toBe('3 days ago');
    expect(formatRelative(now + 2 * 3_600_000, now, 'en-US')).toBe('in 2 hours');
    expect(formatRelative(now - 86_400_000, now, 'en-US')).toBe('yesterday');
    expect(formatRelative(now, now, 'en-US')).toBe('now');
    expect(formatRelative(now - 2 * 365.2425 * 86_400_000, now, 'en-US')).toBe('2 years ago');
  });
});
