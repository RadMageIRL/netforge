/**
 * Time zone conversions against Python's zoneinfo (scripts/oracles/time_oracle.py), an
 * implementation independent of the ICU data the browser and Node use. Both are IANA 2025b.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIsoInZone, formatWallIso } from '../../src/core/time/timestamp';
import { formatOffset, offsetAt, resolveWall, wallInZone } from '../../src/core/time/zones';

interface Fixture {
  tzdata: string;
  instants: { zone: string; epochMs: number; wall: string; offsetSeconds: number }[];
  walls: { zone: string; wall: string; instants: number[] }[];
}

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'time-oracle.json'), 'utf8')) as Fixture;

describe('time zones against Python zoneinfo', () => {
  it('uses the same IANA release as this runtime', () => {
    expect(oracle.tzdata).toBe(process.versions.tz);
  });

  it('covers gaps, overlaps and plain times in many zones', () => {
    expect(new Set(oracle.instants.map(i => i.zone)).size).toBeGreaterThanOrEqual(15);
    expect(oracle.walls.filter(w => w.instants.length === 0).length).toBeGreaterThan(500);
    expect(oracle.walls.filter(w => w.instants.length === 2).length).toBeGreaterThan(500);
    expect(oracle.walls.filter(w => w.instants.length === 1).length).toBeGreaterThan(500);
  });

  it('shows the same local time and offset for every instant', () => {
    const mismatches: string[] = [];
    for (const c of oracle.instants) {
      const local = formatWallIso(wallInZone(c.epochMs, c.zone));
      const offset = offsetAt(c.epochMs, c.zone);
      const iso = formatIsoInZone(c.epochMs, c.zone);
      if (local !== c.wall || offset !== c.offsetSeconds * 1000 || iso !== `${c.wall}${formatOffset(c.offsetSeconds * 1000)}`) {
        mismatches.push(`${c.zone} ${c.epochMs}: ${local} ${offset} vs ${c.wall} ${c.offsetSeconds * 1000}`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it('finds the same instants for every wall time, including none and two', () => {
    const mismatches: string[] = [];
    for (const c of oracle.walls) {
      const [date, time] = c.wall.split('T');
      const [year, month, day] = date.split('-').map(Number);
      const [hour, minute, second] = time.split(':').map(Number);
      const r = resolveWall({ year, month, day, hour, minute, second, millisecond: 0 }, c.zone);
      const got = r.kind === 'exact' ? [r.instant.epochMs] : r.kind === 'ambiguous' ? [r.earlier.epochMs, r.later.epochMs] : [];
      if (JSON.stringify(got) !== JSON.stringify(c.instants)) mismatches.push(`${c.zone} ${c.wall}: ${JSON.stringify(got)} vs ${JSON.stringify(c.instants)}`);
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });
});
