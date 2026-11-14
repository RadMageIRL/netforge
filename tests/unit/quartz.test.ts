/**
 * Quartz cron expressions. The example expressions and their meanings come from the Quartz
 * CronTrigger tutorial's example table; dates are worked out by hand (2026-11-14 is a Saturday).
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleError } from '../../src/core/schedule/model';
import { explainQuartz, parseQuartz, quartzPattern, QUARTZ_DST_POLICY, type QuartzSchedule } from '../../src/core/schedule/quartz';
import { nextPatternRuns } from '../../src/core/schedule/search';

function ok(expr: string): QuartzSchedule {
  const r = parseQuartz(expr);
  if (!r.ok) throw new Error(`expected ${expr} to parse: ${r.error.message}`);
  return r.value;
}

function err(expr: string): ScheduleError {
  const r = parseQuartz(expr);
  if (r.ok) throw new Error(`expected ${expr} to fail`);
  return r.error as ScheduleError;
}

function isoRuns(expr: string, from: string, count = 4, zone = 'UTC'): string[] {
  const r = nextPatternRuns(quartzPattern(ok(expr)), zone, Date.parse(from), QUARTZ_DST_POLICY, { count });
  return r.rows.flatMap(x => (x.type === 'run' ? [new Date(x.epochMs).toISOString().replace('.000Z', 'Z')] : []));
}

const FROM = '2026-11-14T00:00:00Z';

describe('the CronTrigger tutorial examples', () => {
  it('0 0 12 * * ?: 12:00 every day', () => {
    expect(isoRuns('0 0 12 * * ?', FROM, 2)).toEqual(['2026-11-14T12:00:00Z', '2026-11-15T12:00:00Z']);
  });
  it('0 15 10 ? * MON-FRI: 10:15 Monday to Friday', () => {
    expect(isoRuns('0 15 10 ? * MON-FRI', FROM, 2)).toEqual(['2026-11-16T10:15:00Z', '2026-11-17T10:15:00Z']);
  });
  it('0 15 10 L * ?: 10:15 on the last day of every month', () => {
    expect(isoRuns('0 15 10 L * ?', '2028-01-15T00:00:00Z')).toEqual(['2028-01-31T10:15:00Z', '2028-02-29T10:15:00Z', '2028-03-31T10:15:00Z', '2028-04-30T10:15:00Z']);
  });
  it('0 15 10 L-2 * ?: two days before the last day', () => {
    expect(isoRuns('0 15 10 L-2 * ?', '2026-11-14T00:00:00Z', 3)).toEqual(['2026-11-28T10:15:00Z', '2026-12-29T10:15:00Z', '2027-01-29T10:15:00Z']);
  });
  it('0 15 10 ? * 6L: the last Friday of every month', () => {
    expect(isoRuns('0 15 10 ? * 6L', FROM, 3)).toEqual(['2026-11-27T10:15:00Z', '2026-12-25T10:15:00Z', '2027-01-29T10:15:00Z']);
    expect(isoRuns('0 15 10 ? * FRIL', FROM, 1)).toEqual(['2026-11-27T10:15:00Z']);
  });
  it('0 15 10 ? * 6L 2002-2005: limited by year', () => {
    const r = nextPatternRuns(quartzPattern(ok('0 15 10 ? * 6L 2002-2005')), 'UTC', Date.parse(FROM), QUARTZ_DST_POLICY);
    expect(r.found).toBe(0);
    expect(r.stop).toEqual({ kind: 'past' });
  });
  it('0 15 10 ? * 6#3: the third Friday', () => {
    expect(isoRuns('0 15 10 ? * 6#3', FROM, 3)).toEqual(['2026-11-20T10:15:00Z', '2026-12-18T10:15:00Z', '2027-01-15T10:15:00Z']);
  });
  it('0 0 12 1/5 * ?: every 5 days starting on the 1st', () => {
    expect(ok('0 0 12 1/5 * ?').fields['day-of-month'].values).toEqual([1, 6, 11, 16, 21, 26, 31]);
  });
  it('0 11 11 11 11 ?: every November 11th at 11:11', () => {
    expect(isoRuns('0 11 11 11 11 ?', FROM, 2)).toEqual(['2027-11-11T11:11:00Z', '2028-11-11T11:11:00Z']);
  });
  it('0 0/5 14,18 * * ?: every 5 minutes from 14:00 and from 18:00', () => {
    const s = ok('0 0/5 14,18 * * ?');
    expect(s.fields.minute.values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(s.fields.hour.values).toEqual([14, 18]);
  });
  it('0 10,44 14 ? 3 WED: in March on Wednesdays at 14:10 and 14:44', () => {
    expect(isoRuns('0 10,44 14 ? 3 WED', FROM, 3)).toEqual(['2027-03-03T14:10:00Z', '2027-03-03T14:44:00Z', '2027-03-10T14:10:00Z']);
  });
});

describe('special characters', () => {
  it('nW is the nearest weekday without leaving the month', () => {
    // 1W in August 2026 (the 1st is a Saturday) is Monday the 3rd.
    expect(isoRuns('0 0 9 1W 8 ?', FROM, 1)).toEqual(['2027-08-02T09:00:00Z']);
    expect(isoRuns('0 0 9 1W 8 ? 2026', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-08-03T09:00:00Z']);
    // 15W in November 2026 (the 15th is a Sunday) is Monday the 16th.
    expect(isoRuns('0 0 9 15W * ?', FROM, 2)).toEqual(['2026-11-16T09:00:00Z', '2026-12-15T09:00:00Z']);
  });
  it('LW is the last weekday', () => {
    expect(isoRuns('0 0 9 LW * ?', '2026-01-01T00:00:00Z', 2)).toEqual(['2026-01-30T09:00:00Z', '2026-02-27T09:00:00Z']);
  });
  it('L alone in the day-of-week field is Saturday', () => {
    expect(ok('0 0 12 ? * L').fields['day-of-week'].values).toEqual([7]);
    expect(explainQuartz(ok('0 0 12 ? * L')).notes.join(' ')).toContain('Saturday');
  });
  it('#5 exists only in some months', () => {
    // Fifth Mondays from 2026-11-14: Nov 30 2026, Mar 29 2027.
    expect(isoRuns('0 0 9 ? * 2#5', FROM, 2)).toEqual(['2026-11-30T09:00:00Z', '2027-03-29T09:00:00Z']);
    expect(explainQuartz(ok('0 0 9 ? * 2#5')).warnings.join(' ')).toContain('five Mondays');
  });
  it('steps start where written, and * starts at the field minimum', () => {
    expect(ok('5/20 * * * * ?').fields.second.values).toEqual([5, 25, 45]);
    expect(ok('0 * * ? * */2').fields['day-of-week'].values).toEqual([1, 3, 5, 7]);
    expect(ok('0 0 0 1 */3 ?').fields.month.values).toEqual([1, 4, 7, 10]);
    expect(ok('0 0 0 1 1 ? 2026/10').fields.year!.values).toEqual([2026, 2036, 2046, 2056, 2066, 2076, 2086, 2096]);
  });
  it('reads names and specials in any case', () => {
    expect(ok('0 0 9 ? jan,Jul mon').fields.month.values).toEqual([1, 7]);
    expect(ok('0 0 9 lw * ?').domSpecial).toEqual({ kind: 'last-weekday' });
  });
  it('lists seconds', () => {
    expect(isoRuns('15,45 * * * * ?', FROM, 3)).toEqual(['2026-11-14T00:00:15Z', '2026-11-14T00:00:45Z', '2026-11-14T00:01:15Z']);
  });
});

describe('limits', () => {
  it('stops at 2099', () => {
    const r = nextPatternRuns(quartzPattern(ok('0 0 0 ? 2 2#5')), 'UTC', Date.parse(FROM), QUARTZ_DST_POLICY);
    // A fifth Monday in February needs a leap year whose February 1st is a Monday.
    expect(r.rows.map(x => (x.type === 'run' ? new Date(x.epochMs).toISOString().slice(0, 10) : ''))).toEqual(['2044-02-29', '2072-02-29']);
    expect(r.stop).toEqual({ kind: 'last-year', year: 2099 });
  });
  it('knows a date that never exists', () => {
    expect(nextPatternRuns(quartzPattern(ok('0 0 0 30 2 ?')), 'UTC', Date.parse(FROM), QUARTZ_DST_POLICY).stop).toEqual({ kind: 'never' });
  });
});

describe('errors', () => {
  const cases: [string, string, number][] = [
    ['', 'empty', -1],
    ['0 9 * * 1-5', 'field-count', 0],
    ['@daily', 'cron-syntax', 0],
    ['0 0 12 * * *', 'day-fields', 11],
    ['0 0 12 ? * ?', 'day-fields', 11],
    ['0 0 12 ? * 0', 'range', 11],
    ['0 0 12 ? * 8', 'range', 11],
    ['60 0 12 * * ?', 'range', 0],
    ['0 0 24 * * ?', 'range', 4],
    ['0 0 12 * 13 ?', 'range', 9],
    ['0 0 12 * * ? 1969', 'range', 13],
    ['0 0 12 * * ? 2100', 'range', 13],
    ['0 0 9 ? * FRI-MON', 'reversed-range', 10],
    ['0 0 9 ? * MON-FRI/2', 'unsupported', 10],
    ['0 0 9 L,15 * ?', 'special', 6],
    ['0 0 9 1-15W * ?', 'special', 6],
    ['0 0 9 31W * ?', 'unsupported', 6],
    ['0 0 9 L-28 * ?', 'unsupported', 6],
    ['0 0 9 L-31 * ?', 'range', 6],
    ['0 0 9 L-3W * ?', 'unsupported', 6],
    ['0 0 9 ? * 2#6', 'range', 12],
    ['0 0 9 ? * 2#1,3#1', 'special', 10],
    ['0 /5 * * * ?', 'step', 2],
    ['0 */0 * * * ?', 'step', 4],
    ['0 */60 * * * ?', 'step', 4],
    ['0 1,,2 * * * ?', 'empty-item', 4],
    ['0 ? * * * ?', 'question-mark', 2],
    ['0 0 9 ?,1 * ?', 'question-mark', 6],
    ['0 0 9 ? * MONDAY', 'name', 10],
    ['0 0 0 1 JAN-3 ?', 'name', 8],
    ['0 0 0 ? * MON-5', 'name', 10],
  ];
  for (const [expr, code, offset] of cases) {
    it(`${JSON.stringify(expr)} fails with ${code}`, () => {
      const e = err(expr);
      expect(e.code).toBe(code);
      if (offset >= 0) expect(e.offset).toBe(offset);
    });
  }

  it('explains standard cron habits', () => {
    expect(err('0 0 12 ? * 0').message).toContain('1 (Sunday) to 7');
    expect(err('0 0 12 * * *').message).toContain('0 0 12 * * ?');
    expect(err('0 9 * * 1-5').message).toContain('Standard cron');
  });
});

describe('explanations', () => {
  const summaries: [string, string][] = [
    ['0 0/15 * * * ?', 'Every 15 minutes.'],
    ['* * * * * ?', 'Every second.'],
    ['*/10 * * * * ?', 'Every 10 seconds.'],
    ['0 15 10 ? * 6L', 'At 10:15, on the last Friday of the month.'],
    ['0 0 9 ? * 2#1', 'At 09:00, on the first Monday of the month.'],
    ['0 0 12 15W * ?', 'At 12:00, on the weekday (Monday to Friday) nearest the 15th of the month.'],
    ['0 0 12 LW * ?', 'At 12:00, on the last weekday (Monday to Friday) of the month.'],
    ['0 0 12 L-3 * ?', 'At 12:00, 3 days before the last day of the month.'],
    ['0 0 9 ? * MON-FRI', 'At 09:00, on Monday through Friday.'],
    ['30 0 9 * * ?', 'At 09:00:30.'],
    ['0 0/5 14,18 * * ?', 'Every 5 minutes during hours 14 and 18.'],
    ['0 15,45 */6 * * ?', 'At minutes 15 and 45 past every 6 hours.'],
  ];
  for (const [expr, summary] of summaries) {
    it(`${expr}: ${summary}`, () => expect(explainQuartz(ok(expr)).summary).toBe(summary));
  }

  it('discloses how L-n is counted', () => {
    expect(explainQuartz(ok('0 0 12 L-3 * ?')).warnings.join(' ')).toContain('the 28th in a 31-day month');
  });

  it('includes the year field only when present', () => {
    expect(explainQuartz(ok('0 0 12 * * ?')).fields).toHaveLength(6);
    expect(explainQuartz(ok('0 0 12 * * ? 2030')).fields.map(f => f.field)).toContain('Year');
  });

  it('treats DST outcomes as uncertain', () => {
    expect([QUARTZ_DST_POLICY.nonexistent, QUARTZ_DST_POLICY.repeatedFirst, QUARTZ_DST_POLICY.repeatedSecond]).toEqual(['uncertain', 'uncertain', 'uncertain']);
  });
});
