/**
 * Windows Task Scheduler triggers: validation, descriptions, next runs. Dates worked out by hand:
 * 2026-11-14 is a Saturday; Tuesdays in November 2026 are the 3rd, 10th, 17th and 24th.
 */
import { describe, expect, it } from 'vitest';
import { describeWindowsTrigger, nextWindowsRuns, validateWindowsTrigger, windowsLimitations, WINDOWS_DST_POLICY, type LocalDateTime, type WindowsTrigger } from '../../src/core/schedule/windows';

const start = (y: number, mo: number, d: number, h = 9, mi = 0, s = 0): LocalDateTime => ({ year: y, month: mo, day: d, hour: h, minute: mi, second: s });

function runs(t: WindowsTrigger, from: string, count = 4, zone = 'UTC'): string[] {
  return nextWindowsRuns(t, zone, Date.parse(from), { count }).rows.flatMap(r => (r.type === 'run' ? [new Date(r.epochMs).toISOString().slice(0, 16)] : []));
}

describe('next runs', () => {
  it('daily every 3 days from the start date', () => {
    expect(runs({ kind: 'daily', start: start(2026, 11, 14), daysInterval: 3, repetition: null }, '2026-11-15T00:00:00Z', 3)).toEqual(['2026-11-17T09:00', '2026-11-20T09:00', '2026-11-23T09:00']);
  });

  it('never runs before its start date', () => {
    expect(runs({ kind: 'daily', start: start(2027, 1, 10), daysInterval: 1, repetition: null }, '2026-11-15T00:00:00Z', 1)).toEqual(['2027-01-10T09:00']);
  });

  it('weekly every 2 weeks, counting weeks from the start date', () => {
    // Week of the start (Nov 8 to 14) has no Monday or Wednesday on or after Saturday the 14th; the next run week is Nov 22 to 28.
    expect(runs({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 2, days: [1, 3], repetition: null }, '2026-11-01T00:00:00Z')).toEqual([
      '2026-11-23T09:00', '2026-11-25T09:00', '2026-12-07T09:00', '2026-12-09T09:00',
    ]);
  });

  it('counts weeks from the Sunday on or before the start date', () => {
    // Sunday-based weeks: the start week is Nov 8 to 14, so Sunday the 15th opens a skipped week.
    expect(runs({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 2, days: [0], repetition: null }, '2026-11-01T00:00:00Z', 2)).toEqual(['2026-11-22T09:00', '2026-12-06T09:00']);
  });

  it('monthly on days of chosen months', () => {
    expect(runs({ kind: 'monthly', start: start(2026, 11, 14), months: [1, 7], days: [1, 15], lastDay: false, repetition: null }, '2026-11-14T00:00:00Z')).toEqual([
      '2027-01-01T09:00', '2027-01-15T09:00', '2027-07-01T09:00', '2027-07-15T09:00',
    ]);
  });

  it('monthly on the last day', () => {
    expect(runs({ kind: 'monthly', start: start(2026, 11, 14), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: [], lastDay: true, repetition: null }, '2026-11-14T00:00:00Z')).toEqual([
      '2026-11-30T09:00', '2026-12-31T09:00', '2027-01-31T09:00', '2027-02-28T09:00',
    ]);
  });

  it('monthly on the second and last Tuesday', () => {
    expect(runs({ kind: 'monthly-dow', start: start(2026, 11, 14), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], weeks: [2, 'last'], days: [2], repetition: null }, '2026-11-14T00:00:00Z', 5)).toEqual([
      '2026-11-24T09:00', '2026-12-08T09:00', '2026-12-29T09:00', '2027-01-12T09:00', '2027-01-26T09:00',
    ]);
  });

  it('repeats within the duration, across midnight, without counting the end', () => {
    const t: WindowsTrigger = { kind: 'daily', start: start(2026, 11, 14, 22), daysInterval: 1, repetition: { intervalMinutes: 60, durationMinutes: 240 } };
    expect(runs(t, '2026-11-14T00:00:00Z', 5)).toEqual(['2026-11-14T22:00', '2026-11-14T23:00', '2026-11-15T00:00', '2026-11-15T01:00', '2026-11-15T22:00']);
    // A repetition that began the day before is still found.
    expect(runs(t, '2026-11-15T00:30:00Z', 2)).toEqual(['2026-11-15T01:00', '2026-11-15T22:00']);
  });

  it('a one-time trigger ends', () => {
    const t: WindowsTrigger = { kind: 'once', start: start(2026, 11, 14, 23, 30), repetition: { intervalMinutes: 20, durationMinutes: 60 } };
    const r = nextWindowsRuns(t, 'UTC', Date.parse('2026-11-14T00:00:00Z'));
    expect(r.rows.map(x => (x.type === 'run' ? new Date(x.epochMs).toISOString().slice(0, 16) : ''))).toEqual(['2026-11-14T23:30', '2026-11-14T23:50', '2026-11-15T00:10']);
    expect(r.stop).toEqual({ kind: 'ended' });
    expect(nextWindowsRuns({ kind: 'once', start: start(2020, 1, 1), repetition: null }, 'UTC', Date.parse('2026-01-01T00:00:00Z')).stop).toEqual({ kind: 'ended' });
  });

  it('every 15 minutes for a day from midnight matches clock quarters', () => {
    const t: WindowsTrigger = { kind: 'daily', start: start(2026, 11, 14, 0), daysInterval: 1, repetition: { intervalMinutes: 15, durationMinutes: 1440 } };
    expect(runs(t, '2026-11-14T23:40:00Z', 3)).toEqual(['2026-11-14T23:45', '2026-11-15T00:00', '2026-11-15T00:15']);
  });

  it('works in local time and treats DST outcomes as undocumented', () => {
    expect(runs({ kind: 'daily', start: start(2026, 3, 1, 2, 30), daysInterval: 1, repetition: null }, '2026-03-07T12:00:00Z', 1, 'America/New_York')).toEqual(['2026-03-09T06:30']);
    const r = nextWindowsRuns({ kind: 'daily', start: start(2026, 3, 1, 2, 30), daysInterval: 1, repetition: null }, 'America/New_York', Date.parse('2026-03-07T12:00:00Z'), { count: 1 });
    expect(r.rows[0]).toMatchObject({ type: 'group', kind: 'nonexistent', outcome: 'uncertain' });
    expect([WINDOWS_DST_POLICY.nonexistent, WINDOWS_DST_POLICY.repeatedFirst, WINDOWS_DST_POLICY.repeatedSecond]).toEqual(['uncertain', 'uncertain', 'uncertain']);
  });
});

describe('validation', () => {
  const bad: [WindowsTrigger, string][] = [
    [{ kind: 'daily', start: start(2026, 2, 30), daysInterval: 1, repetition: null }, 'start'],
    [{ kind: 'daily', start: start(2026, 1, 1, 24), daysInterval: 1, repetition: null }, 'start'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 0, repetition: null }, 'interval'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 366, repetition: null }, 'interval'],
    [{ kind: 'weekly', start: start(2026, 1, 1), weeksInterval: 53, days: [1], repetition: null }, 'interval'],
    [{ kind: 'weekly', start: start(2026, 1, 1), weeksInterval: 1, days: [], repetition: null }, 'days'],
    [{ kind: 'monthly', start: start(2026, 1, 1), months: [], days: [1], lastDay: false, repetition: null }, 'months'],
    [{ kind: 'monthly', start: start(2026, 1, 1), months: [1], days: [], lastDay: false, repetition: null }, 'days'],
    [{ kind: 'monthly', start: start(2026, 1, 1), months: [1], days: [32], lastDay: false, repetition: null }, 'days'],
    [{ kind: 'monthly-dow', start: start(2026, 1, 1), months: [1], weeks: [], days: [1], repetition: null }, 'weeks'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 1, repetition: { intervalMinutes: 0, durationMinutes: 60 } }, 'repetition'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 1, repetition: { intervalMinutes: 30, durationMinutes: 20 } }, 'repetition'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 1, repetition: { intervalMinutes: 30, durationMinutes: null } }, 'repetition'],
    [{ kind: 'daily', start: start(2026, 1, 1), daysInterval: 1, repetition: { intervalMinutes: 30, durationMinutes: 1441 } }, 'repetition'],
  ];
  for (const [t, code] of bad) {
    it(`rejects ${JSON.stringify(t).slice(0, 90)} with ${code}`, () => {
      const r = validateWindowsTrigger(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    });
  }

  it('accepts indefinite repetition on a one-time trigger and a full day on a daily one', () => {
    expect(validateWindowsTrigger({ kind: 'once', start: start(2026, 1, 1), repetition: { intervalMinutes: 5, durationMinutes: null } }).ok).toBe(true);
    expect(validateWindowsTrigger({ kind: 'daily', start: start(2026, 1, 1), daysInterval: 1, repetition: { intervalMinutes: 5, durationMinutes: 1440 } }).ok).toBe(true);
  });
});

describe('descriptions and limitations', () => {
  it('describes each trigger kind', () => {
    expect(describeWindowsTrigger({ kind: 'daily', start: start(2026, 11, 14, 0), daysInterval: 1, repetition: { intervalMinutes: 15, durationMinutes: 1440 } }))
      .toBe('At 00:00 every day, starting 2026-11-14. After triggered, repeat every 15 minutes for a duration of 1 day.');
    expect(describeWindowsTrigger({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 2, days: [1, 3], repetition: null }))
      .toBe('At 09:00 every Monday and Wednesday of every 2 weeks, starting 2026-11-14.');
    expect(describeWindowsTrigger({ kind: 'monthly-dow', start: start(2026, 11, 14), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], weeks: [1], days: [1], repetition: null }))
      .toBe('At 09:00 on the first Monday of every month, starting 2026-11-14.');
    expect(describeWindowsTrigger({ kind: 'monthly', start: start(2026, 11, 14), months: [1, 7], days: [], lastDay: true, repetition: null }))
      .toBe('At 09:00 on the last day of January and July, starting 2026-11-14.');
    expect(describeWindowsTrigger({ kind: 'once', start: start(2026, 11, 14, 8, 30), repetition: { intervalMinutes: 60, durationMinutes: null } }))
      .toBe('One time at 08:30 on 2026-11-14. After triggered, repeat every 1 hour indefinitely.');
  });

  it('names what Microsoft does not document', () => {
    expect(windowsLimitations({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 2, days: [0], repetition: null }).join(' ')).toContain('Sunday or Monday');
    expect(windowsLimitations({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 2, days: [1], repetition: null })).toEqual([]);
    expect(windowsLimitations({ kind: 'weekly', start: start(2026, 11, 14), weeksInterval: 1, days: [0], repetition: null })).toEqual([]);
    expect(windowsLimitations({ kind: 'monthly', start: start(2026, 11, 14), months: [1], days: [30], lastDay: false, repetition: null }).join(' ')).toContain('day 30');
  });
});
