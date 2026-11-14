/**
 * systemd calendar expressions. Normalized forms are the examples table of systemd.time(7)
 * ("Calendar Events"), restricted to NetForge's subset; dates are worked out by hand.
 * tests/unit/systemd-oracle.test.ts checks the same parser against systemd-analyze itself.
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleError } from '../../src/core/schedule/model';
import { nextPatternRuns } from '../../src/core/schedule/search';
import { explainSystemd, formatWeekdays, parseSystemd, systemdPattern, SYSTEMD_DST_POLICY, type SystemdSchedule } from '../../src/core/schedule/systemd';

function ok(expr: string): SystemdSchedule {
  const r = parseSystemd(expr);
  if (!r.ok) throw new Error(`expected ${expr} to parse: ${r.error.message}`);
  return r.value;
}

function err(expr: string): ScheduleError {
  const r = parseSystemd(expr);
  if (r.ok) throw new Error(`expected ${expr} to fail`);
  return r.error as ScheduleError;
}

function days(expr: string, from: string, count = 4, zone = 'UTC'): string[] {
  const s = ok(expr);
  const r = nextPatternRuns(systemdPattern(s), s.zone ?? zone, Date.parse(from), SYSTEMD_DST_POLICY, { count });
  return r.rows.flatMap(x => (x.type === 'run' ? [new Date(x.epochMs).toISOString().replace('.000Z', 'Z')] : []));
}

describe('normalized forms from systemd.time(7)', () => {
  const table: [string, string][] = [
    ['Sat,Thu,Mon..Wed,Sat..Sun', 'Mon..Thu,Sat,Sun *-*-* 00:00:00'],
    ['Mon,Sun 12-*-* 2,1:23', 'Mon,Sun 2012-*-* 01,02:23:00'],
    ['Wed *-1', 'Wed *-*-01 00:00:00'],
    ['Wed..Wed,Wed *-1', 'Wed *-*-01 00:00:00'],
    ['Wed, 17:48', 'Wed *-*-* 17:48:00'],
    ['Wed..Sat,Tue 12-10-15 1:2:3', 'Tue..Sat 2012-10-15 01:02:03'],
    ['*-*-7 0:0:0', '*-*-07 00:00:00'],
    ['10-15', '*-10-15 00:00:00'],
    ['monday *-12-* 17:00', 'Mon *-12-* 17:00:00'],
    ['Mon,Fri *-*-3,1,2 *:30:45', 'Mon,Fri *-*-01,02,03 *:30:45'],
    ['12,14,13,12:20,10,30', '*-*-* 12,13,14:10,20,30:00'],
    ['12..14:10,20,30', '*-*-* 12..14:10,20,30:00'],
    ['mon,fri *-1/2-1,3 *:30:45', 'Mon,Fri *-01/2-01,03 *:30:45'],
    ['03-05 08:05:40', '*-03-05 08:05:40'],
    ['08:05:40', '*-*-* 08:05:40'],
    ['05:40', '*-*-* 05:40:00'],
    ['Sat,Sun 12-05 08:05:40', 'Sat,Sun *-12-05 08:05:40'],
    ['Sat,Sun 08:05:40', 'Sat,Sun *-*-* 08:05:40'],
    ['2003-03-05 05:40', '2003-03-05 05:40:00'],
    ['2003-02..04-05', '2003-02..04-05 00:00:00'],
    ['2003-03-05 05:40 UTC', '2003-03-05 05:40:00 UTC'],
    ['2003-03-05', '2003-03-05 00:00:00'],
    ['03-05', '*-03-05 00:00:00'],
    ['hourly', '*-*-* *:00:00'],
    ['daily', '*-*-* 00:00:00'],
    ['daily UTC', '*-*-* 00:00:00 UTC'],
    ['monthly', '*-*-01 00:00:00'],
    ['weekly', 'Mon *-*-* 00:00:00'],
    ['weekly Pacific/Auckland', 'Mon *-*-* 00:00:00 Pacific/Auckland'],
    ['yearly', '*-01-01 00:00:00'],
    ['annually', '*-01-01 00:00:00'],
    ['*:2/3', '*-*-* *:02/3:00'],
  ];
  for (const [input, normalized] of table) {
    it(`${input} -> ${normalized}`, () => expect(ok(input).normalized).toBe(normalized));
  }

  it('normalizes the other shorthands', () => {
    expect(ok('minutely').normalized).toBe('*-*-* *:*:00');
    expect(ok('quarterly').normalized).toBe('*-01,04,07,10-01 00:00:00');
    expect(ok('semiannually').normalized).toBe('*-01,07-01 00:00:00');
    expect(ok('DAILY').normalized).toBe('*-*-* 00:00:00');
  });
});

describe('normalization rules seen in systemd 257', () => {
  const table: [string, string][] = [
    ['Mon-Fri', 'Mon..Fri *-*-* 00:00:00'],
    ['Sat..Sun', 'Sat,Sun *-*-* 00:00:00'],
    ['Mon..Sun', '*-*-* 00:00:00'],
    ['*-*-* 05..05:00', '*-*-* 05:00:00'],
    ['*-*-* 0..23/12:00', '*-*-* 00..12/12:00:00'],
    ['*-*-* 1..3/1:00', '*-*-* 01..03:00:00'],
    ['*-*-* 0..23/25:00', '*-*-* 00:00:00'],
    ['*-*-* 3,1..2:00', '*-*-* 01..02,03:00:00'],
    ['*-*-* 1/2,1:00', '*-*-* 01,01/2:00:00'],
    ['*-*-* 9,09:00', '*-*-* 09:00:00'],
    ['*-*~03,01', '*-*~01,03 00:00:00'],
    ['*-*~01..06/2', '*-*~01..05/2 00:00:00'],
    ['*-*-* *:*:0/1', '*-*-* *:*:*'],
    ['0-01-01', '2000-01-01 00:00:00'],
    ['70-01-01', '1970-01-01 00:00:00'],
    ['69-01-01', '2069-01-01 00:00:00'],
    ['*-*-* 9:00 utc', '*-*-* 09:00:00 UTC'],
    ['OnCalendar=Mon..Fri 9:00', 'Mon..Fri *-*-* 09:00:00'],
  ];
  for (const [input, normalized] of table) {
    it(`${input} -> ${normalized}`, () => expect(ok(input).normalized).toBe(normalized));
  }

  it('formats weekday runs like systemd', () => {
    expect(formatWeekdays(0b1111111)).toBe('Mon..Sun');
    expect(formatWeekdays(0b1000001)).toBe('Mon,Sun');
    expect(formatWeekdays(0b0010101)).toBe('Mon,Wed,Fri');
    expect(formatWeekdays(0b0011111)).toBe('Mon..Fri');
  });
});

describe('next elapses', () => {
  it('ANDs the weekday with the date', () => {
    // Fridays the 13th from 2026-11-14: August 13 2027, October 13 2028.
    expect(days('Fri *-*-13', '2026-11-14T00:00:00Z', 2)).toEqual(['2027-08-13T00:00:00Z', '2028-10-13T00:00:00Z']);
  });
  it('counts ~ days from the end of the month', () => {
    expect(days('*-*~01', '2028-01-15T00:00:00Z', 3)).toEqual(['2028-01-31T00:00:00Z', '2028-02-29T00:00:00Z', '2028-03-31T00:00:00Z']);
    expect(days('*-02~03', '2026-11-14T00:00:00Z', 2)).toEqual(['2027-02-26T00:00:00Z', '2028-02-27T00:00:00Z']);
    // The last Monday in May: 2027-05-31.
    expect(days('Mon *-05~07/1', '2026-11-14T00:00:00Z', 2)).toEqual(['2027-05-31T00:00:00Z', '2028-05-29T00:00:00Z']);
    // ~05/4 in November (30 days): the 26th and the 30th.
    expect(days('*-*~05/4', '2026-11-14T00:00:00Z', 2)).toEqual(['2026-11-26T00:00:00Z', '2026-11-30T00:00:00Z']);
    expect(days('*-*~01..03', '2026-11-14T00:00:00Z', 3)).toEqual(['2026-11-28T00:00:00Z', '2026-11-29T00:00:00Z', '2026-11-30T00:00:00Z']);
  });
  it('repeats from a start value', () => {
    expect(days('*:0/20', '2026-11-14T00:30:00Z', 3)).toEqual(['2026-11-14T00:40:00Z', '2026-11-14T01:00:00Z', '2026-11-14T01:20:00Z']);
    expect(days('*-*-29/2', '2026-11-14T00:00:00Z', 3)).toEqual(['2026-11-29T00:00:00Z', '2026-12-29T00:00:00Z', '2026-12-31T00:00:00Z']);
  });
  it('uses the zone in the expression', () => {
    // Midnight Monday in Auckland (NZDT, UTC+13 in November) is 11:00 UTC on Sunday.
    expect(days('weekly Pacific/Auckland', '2026-11-14T00:00:00Z', 1)).toEqual(['2026-11-15T11:00:00Z']);
  });
  it('stops at 2199 and reports past and impossible dates', () => {
    const at = (e: string) => nextPatternRuns(systemdPattern(ok(e)), 'UTC', Date.parse('2026-11-14T00:00:00Z'), SYSTEMD_DST_POLICY);
    expect(at('2199-12-31 23:59:59').found).toBe(1);
    expect(at('2199-12-31 23:59:59').stop).toEqual({ kind: 'last-year', year: 2199 });
    expect(at('2012-10-15').stop).toEqual({ kind: 'past' });
    expect(at('*-02-30').stop).toEqual({ kind: 'never' });
  });
});

describe('rejected input', () => {
  const cases: [string, string, number][] = [
    ['', 'empty', -1],
    ['OnBootSec=15min', 'monotonic', 0],
    ['OnUnitActiveSec = 1h', 'monotonic', 0],
    ['15min', 'timespan', 0],
    ['1h 30min', 'timespan', 0],
    ['*:*/15', 'cron-syntax', 2],
    ['*-*-* */2:00', 'cron-syntax', 6],
    ['@daily', 'cron-syntax', 0],
    ['Fri..Mon', 'reversed-range', 0],
    ['*-*-* 03..01:00', 'reversed-range', 6],
    ['Mon Tue', 'weekday', 4],
    ['Mon,,Tue', 'empty-item', 4],
    ['Tues', 'weekday', 0],
    ['123-01-01', 'year-digits', 0],
    ['1969-01-01', 'range', 0],
    ['2200-01-01', 'range', 0],
    ['*-13-01', 'range', 2],
    ['*-*-00', 'range', 4],
    ['*-*~00', 'range', 4],
    ['*-*~29', 'range', 4],
    ['*-*-* 24:00', 'range', 6],
    ['*-*-* 23:59:60', 'range', 12],
    ['0/24:00', 'repeat', 0],
    ['*:59/1', 'repeat', 2],
    ['*-*-1/31', 'repeat', 4],
    ['*-*~05/5', 'repeat', 4],
    ['*-*-* 0/0:00', 'repeat', 8],
    ['05:40:23.42', 'fraction', 6],
    ['*-*-* 9:00 EDT', 'zone-abbreviation', 11],
    ['*-*-* 9:00 Z', 'zone-abbreviation', 11],
    ['*-*-* 9:00 america/new_york', 'zone', 11],
    ['*-*-* 9:00 Foo/Bar', 'zone', 11],
    ['*-*-* 9:00 UTC extra', 'extra', 15],
    ['daily 09:00', 'extra', 6],
    ['2026-*-* 9', 'syntax', 9],
  ];
  for (const [expr, code, offset] of cases) {
    it(`${JSON.stringify(expr)} fails with ${code}`, () => {
      const e = err(expr);
      expect(e.code).toBe(code);
      if (offset >= 0) expect(e.offset).toBe(offset);
    });
  }

  it('says what a monotonic setting is', () => {
    expect(err('OnBootSec=15min').message).toContain('monotonic');
    expect(err('15min').message).toContain('OnBootSec');
  });
});

describe('explanations', () => {
  const summaries: [string, string][] = [
    ['Mon..Fri 09:00', 'At 09:00, on Monday through Friday.'],
    ['*:0/15', 'Every 15 minutes.'],
    ['daily', 'At 00:00.'],
    ['hourly', 'At the start of every hour.'],
    ['*-*~01', 'At 00:00, on the last day of the month.'],
    ['Mon *-*-01..07 12:00', 'At 12:00, on the first Monday of the month.'],
    ['Mon *-05~07/1', 'At 00:00, on the last Monday of May.'],
    ['Fri *-*-13', 'At 00:00, on Friday, on the 13th of the month (the weekday and the date must both match).'],
    ['weekly Pacific/Auckland', 'At 00:00, on Monday, Pacific/Auckland time.'],
  ];
  for (const [expr, summary] of summaries) {
    it(`${expr}: ${summary}`, () => expect(explainSystemd(ok(expr)).summary).toBe(summary));
  }

  it('explains each component and says it is not a whole timer unit', () => {
    const e = explainSystemd(ok('Mon..Fri 09:00'));
    expect(e.fields.map(f => f.field)).toEqual(['Weekday', 'Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'Time zone']);
    expect(e.normalized).toBe('Mon..Fri *-*-* 09:00:00');
    expect(e.notes.join(' ')).toContain('not a whole timer');
    expect(e.notes.join(' ')).toContain('AccuracySec');
    expect(explainSystemd(ok('daily')).notes.join(' ')).toContain('daily is shorthand for *-*-* 00:00:00');
  });

  it('records the observed DST behavior', () => {
    expect([SYSTEMD_DST_POLICY.nonexistent, SYSTEMD_DST_POLICY.repeatedFirst, SYSTEMD_DST_POLICY.repeatedSecond]).toEqual(['skipped', 'runs', 'skipped']);
    expect(SYSTEMD_DST_POLICY.basis).toContain('systemd 257');
  });
});
