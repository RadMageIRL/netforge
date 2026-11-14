/**
 * Time zone arithmetic against transitions established from the published rules:
 * - United States (Energy Policy Act of 2005): DST starts the second Sunday in March at 02:00 local
 *   and ends the first Sunday in November at 02:00 local. In 2026: March 8 and November 1.
 * - United Kingdom: BST runs from 01:00 UTC on the last Sunday in March to 01:00 UTC on the last
 *   Sunday in October. In 2026: March 29 and October 25.
 * - Lord Howe Island: a 30-minute shift, +10:30 to +11:00 on the first Sunday in October at 02:00
 *   and back on the first Sunday in April at 02:00. In 2026: April 5 and October 4.
 * - Samoa skipped Friday 2011-12-30 entirely, moving from UTC-10 to UTC+14 at local midnight.
 */
import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, currentZoneName, CURRENT_ZONE_NAMES, findTransition, formatOffset, isValidTimeZone, listTimeZones, offsetAt, resolveWall, utcFromWall, wallFromUtc, wallInZone, type WallTime } from '../../src/core/time/zones';

const H = 3_600_000;
const M = 60_000;

function wall(text: string): WallTime {
  const m = /^(-?[0-9]+)-([0-9]+)-([0-9]+) ([0-9]+):([0-9]+)(?::([0-9]+))?$/.exec(text);
  if (!m) throw new Error(`test setup: bad wall ${text}`);
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0, millisecond: 0 };
}

const utc = (iso: string) => Date.parse(iso);

describe('utcFromWall', () => {
  it('reads years 0 to 99 literally, unlike Date.UTC', () => {
    const w = wall('99-01-01 00:00');
    expect(utcFromWall(w)).not.toBe(Date.UTC(99, 0, 1));
    expect(wallFromUtc(utcFromWall(w)).year).toBe(99);
    expect(utcFromWall(wall('1-01-01 00:00'))).toBe(-62_135_596_800_000);
    expect(utcFromWall(wall('1970-01-01 00:00'))).toBe(0);
  });
});

describe('wallInZone', () => {
  it('uses the proleptic Gregorian calendar for early dates', () => {
    expect(wallInZone(Date.UTC(1000, 0, 1), 'Etc/UTC')).toMatchObject({ year: 1000, month: 1, day: 1, hour: 0 });
    expect(wallInZone(Date.UTC(1582, 9, 4), 'Etc/UTC')).toMatchObject({ year: 1582, month: 10, day: 4 });
    expect(wallInZone(-62_135_596_800_000, 'Etc/UTC')).toMatchObject({ year: 1, month: 1, day: 1 });
  });

  it('reports year 0 (1 BC) for the first instant of year 1 UTC seen from New York local mean time', () => {
    // New York kept local mean time, UTC-04:56:02, until 1883.
    expect(wallInZone(-62_135_596_800_000, 'America/New_York')).toEqual({ year: 0, month: 12, day: 31, hour: 19, minute: 3, second: 58, millisecond: 0 });
  });

  it('keeps milliseconds, including before 1970', () => {
    expect(wallInZone(-1, 'UTC')).toMatchObject({ year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59, millisecond: 999 });
    expect(wallInZone(1_700_000_000_123, 'Asia/Kolkata')).toMatchObject({ hour: 3, minute: 43, second: 20, millisecond: 123 });
  });
});

describe('offsetAt', () => {
  it('gives standard and daylight offsets for New York', () => {
    expect(offsetAt(utc('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * H);
    expect(offsetAt(utc('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * H);
  });

  it('gives fractional-hour offsets', () => {
    expect(offsetAt(utc('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * H);
    expect(offsetAt(utc('2026-07-15T12:00:00Z'), 'Asia/Kathmandu')).toBe(5.75 * H);
    expect(offsetAt(utc('2026-07-15T12:00:00Z'), 'America/St_Johns')).toBe(-2.5 * H);
  });

  it('changes exactly at the transition instant', () => {
    const start = utc('2026-03-08T07:00:00Z');
    expect(offsetAt(start - 1, 'America/New_York')).toBe(-5 * H);
    expect(offsetAt(start, 'America/New_York')).toBe(-4 * H);
    expect(findTransition(start - 5 * H, start + 5 * H, 'America/New_York')).toBe(start);
  });
});

describe('resolveWall', () => {
  it('finds no instant for a time inside the spring-forward gap (New York)', () => {
    expect(resolveWall(wall('2026-03-08 02:30'), 'America/New_York')).toEqual({
      kind: 'gap', offsetBeforeMs: -5 * H, offsetAfterMs: -4 * H, transitionMs: utc('2026-03-08T07:00:00Z'),
    });
  });

  it('resolves the last second before the gap and the first after it to single instants', () => {
    expect(resolveWall(wall('2026-03-08 01:59:59'), 'America/New_York')).toEqual({ kind: 'exact', instant: { epochMs: utc('2026-03-08T06:59:59Z'), offsetMs: -5 * H } });
    expect(resolveWall(wall('2026-03-08 03:00'), 'America/New_York')).toEqual({ kind: 'exact', instant: { epochMs: utc('2026-03-08T07:00:00Z'), offsetMs: -4 * H } });
  });

  it('finds two instants for a time inside the fall-back overlap (New York)', () => {
    expect(resolveWall(wall('2026-11-01 01:30'), 'America/New_York')).toEqual({
      kind: 'ambiguous',
      earlier: { epochMs: utc('2026-11-01T05:30:00Z'), offsetMs: -4 * H },
      later: { epochMs: utc('2026-11-01T06:30:00Z'), offsetMs: -5 * H },
      transitionMs: utc('2026-11-01T06:00:00Z'),
    });
  });

  it('resolves times just outside the overlap to single instants', () => {
    expect(resolveWall(wall('2026-11-01 00:59:59'), 'America/New_York')).toMatchObject({ kind: 'exact', instant: { epochMs: utc('2026-11-01T04:59:59Z') } });
    expect(resolveWall(wall('2026-11-01 02:00'), 'America/New_York')).toMatchObject({ kind: 'exact', instant: { epochMs: utc('2026-11-01T07:00:00Z') } });
  });

  it('handles the London transitions at 01:00 UTC', () => {
    expect(resolveWall(wall('2026-03-29 01:30'), 'Europe/London')).toMatchObject({ kind: 'gap', transitionMs: utc('2026-03-29T01:00:00Z') });
    expect(resolveWall(wall('2026-10-25 01:30'), 'Europe/London')).toEqual({
      kind: 'ambiguous',
      earlier: { epochMs: utc('2026-10-25T00:30:00Z'), offsetMs: 1 * H },
      later: { epochMs: utc('2026-10-25T01:30:00Z'), offsetMs: 0 },
      transitionMs: utc('2026-10-25T01:00:00Z'),
    });
  });

  it('handles a 30-minute shift (Lord Howe Island)', () => {
    expect(resolveWall(wall('2026-04-05 01:45'), 'Australia/Lord_Howe')).toEqual({
      kind: 'ambiguous',
      earlier: { epochMs: utc('2026-04-04T14:45:00Z'), offsetMs: 11 * H },
      later: { epochMs: utc('2026-04-04T15:15:00Z'), offsetMs: 10 * H + 30 * M },
      transitionMs: utc('2026-04-04T15:00:00Z'),
    });
    expect(resolveWall(wall('2026-10-04 02:15'), 'Australia/Lord_Howe')).toEqual({
      kind: 'gap', offsetBeforeMs: 10 * H + 30 * M, offsetAfterMs: 11 * H, transitionMs: utc('2026-10-03T15:30:00Z'),
    });
  });

  it('handles a whole skipped day (Samoa, 2011-12-30)', () => {
    expect(resolveWall(wall('2011-12-30 12:00'), 'Pacific/Apia')).toEqual({
      kind: 'gap', offsetBeforeMs: -10 * H, offsetAfterMs: 14 * H, transitionMs: utc('2011-12-30T10:00:00Z'),
    });
    expect(resolveWall(wall('2011-12-29 23:59:59'), 'Pacific/Apia')).toMatchObject({ kind: 'exact', instant: { epochMs: utc('2011-12-30T09:59:59Z') } });
    expect(resolveWall(wall('2011-12-31 00:00'), 'Pacific/Apia')).toMatchObject({ kind: 'exact', instant: { epochMs: utc('2011-12-30T10:00:00Z') } });
  });

  it('treats UTC as having no gaps or overlaps', () => {
    expect(resolveWall(wall('2026-03-08 02:30'), 'UTC')).toEqual({ kind: 'exact', instant: { epochMs: utc('2026-03-08T02:30:00Z'), offsetMs: 0 } });
  });
});

describe('formatOffset', () => {
  it.each([
    [0, '+00:00'],
    [-5 * H, '-05:00'],
    [5.5 * H, '+05:30'],
    [5.75 * H, '+05:45'],
    [-30 * M, '-00:30'],
    [14 * H, '+14:00'],
    [-(4 * H + 56 * M + 2000), '-04:56:02'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatOffset(ms)).toBe(text);
  });
});

describe('zone names', () => {
  it('accepts IANA names, case-insensitively, and rejects unknown ones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('america/new_york')).toBe(true);
    expect(canonicalTimeZone('america/new_york')).toBe('America/New_York');
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });

  it('maps the older CLDR names to current IANA names that behave identically', () => {
    for (const [legacy, current] of Object.entries(CURRENT_ZONE_NAMES)) {
      expect(isValidTimeZone(current), current).toBe(true);
      for (const instant of [Date.UTC(1980, 0, 1), Date.UTC(2000, 6, 1), Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15)]) {
        expect(offsetAt(instant, current), `${current} at ${instant}`).toBe(offsetAt(instant, legacy));
      }
    }
    expect(canonicalTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalTimeZone('asia/kolkata')).toBe('Asia/Kolkata');
    expect(currentZoneName('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(currentZoneName('Europe/Paris')).toBe('Europe/Paris');
  });

  it('lists only current names', () => {
    const zones = listTimeZones();
    for (const [legacy, current] of Object.entries(CURRENT_ZONE_NAMES)) {
      expect(zones, legacy).not.toContain(legacy);
      expect(zones, current).toContain(current);
    }
  });

  it('lists UTC first, then the browser zones', () => {
    const zones = listTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain('America/New_York');
    expect(zones).toContain('Australia/Lord_Howe');
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.length).toBeGreaterThan(300);
  });
});
