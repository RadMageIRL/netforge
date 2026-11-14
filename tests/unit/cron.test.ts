/**
 * Standard five-field cron (Vixie cron rules as cronie and Debian cron follow them). Expected runs
 * are worked out by hand from a calendar; day-of-week facts for 2026: Nov 14 is a Saturday,
 * Nov 16 a Monday, Dec 1 a Tuesday.
 */
import { describe, expect, it } from 'vitest';
import { CRON_NICKNAMES, cronDstPolicy, cronPattern, explainCron, parseCron, type CronSchedule } from '../../src/core/schedule/cron';
import type { ScheduleError } from '../../src/core/schedule/model';
import { nextPatternRuns, type NextRuns } from '../../src/core/schedule/search';

function ok(expr: string): CronSchedule {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(`expected ${expr} to parse: ${r.error.message}`);
  return r.value;
}

function err(expr: string): ScheduleError {
  const r = parseCron(expr);
  if (r.ok) throw new Error(`expected ${expr} to fail`);
  return r.error as ScheduleError;
}

function runs(expr: string, from: string, zone = 'UTC', count = 6): NextRuns {
  const s = ok(expr);
  return nextPatternRuns(cronPattern(s), zone, Date.parse(from), cronDstPolicy(s), { count });
}

function isoRuns(expr: string, from: string, zone = 'UTC', count = 6): string[] {
  return runs(expr, from, zone, count).rows.flatMap(r => (r.type === 'run' ? [new Date(r.epochMs).toISOString().replace(':00.000Z', 'Z')] : []));
}

describe('fields', () => {
  it('expands steps, ranges, lists and names', () => {
    const s = ok('*/15 9-17/4 1,15 jan,JUL mon-fri');
    expect(s.fields.minute.values).toEqual([0, 15, 30, 45]);
    expect(s.fields.hour.values).toEqual([9, 13, 17]);
    expect(s.fields['day-of-month'].values).toEqual([1, 15]);
    expect(s.fields.month.values).toEqual([1, 7]);
    expect(s.fields['day-of-week'].values).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads 7 as Sunday, the same as 0', () => {
    expect(ok('0 0 * * 7').fields['day-of-week'].values).toEqual([0]);
    expect(ok('0 0 * * 5-7').fields['day-of-week'].values).toEqual([0, 5, 6]);
    expect(ok('0 0 * * 0-7').fields['day-of-week'].full).toBe(true);
    expect(ok('0 0 * * */2').fields['day-of-week'].values).toEqual([0, 2, 4, 6]);
  });

  it('accepts leading zeros, tabs and surrounding space', () => {
    expect(ok('  05\t09 * * *  ').fields.minute.values).toEqual([5]);
  });

  it('records the Vixie star flag from the field text', () => {
    const s = ok('*/2 * */3 * 1');
    expect(s.fields.minute.star).toBe(true);
    expect(s.fields['day-of-month'].star).toBe(true);
    expect(s.fields['day-of-week'].star).toBe(false);
  });

  it('expands nicknames', () => {
    expect(ok('@daily').expression).toBe('0 0 * * *');
    expect(ok('@MIDNIGHT').expression).toBe('0 0 * * *');
    expect(ok('@weekly').expression).toBe('0 0 * * 0');
    expect(ok('@hourly').fields.minute.values).toEqual([0]);
    expect(Object.keys(CRON_NICKNAMES).sort()).toEqual(['@annually', '@daily', '@hourly', '@midnight', '@monthly', '@weekly', '@yearly']);
    expect(explainCron(ok('@yearly')).normalized).toBe('0 0 1 1 *');
  });
});

describe('day-of-month and day-of-week (the Vixie rule)', () => {
  it('uses OR when both day fields are restricted', () => {
    expect(ok('0 0 1,15 * 1').dayRule).toBe('or');
    expect(isoRuns('0 0 1,15 * 1', '2026-11-14T00:00:00Z')).toEqual([
      '2026-11-15T00:00Z', '2026-11-16T00:00Z', '2026-11-23T00:00Z', '2026-11-30T00:00Z', '2026-12-01T00:00Z', '2026-12-07T00:00Z',
    ]);
  });

  it('uses AND when a day field starts with *, even with a step', () => {
    expect(ok('0 0 */2 * 1').dayRule).toBe('and');
    // Odd-numbered Mondays: Nov 23; Dec 7 and 21; Jan 11 and 25; Feb 1.
    expect(isoRuns('0 0 */2 * 1', '2026-11-14T00:00:00Z')).toEqual([
      '2026-11-23T00:00Z', '2026-12-07T00:00Z', '2026-12-21T00:00Z', '2027-01-11T00:00Z', '2027-01-25T00:00Z', '2027-02-01T00:00Z',
    ]);
    expect(ok('0 0 1 * */2').dayRule).toBe('and');
  });

  it('with one day field *, only the other one counts', () => {
    expect(isoRuns('30 9 * * 1-5', '2026-11-14T00:00:00Z', 'UTC', 3)).toEqual(['2026-11-16T09:30Z', '2026-11-17T09:30Z', '2026-11-18T09:30Z']);
    expect(isoRuns('0 12 13 * *', '2026-11-14T00:00:00Z', 'UTC', 2)).toEqual(['2026-12-13T12:00Z', '2027-01-13T12:00Z']);
  });

  it('warns about OR, AND and the first-Monday trap', () => {
    expect(explainCron(ok('0 0 1-7 * 1')).warnings.join(' ')).toContain('EITHER');
    expect(explainCron(ok('0 0 */2 * 1')).warnings.join(' ')).toContain('BOTH');
    expect(explainCron(ok('0 0 1 * *')).warnings).toEqual([]);
  });
});

describe('next runs', () => {
  it('lists steps within the hour and across midnight', () => {
    expect(isoRuns('*/20 23 * * *', '2026-12-31T23:30:00Z', 'UTC', 4)).toEqual(['2026-12-31T23:40Z', '2027-01-01T23:00Z', '2027-01-01T23:20Z', '2027-01-01T23:40Z']);
  });

  it('crosses a year boundary', () => {
    expect(isoRuns('59 23 31 12 *', '2026-12-31T23:58:00Z', 'UTC', 2)).toEqual(['2026-12-31T23:59Z', '2027-12-31T23:59Z']);
    expect(isoRuns('0 0 1 1 *', '2026-12-31T23:59:59.999Z', 'UTC', 1)).toEqual(['2027-01-01T00:00Z']);
  });

  it('runs strictly after the start', () => {
    expect(isoRuns('0 12 * * *', '2026-11-14T12:00:00Z', 'UTC', 1)).toEqual(['2026-11-15T12:00Z']);
    expect(isoRuns('0 12 * * *', '2026-11-14T11:59:59.999Z', 'UTC', 1)).toEqual(['2026-11-14T12:00Z']);
  });

  it('skips months without the day', () => {
    expect(isoRuns('0 0 31 * *', '2026-11-14T00:00:00Z', 'UTC', 4)).toEqual(['2026-12-31T00:00Z', '2027-01-31T00:00Z', '2027-03-31T00:00Z', '2027-05-31T00:00Z']);
    expect(isoRuns('0 0 29 2 *', '2026-11-14T00:00:00Z', 'UTC', 3)).toEqual(['2028-02-29T00:00Z', '2032-02-29T00:00Z', '2036-02-29T00:00Z']);
  });

  it('reports a schedule that never runs', () => {
    const r = runs('0 0 30 2 *', '2026-11-14T00:00:00Z');
    expect(r.found).toBe(0);
    expect(r.stop).toEqual({ kind: 'never' });
    expect(explainCron(ok('0 0 30 2 *')).warnings.join(' ')).toContain('never runs');
    expect(runs('0 0 31 4,6,9,11 *', '2026-11-14T00:00:00Z').stop).toEqual({ kind: 'never' });
  });

  it('evaluates in the chosen zone', () => {
    // 09:00 in Kolkata (UTC+05:30) is 03:30 UTC.
    expect(isoRuns('0 9 * * *', '2026-11-14T00:00:00Z', 'Asia/Kolkata', 2)).toEqual(['2026-11-14T03:30Z', '2026-11-15T03:30Z']);
  });
});

describe('errors', () => {
  const cases: [string, string, number, number][] = [
    ['', 'empty', -1, 0],
    ['* * * *', 'field-count', 0, 7],
    ['0 0 12 * * ?', 'field-count', 0, 12],
    ['0 0 * * * /bin/backup', 'field-count', 0, 21],
    ['60 * * * *', 'range', 0, 2],
    ['0 24 * * *', 'range', 2, 2],
    ['0 0 0 * *', 'range', 4, 1],
    ['0 0 32 * *', 'range', 4, 2],
    ['0 0 * 13 *', 'range', 6, 2],
    ['0 0 * * 8', 'range', 8, 1],
    ['0 0 * * 5-1', 'reversed-range', 8, 3],
    ['*/0 * * * *', 'step', 2, 1],
    ['*/x * * * *', 'step', 2, 1],
    ['5/15 * * * *', 'quartz-syntax', 0, 4],
    ['0 0 ? * *', 'quartz-syntax', 4, 1],
    ['0 0 L * *', 'quartz-syntax', 4, 1],
    ['0 0 15W * *', 'quartz-syntax', 4, 3],
    ['0 0 * * 1#2', 'quartz-syntax', 9, 1],
    ['0 0 * * monday', 'name', 8, 6],
    ['0 0 * foo *', 'name', 6, 3],
    ['jan * * * *', 'name', 0, 3],
    ['0 0 1,,2 * *', 'empty-item', 6, 0],
    ['0 0 1, * *', 'empty-item', 6, 0],
    ['@reboot', 'reboot', 0, 7],
    ['@often', 'nickname', 0, 6],
    ['@daily /bin/x', 'field-count', 6, 7],
    ['0 0 * * 1-$', 'syntax', 10, 1],
  ];
  for (const [expr, code, offset, length] of cases) {
    it(`${JSON.stringify(expr)} fails with ${code}`, () => {
      const e = err(expr);
      expect(e.code).toBe(code);
      if (offset >= 0) {
        expect(e.offset).toBe(offset);
        expect(e.length).toBe(length);
      }
      expect(e.message.length).toBeGreaterThan(10);
    });
  }

  it('points into the input when it has leading space', () => {
    expect(err('   0 0 * * 9').offset).toBe(11);
  });

  it('names the other dialect instead of reading it silently', () => {
    expect(err('0 0 12 * * ?').message).toContain('Quartz');
    expect(err('5/15 * * * *').message).toContain('5-59/15');
    expect(err('0 0 * * 1#2').message).toContain('1-7 * 1');
  });
});

describe('explanations', () => {
  const summaries: [string, string][] = [
    ['* * * * *', 'Every minute.'],
    ['*/15 * * * *', 'Every 15 minutes.'],
    ['0 * * * *', 'At the start of every hour.'],
    ['5 * * * *', 'At minute 5 of every hour.'],
    ['0 */2 * * *', 'At the start of every 2nd hour.'],
    ['30 9 * * *', 'At 09:30.'],
    ['0 9,17 * * *', 'At 09:00 and 17:00.'],
    ['0 9 * * 1-5', 'At 09:00, on Monday through Friday.'],
    ['0 9 * * 1,3', 'At 09:00, on Monday and Wednesday.'],
    ['*/7 9-17 * * mon-fri', 'Every 7 minutes from 09:00 through 17:59, on Monday through Friday.'],
    ['0 0 1 * *', 'At 00:00, on the 1st of the month.'],
    ['0 0 1 1,7 *', 'At 00:00, on the 1st of the month in January and July.'],
    ['0 0 1,15 * 1', 'At 00:00, on the 1st and the 15th of the month, and also on Monday.'],
    ['0 0 */2 * 1', 'At 00:00, on every 2nd day of the month, but only when that day is also Monday.'],
  ];
  for (const [expr, summary] of summaries) {
    it(`${expr}: ${summary}`, () => expect(explainCron(ok(expr)).summary).toBe(summary));
  }

  it('explains every field', () => {
    const e = explainCron(ok('*/15 9-17 * jan sun'));
    expect(e.fields.map(f => f.field)).toEqual(['Minute', 'Hour', 'Day of month', 'Month', 'Day of week']);
    expect(e.fields[0]).toEqual({ field: 'Minute', text: '*/15', meaning: 'every 15 minutes', values: '0, 15, 30, 45' });
    expect(e.fields[1].meaning).toBe('hours 9 through 17');
    expect(e.fields[1].values).toBe('9-17');
    expect(e.fields[3].values).toBe('Jan');
    expect(e.fields[4].values).toBe('Sun');
  });

  it('warns about uneven steps and short months', () => {
    expect(explainCron(ok('*/7 * * * *')).warnings.join(' ')).toContain('runs at minute 56 and then minute 0 of the next hour, 4 minutes apart');
    expect(explainCron(ok('0 */5 * * *')).warnings.join(' ')).toContain('4 hours apart');
    expect(explainCron(ok('*/15 * * * *')).warnings).toEqual([]);
    expect(explainCron(ok('0 0 31 * *')).warnings.join(' ')).toContain('Day 31 does not exist in every month');
    expect(explainCron(ok('0 0 29 2 *')).warnings.join(' ')).toContain('leap years');
    expect(explainCron(ok('*/90 * * * *')).warnings.join(' ')).toContain('larger than the range');
  });

  it('says which zone cron uses', () => {
    expect(explainCron(ok('0 0 * * *')).notes.join(' ')).toContain('CRON_TZ');
  });
});

describe('DST policy', () => {
  it('marks skipped and repeated times as uncertain, and tells wildcard entries from fixed ones', () => {
    const fixed = cronDstPolicy(ok('30 2 * * *'));
    const wild = cronDstPolicy(ok('*/5 * * * *'));
    expect([fixed.nonexistent, fixed.repeatedFirst, fixed.repeatedSecond]).toEqual(['uncertain', 'runs', 'uncertain']);
    expect(fixed.nonexistentNote).toContain('right after the clocks jump');
    expect(wild.nonexistentNote).toContain('skips it');
    expect(wild.repeatedNote).toContain('both times');
    expect(fixed.repeatedNote).toContain('only the first time');
    // cronie counts an entry as wildcard when either the minute or the hour field starts with *.
    expect(cronDstPolicy(ok('30 * * * *')).repeatedNote).toContain('both times');
    expect(cronDstPolicy(ok('* 2 * * *')).nonexistentNote).toContain('skips it');
  });
});
