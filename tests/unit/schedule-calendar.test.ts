/**
 * Calendar arithmetic for schedules, against the JavaScript Date object (an independent
 * implementation of the proleptic Gregorian calendar) and hand-worked dates.
 */
import { describe, expect, it } from 'vitest';
import {
  civilFromDays, daysFromCivil, daysInMonth, isLeapYear, joinList, lastBusinessDay, lastWeekday, nearestWeekday, nthWeekday, ordinal, weekday,
} from '../../src/core/schedule/calendar';

const DAY = 86_400_000;

/** Date-based reference: the UTC date `n` days after 1970-01-01. */
function refDate(n: number): { year: number; month: number; day: number; dow: number } {
  const d = new Date(0);
  d.setTime(n * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: d.getUTCDay() };
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('day numbers and weekdays', () => {
  it('match Date for 20,000 random days between years 1 and 9999', () => {
    const rnd = seeded(7);
    const min = daysFromCivil(1, 1, 1);
    const max = daysFromCivil(9999, 12, 31);
    let checked = 0;
    for (let i = 0; i < 20_000; i++) {
      const n = min + Math.floor(rnd() * (max - min + 1));
      const r = refDate(n);
      const c = civilFromDays(n);
      if (c.year !== r.year || c.month !== r.month || c.day !== r.day) throw new Error(`civilFromDays(${n})`);
      if (daysFromCivil(r.year, r.month, r.day) !== n) throw new Error(`daysFromCivil ${r.year}-${r.month}-${r.day}`);
      if (weekday(r.year, r.month, r.day) !== r.dow) throw new Error(`weekday ${r.year}-${r.month}-${r.day}`);
      checked++;
    }
    expect(checked).toBe(20_000);
  });

  it('knows fixed points', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(-1)).toEqual({ year: 1969, month: 12, day: 31 });
    expect(weekday(1970, 1, 1)).toBe(4); // Thursday
    expect(weekday(2026, 11, 14)).toBe(6); // Saturday
    expect(weekday(2000, 2, 29)).toBe(2); // Tuesday
  });
});

describe('leap years and month lengths', () => {
  it('follows the Gregorian century rule', () => {
    expect([1900, 2000, 2024, 2026, 2100, 2400].map(isLeapYear)).toEqual([false, true, true, false, false, true]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => daysInMonth(2026, m))).toEqual([31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });
});

describe('nth and last weekdays', () => {
  it('match a brute-force scan with Date for every month of 2020 to 2035', () => {
    let checked = 0;
    for (let year = 2020; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        const byDow = new Map<number, number[]>();
        for (let d = 1; d <= 31; d++) {
          const date = new Date(Date.UTC(year, month - 1, d));
          if (date.getUTCMonth() !== month - 1) break;
          const list = byDow.get(date.getUTCDay()) ?? [];
          list.push(d);
          byDow.set(date.getUTCDay(), list);
        }
        for (let dow = 0; dow < 7; dow++) {
          const days = byDow.get(dow)!;
          for (let n = 1; n <= 5; n++) expect(nthWeekday(year, month, dow, n)).toBe(days[n - 1] ?? null);
          expect(lastWeekday(year, month, dow)).toBe(days[days.length - 1]);
          checked++;
        }
      }
    }
    expect(checked).toBe(16 * 12 * 7);
  });

  it('finds the last business day', () => {
    expect(lastBusinessDay(2026, 1)).toBe(30); // Jan 31 2026 is a Saturday
    expect(lastBusinessDay(2026, 5)).toBe(29); // May 31 2026 is a Sunday
    expect(lastBusinessDay(2026, 12)).toBe(31); // Thursday
  });
});

describe('Quartz nearest weekday (the CronTrigger documentation examples)', () => {
  it('moves a Saturday to Friday and a Sunday to Monday', () => {
    // 2026-08-15 is a Saturday: 15W fires on Friday the 14th.
    expect(nearestWeekday(2026, 8, 15)).toBe(14);
    // 2026-11-15 is a Sunday: 15W fires on Monday the 16th.
    expect(nearestWeekday(2026, 11, 15)).toBe(16);
    // 2026-12-15 is a Tuesday: 15W fires on the 15th.
    expect(nearestWeekday(2026, 12, 15)).toBe(15);
  });

  it('never jumps over a month boundary', () => {
    // 2026-08-01 is a Saturday: 1W fires on Monday the 3rd, not Friday July 31.
    expect(nearestWeekday(2026, 8, 1)).toBe(3);
    // 2026-05-31 is a Sunday and the last day: it moves back to Friday the 29th.
    expect(nearestWeekday(2026, 5, 31)).toBe(29);
  });
});

describe('wording helpers', () => {
  it('writes ordinals and lists', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st', '101st', '111th']);
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'], 'or')).toBe('a, b or c');
  });
});
