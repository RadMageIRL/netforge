/**
 * The next-run search: DST gaps and repeats, ordering, local/UTC consistency, limits.
 * Transitions used (from the published rules, as in zones.test.ts):
 * - America/New_York 2026: 02:00 EST -> 03:00 EDT on Mar 8 (07:00Z); 02:00 EDT -> 01:00 EST on Nov 1 (06:00Z).
 * - Europe/London 2026: 01:00 GMT -> 02:00 BST on Mar 29 (01:00Z).
 * - Australia/Lord_Howe 2026: 02:00 (+11) -> 01:30 (+10:30) on Apr 5 (Apr 4 15:00Z);
 *   02:00 (+10:30) -> 02:30 (+11) on Oct 4 (Oct 3 15:30Z).
 * - Pacific/Apia: Friday 2011-12-30 did not exist; clocks went from UTC-10 to UTC+14 at local midnight (2011-12-30T10:00Z).
 */
import { describe, expect, it } from 'vitest';
import { cronDstPolicy, cronPattern, parseCron } from '../../src/core/schedule/cron';
import { dstImpacts, zoneTransitions } from '../../src/core/schedule/dst';
import type { CalendarPattern, DstPolicy } from '../../src/core/schedule/model';
import { parseQuartz, quartzPattern, QUARTZ_DST_POLICY } from '../../src/core/schedule/quartz';
import { collectRuns, MAX_WALL_TIMES, nextPatternRuns, patternWalls, type ScheduleRow } from '../../src/core/schedule/search';
import { parseSystemd, systemdPattern, SYSTEMD_DST_POLICY } from '../../src/core/schedule/systemd';
import { nextWindowsRuns } from '../../src/core/schedule/windows';
import { ZoneTimeline } from '../../src/core/schedule/zone-timeline';
import { offsetAt, resolveWall, utcFromWall, wallFromUtc, wallInZone } from '../../src/core/time/zones';

const H = 3_600_000;
const Z = (iso: string) => Date.parse(iso);

function cron(expr: string): { p: CalendarPattern; policy: DstPolicy } {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error.message);
  return { p: cronPattern(r.value), policy: cronDstPolicy(r.value) };
}
function quartz(expr: string): { p: CalendarPattern; policy: DstPolicy } {
  const r = parseQuartz(expr);
  if (!r.ok) throw new Error(r.error.message);
  return { p: quartzPattern(r.value), policy: QUARTZ_DST_POLICY };
}
function systemd(expr: string): { p: CalendarPattern; policy: DstPolicy } {
  const r = parseSystemd(expr);
  if (!r.ok) throw new Error(r.error.message);
  return { p: systemdPattern(r.value), policy: SYSTEMD_DST_POLICY };
}

/** A compact, readable form of each row. */
function rows(x: { p: CalendarPattern; policy: DstPolicy }, zone: string, from: string, count: number): string[] {
  return nextPatternRuns(x.p, zone, Z(from), x.policy, { count }).rows.map(show);
}
function show(r: ScheduleRow): string {
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const wall = (ms: number) => iso(ms).slice(0, 19).replace('T', ' ');
  if (r.type === 'run') return `${r.index ?? '-'} ${iso(r.epochMs)} ${r.kind} ${r.outcome}`;
  return `group ${r.kind} ${r.outcome} ${wall(r.firstWallMs)}${r.count > 1 ? ` .. ${wall(r.lastWallMs)}` : ''} x${r.count} at ${iso(r.transition.at)}`;
}

describe('spring forward: local times that do not exist', () => {
  it('cron 02:30 in New York on 2026-03-08', () => {
    expect(rows(cron('30 2 * * *'), 'America/New_York', '2026-03-07T12:00:00Z', 2)).toEqual([
      'group nonexistent uncertain 2026-03-08 02:30:00 x1 at 2026-03-08T07:00:00Z',
      '1 2026-03-09T06:30:00Z normal runs',
      '2 2026-03-10T06:30:00Z normal runs',
    ]);
  });

  it('collapses a whole skipped hour into one row', () => {
    expect(rows(cron('* 2 * * *'), 'America/New_York', '2026-03-08T06:58:00Z', 1)).toEqual([
      'group nonexistent uncertain 2026-03-08 02:00:00 .. 2026-03-08 02:59:00 x60 at 2026-03-08T07:00:00Z',
      '1 2026-03-09T06:00:00Z normal runs',
    ]);
  });

  it('systemd skips the missing hour and keeps the later ones (as systemd-analyze 257 does)', () => {
    expect(rows(systemd('*-*-* 02/1:00:00'), 'America/New_York', '2026-03-08T05:00:00Z', 2)).toEqual([
      'group nonexistent skipped 2026-03-08 02:00:00 x1 at 2026-03-08T07:00:00Z',
      '1 2026-03-08T07:00:00Z normal runs',
      '2 2026-03-08T08:00:00Z normal runs',
    ]);
  });

  it('London 01:30 on 2026-03-29', () => {
    expect(rows(cron('30 1 * * *'), 'Europe/London', '2026-03-28T12:00:00Z', 1)).toEqual([
      'group nonexistent uncertain 2026-03-29 01:30:00 x1 at 2026-03-29T01:00:00Z',
      '1 2026-03-30T00:30:00Z normal runs',
    ]);
  });

  it('Lord Howe skips only 02:00 to 02:29 (a 30-minute change)', () => {
    expect(rows(cron('15 2 * * *'), 'Australia/Lord_Howe', '2026-10-03T00:00:00Z', 1)).toEqual([
      'group nonexistent uncertain 2026-10-04 02:15:00 x1 at 2026-10-03T15:30:00Z',
      '1 2026-10-04T15:15:00Z normal runs',
    ]);
    expect(rows(cron('45 2 * * *'), 'Australia/Lord_Howe', '2026-10-03T00:00:00Z', 1)).toEqual(['1 2026-10-03T15:45:00Z normal runs']);
  });

  it('Samoa skipped all of 2011-12-30', () => {
    expect(rows(cron('0 12 * * *'), 'Pacific/Apia', '2011-12-29T00:00:00Z', 2)).toEqual([
      '1 2011-12-29T22:00:00Z normal runs',
      'group nonexistent uncertain 2011-12-30 12:00:00 x1 at 2011-12-30T10:00:00Z',
      '2 2011-12-30T22:00:00Z normal runs',
    ]);
  });
});

describe('fall back: local times that happen twice', () => {
  it('cron lists both passes; the second is uncertain', () => {
    expect(rows(cron('30 1 * * *'), 'America/New_York', '2026-10-31T12:00:00Z', 3)).toEqual([
      '1 2026-11-01T05:30:00Z repeated-first runs',
      '2 2026-11-01T06:30:00Z repeated-second uncertain',
      '3 2026-11-02T06:30:00Z normal runs',
    ]);
  });

  it('systemd runs the first pass only (as systemd-analyze 257 does)', () => {
    expect(rows(systemd('*-*-* 01:30:00'), 'America/New_York', '2026-10-31T12:00:00Z', 2)).toEqual([
      '1 2026-11-01T05:30:00Z repeated-first runs',
      'group repeated-second skipped 2026-11-01 01:30:00 x1 at 2026-11-01T06:00:00Z',
      '2 2026-11-02T06:30:00Z normal runs',
    ]);
    expect(rows(systemd('*:00/20'), 'America/New_York', '2026-11-01T04:50:00Z', 4)).toEqual([
      '1 2026-11-01T05:00:00Z repeated-first runs',
      '2 2026-11-01T05:20:00Z repeated-first runs',
      '3 2026-11-01T05:40:00Z repeated-first runs',
      'group repeated-second skipped 2026-11-01 01:00:00 .. 2026-11-01 01:40:00 x3 at 2026-11-01T06:00:00Z',
      '4 2026-11-01T07:00:00Z normal runs',
    ]);
  });

  it('orders interleaved passes by instant, second by second', () => {
    expect(rows(quartz('* * * * * ?'), 'America/New_York', '2026-11-01T05:59:58Z', 3)).toEqual([
      '1 2026-11-01T05:59:59Z repeated-first uncertain',
      '2 2026-11-01T06:00:00Z repeated-second uncertain',
      '3 2026-11-01T06:00:01Z repeated-second uncertain',
    ]);
    expect(rows(cron('*/20 1 * * *'), 'America/New_York', '2026-11-01T04:00:00Z', 7).slice(2, 5)).toEqual([
      '3 2026-11-01T05:40:00Z repeated-first runs',
      '4 2026-11-01T06:00:00Z repeated-second uncertain',
      '5 2026-11-01T06:20:00Z repeated-second uncertain',
    ]);
  });

  it('Lord Howe repeats only 01:30 to 01:59', () => {
    expect(rows(cron('45 1 * * *'), 'Australia/Lord_Howe', '2026-04-04T00:00:00Z', 3)).toEqual([
      '1 2026-04-04T14:45:00Z repeated-first runs',
      '2 2026-04-04T15:15:00Z repeated-second uncertain',
      '3 2026-04-05T15:15:00Z normal runs',
    ]);
    expect(rows(cron('15 1 * * *'), 'Australia/Lord_Howe', '2026-04-04T00:00:00Z', 1)).toEqual(['1 2026-04-04T14:15:00Z normal runs']);
  });

  it('systemd started inside the second pass runs the rest of it (systemd-analyze 257 walks local time from the start)', () => {
    // 06:05Z is 01:05 EST: 01:15, 01:30 and 01:45 EST still come, once each.
    expect(rows(systemd('*:00/15'), 'America/New_York', '2026-11-01T06:05:00Z', 4)).toEqual([
      '1 2026-11-01T06:15:00Z repeated-second runs',
      '2 2026-11-01T06:30:00Z repeated-second runs',
      '3 2026-11-01T06:45:00Z repeated-second runs',
      '4 2026-11-01T07:00:00Z normal runs',
    ]);
    expect(rows(systemd('*-*-* 01:30:00'), 'America/New_York', '2026-11-01T06:05:00Z', 1)).toEqual(['1 2026-11-01T06:30:00Z repeated-second runs']);
  });

  it('a start inside the second pass only lists later instants', () => {
    // 06:10Z is 01:10 EST, the second pass.
    expect(rows(cron('*/20 1 * * *'), 'America/New_York', '2026-11-01T06:10:00Z', 2)).toEqual([
      '1 2026-11-01T06:20:00Z repeated-second uncertain',
      '2 2026-11-01T06:40:00Z repeated-second uncertain',
    ]);
  });
});

describe('invariants over many schedules and zones', () => {
  const exprs = ['*/7 * * * *', '30 1,2 * * *', '0 * * * *', '15 0-3 * * 0', '*/20 1-2 * 3,10,11 *', '0 2 1-10 * *', '59 23 * * *', 'quartz:0 30 1 L * ?', 'quartz:*/30 * 0-3 * * ?'];
  const zones = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo', 'Asia/Kolkata', 'UTC', 'America/St_Johns'];
  const starts = ['2026-03-07T00:00:00Z', '2026-10-24T00:00:00Z', '2026-04-03T00:00:00Z', '2026-09-26T00:00:00Z', '2026-11-01T00:00:00Z'];

  it('rows come in instant order, runs never repeat, and each run shows its wall time at its offset', () => {
    let checked = 0;
    for (const expr of exprs) {
      const x = expr.startsWith('quartz:') ? quartz(expr.slice(7)) : cron(expr);
      for (const zone of zones) {
        for (const from of starts) {
          const r = nextPatternRuns(x.p, zone, Z(from), x.policy, { count: 60 });
          let lastKey = -Infinity;
          const seen = new Set<number>();
          let index = 0;
          for (const row of r.rows) {
            const key = row.type === 'run' ? row.epochMs : row.transition.at;
            if (key < lastKey) throw new Error(`order ${expr} ${zone} ${from}`);
            lastKey = key;
            if (row.type !== 'run') continue;
            if (seen.has(row.epochMs)) throw new Error(`duplicate ${expr} ${zone}`);
            seen.add(row.epochMs);
            if (row.epochMs <= Z(from)) throw new Error('run not after start');
            const w = wallInZone(row.epochMs, zone);
            if (utcFromWall(w) !== row.wallMs) throw new Error(`wall mismatch ${expr} ${zone} ${row.epochMs}`);
            if (offsetAt(row.epochMs, zone) !== row.offsetMs) throw new Error('offset mismatch');
            if (row.index !== null) { index++; if (row.index !== index) throw new Error('index'); }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('the zone timeline', () => {
  it('maps wall times exactly like resolveWall (checked against zoneinfo) around many transitions', () => {
    const zones = ['America/New_York', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Pacific/Apia', 'Pacific/Kiritimati', 'Europe/Moscow', 'Antarctica/Casey', 'Asia/Tehran', 'America/St_Johns', 'Africa/Casablanca'];
    let compared = 0;
    for (const zone of zones) {
      const timeline = new ZoneTimeline(zone);
      for (const t of zoneTransitions(zone, Z('1990-01-01T00:00:00Z'), Z('2030-01-01T00:00:00Z'))) {
        const lo = t.at + Math.min(t.before, t.after);
        const hi = t.at + Math.max(t.before, t.after);
        for (const wall of [lo - 60_000, lo, lo + 1000, Math.floor((lo + hi) / 2), hi - 1000, hi, hi + 60_000]) {
          const expected = resolveWall(wallFromUtc(wall), zone);
          const got = timeline.map(wall);
          const want = expected.kind === 'exact' ? [expected.instant.epochMs] : expected.kind === 'ambiguous' ? [expected.earlier.epochMs, expected.later.epochMs] : [];
          const have = got.kind === 'exact' ? [got.epochMs] : got.kind === 'repeated' ? [got.first.epochMs, got.second.epochMs] : [];
          if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`${zone} ${new Date(wall).toISOString()}: ${JSON.stringify(have)} vs ${JSON.stringify(want)}`);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(3000);
  });

  it('finds the 2026 New York transitions', () => {
    expect(zoneTransitions('America/New_York', Z('2026-01-01T00:00:00Z'), Z('2027-01-01T00:00:00Z'))).toEqual([
      { at: Z('2026-03-08T07:00:00Z'), before: -5 * H, after: -4 * H },
      { at: Z('2026-11-01T06:00:00Z'), before: -4 * H, after: -5 * H },
    ]);
    expect(zoneTransitions('UTC', Z('2026-01-01T00:00:00Z'), Z('2027-01-01T00:00:00Z'))).toEqual([]);
  });
});

describe('DST changes ahead', () => {
  it('reports which scheduled times a change skips or repeats', () => {
    const x = cron('30 1,2 * * *');
    const impacts = dstImpacts(w => patternWalls(x.p, w, 9999), 'America/New_York', Z('2026-01-01T00:00:00Z'));
    expect(impacts.map(i => [i.kind, new Date(i.firstWallMs).toISOString().slice(0, 16), i.count])).toEqual([
      ['nonexistent', '2026-03-08T02:30', 1],
      ['repeated', '2026-11-01T01:30', 1],
    ]);
    const daily9 = cron('0 9 * * *');
    expect(dstImpacts(w => patternWalls(daily9.p, w, 9999), 'America/New_York', Z('2026-01-01T00:00:00Z'))).toEqual([]);
  });
});

describe('limits', () => {
  it('stops an endless candidate stream after MAX_WALL_TIMES', () => {
    function* forever() { for (let w = Z('2026-01-01T00:00:00Z'); ; w += 60_000) yield w; }
    const started = performance.now();
    const r = collectRuns(forever(), 'UTC', Z('2025-01-01T00:00:00Z'), Number.MAX_SAFE_INTEGER, QUARTZ_DST_POLICY);
    expect(r.exhausted).toBe(false);
    expect(r.examined).toBe(MAX_WALL_TIMES + 1);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('a one-time trigger repeating every minute forever is cut off with a reason', () => {
    const r = nextWindowsRuns({ kind: 'once', start: { year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, repetition: { intervalMinutes: 1, durationMinutes: null } }, 'UTC', Z('2026-01-01T00:00:00Z'), { count: MAX_WALL_TIMES * 2 });
    expect(r.stop).toEqual({ kind: 'limit', examined: MAX_WALL_TIMES + 1 });
  });

  it('decides "never" and rare schedules quickly', () => {
    const started = performance.now();
    const never = nextPatternRuns(cron('0 0 30 2 *').p, 'UTC', Z('2026-11-14T00:00:00Z'), cron('0 0 30 2 *').policy);
    const rare = nextPatternRuns(systemd('Mon *-02-29').p, 'UTC', Z('2026-11-14T00:00:00Z'), SYSTEMD_DST_POLICY);
    const seconds = nextPatternRuns(quartz('* * * * * ?').p, 'America/New_York', Z('2026-11-01T05:00:00Z'), QUARTZ_DST_POLICY, { count: 10 });
    expect(never.stop).toEqual({ kind: 'never' });
    // Mondays that are February 29th, counted with Date as an independent check.
    const expected: string[] = [];
    for (let y = 2027; y <= 2199; y++) if (new Date(Date.UTC(y, 1, 29)).getUTCDate() === 29 && new Date(Date.UTC(y, 1, 29)).getUTCDay() === 1) expected.push(`${y}-02-29`);
    expect(rare.rows.map(r => (r.type === 'run' ? new Date(r.epochMs).toISOString().slice(0, 10) : ''))).toEqual(expected.slice(0, 10));
    expect(rare.stop).toEqual(expected.length < 10 ? { kind: 'last-year', year: 2199 } : null);
    expect(seconds.found).toBe(10);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
