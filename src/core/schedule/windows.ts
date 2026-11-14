/**
 * Windows Task Scheduler calendar triggers: one-time, daily, weekly, monthly (days of the month or
 * the last day) and monthly by weekday (first to fourth, or last), each with an optional
 * repetition. These are structured triggers, not text, so this model validates fields instead of
 * parsing an expression.
 *
 * Next runs follow the trigger documentation: a daily trigger runs every N days from its start
 * date, a weekly trigger every N weeks on the chosen days, monthly triggers in the chosen months;
 * a repetition runs every interval from each trigger time while the elapsed time is less than the
 * duration. Times are local wall times of the computer.
 *
 * What Microsoft does not document is not predicted: how DST changes affect a trigger, which day
 * starts a week for "every N weeks", and what a day 29 to 31 trigger does in shorter months are
 * reported as limitations.
 *
 * NetForge limits repetition durations to one day for recurring triggers (so repetitions never
 * overlap the next trigger) and allows "indefinitely" only for one-time triggers.
 */
import { ok, type Result } from '../result';
import { MONTH_NAMES, WEEKDAY_NAMES, civilFromDays, daysFromCivil, daysInMonth, formatClock, formatDate, joinList, lastWeekday, nthWeekday, weekday } from './calendar';
import { scheduleFail, type DstPolicy } from './model';
import { collectRuns, SEARCH_YEARS, type NextRuns, type SearchOptions, DEFAULT_RUN_COUNT } from './search';
import { ZoneTimeline } from './zone-timeline';
import { utcFromWall, wallFromUtc } from '../time/zones';

export interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface Repetition {
  /** 1 minute to 31 days (Task Scheduler's PT1M to P31D). */
  readonly intervalMinutes: number;
  /** null repeats indefinitely (one-time triggers only in NetForge). */
  readonly durationMinutes: number | null;
}

export type WeekOfMonth = 1 | 2 | 3 | 4 | 'last';

export type WindowsTrigger =
  | { readonly kind: 'once'; readonly start: LocalDateTime; readonly repetition: Repetition | null }
  | { readonly kind: 'daily'; readonly start: LocalDateTime; readonly daysInterval: number; readonly repetition: Repetition | null }
  | { readonly kind: 'weekly'; readonly start: LocalDateTime; readonly weeksInterval: number; readonly days: readonly number[]; readonly repetition: Repetition | null }
  | { readonly kind: 'monthly'; readonly start: LocalDateTime; readonly months: readonly number[]; readonly days: readonly number[]; readonly lastDay: boolean; readonly repetition: Repetition | null }
  | { readonly kind: 'monthly-dow'; readonly start: LocalDateTime; readonly months: readonly number[]; readonly weeks: readonly WeekOfMonth[]; readonly days: readonly number[]; readonly repetition: Repetition | null };

export type WindowsErrorCode = 'start' | 'interval' | 'days' | 'months' | 'weeks' | 'repetition';

export const MAX_DAYS_INTERVAL = 365;
export const MAX_WEEKS_INTERVAL = 52;
export const MAX_REPETITION_MINUTES = 31 * 24 * 60;
export const MAX_RECURRING_DURATION_MINUTES = 24 * 60;

export function validateWindowsTrigger(t: WindowsTrigger): Result<WindowsTrigger, WindowsErrorCode> {
  const s = t.start;
  if (!Number.isInteger(s.year) || s.year < 1 || s.year > 9999 || s.month < 1 || s.month > 12 || s.day < 1 || s.day > daysInMonth(s.year, s.month)
    || s.hour < 0 || s.hour > 23 || s.minute < 0 || s.minute > 59 || s.second < 0 || s.second > 59) {
    return scheduleFail('start', 'The start date and time are not a valid local date and time.');
  }
  if (t.kind === 'daily' && (!Number.isInteger(t.daysInterval) || t.daysInterval < 1 || t.daysInterval > MAX_DAYS_INTERVAL)) return scheduleFail('interval', `Repeat every 1 to ${MAX_DAYS_INTERVAL} days.`);
  if (t.kind === 'weekly') {
    if (!Number.isInteger(t.weeksInterval) || t.weeksInterval < 1 || t.weeksInterval > MAX_WEEKS_INTERVAL) return scheduleFail('interval', `Repeat every 1 to ${MAX_WEEKS_INTERVAL} weeks.`);
    if (t.days.length === 0 || t.days.some(d => d < 0 || d > 6)) return scheduleFail('days', 'Choose at least one day of the week.');
  }
  if (t.kind === 'monthly' || t.kind === 'monthly-dow') {
    if (t.months.length === 0 || t.months.some(m => m < 1 || m > 12)) return scheduleFail('months', 'Choose at least one month.');
  }
  if (t.kind === 'monthly' && ((t.days.length === 0 && !t.lastDay) || t.days.some(d => d < 1 || d > 31))) return scheduleFail('days', 'Choose at least one day of the month (1 to 31) or the last day.');
  if (t.kind === 'monthly-dow') {
    if (t.weeks.length === 0) return scheduleFail('weeks', 'Choose at least one week of the month.');
    if (t.days.length === 0 || t.days.some(d => d < 0 || d > 6)) return scheduleFail('days', 'Choose at least one day of the week.');
  }
  const r = t.repetition;
  if (r) {
    if (!Number.isInteger(r.intervalMinutes) || r.intervalMinutes < 1 || r.intervalMinutes > MAX_REPETITION_MINUTES) return scheduleFail('repetition', 'A repetition interval is 1 minute to 31 days.');
    if (r.durationMinutes === null) {
      if (t.kind !== 'once') return scheduleFail('repetition', 'NetForge repeats indefinitely only for one-time triggers; give recurring triggers a duration of at most one day.');
    } else {
      if (!Number.isInteger(r.durationMinutes) || r.durationMinutes < r.intervalMinutes) return scheduleFail('repetition', 'The repetition duration must be at least the interval.');
      if (t.kind !== 'once' && r.durationMinutes > MAX_RECURRING_DURATION_MINUTES) return scheduleFail('repetition', 'NetForge models repetition durations of at most one day for recurring triggers, so repetitions never overlap the next trigger.');
    }
  }
  return ok(t);
}

const WEEK_WORDS: Readonly<Record<string, string>> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', last: 'last' };

function span(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** A description in the spirit of Task Scheduler's own trigger summary. */
export function describeWindowsTrigger(t: WindowsTrigger): string {
  const s = t.start;
  const at = formatClock(s.hour, s.minute, s.second === 0 ? undefined : s.second);
  const from = formatDate(s.year, s.month, s.day);
  const months = (list: readonly number[]) => (list.length === 12 ? 'every month' : joinList(list.map(m => MONTH_NAMES[m - 1])));
  let text: string;
  switch (t.kind) {
    case 'once': text = `One time at ${at} on ${from}`; break;
    case 'daily': text = `At ${at} every ${t.daysInterval === 1 ? 'day' : `${t.daysInterval} days`}, starting ${from}`; break;
    case 'weekly': text = `At ${at} every ${joinList(t.days.map(d => WEEKDAY_NAMES[d]))} of every ${t.weeksInterval === 1 ? 'week' : `${t.weeksInterval} weeks`}, starting ${from}`; break;
    case 'monthly': {
      const days = [...t.days.map(String), ...(t.lastDay ? ['the last day'] : [])];
      text = `At ${at} on ${t.days.length === 0 ? 'the last day' : `day ${joinList(days)}`} of ${months(t.months)}, starting ${from}`;
      break;
    }
    case 'monthly-dow':
      text = `At ${at} on the ${joinList(t.weeks.map(w => WEEK_WORDS[String(w)]))} ${joinList(t.days.map(d => WEEKDAY_NAMES[d]))} of ${months(t.months)}, starting ${from}`;
      break;
  }
  const r = t.repetition;
  if (r) text += `. After triggered, repeat every ${span(r.intervalMinutes)} ${r.durationMinutes === null ? 'indefinitely' : `for a duration of ${span(r.durationMinutes)}`}`;
  return `${text}.`;
}

/** Things Microsoft does not document about this trigger, which NetForge therefore cannot predict. */
export function windowsLimitations(t: WindowsTrigger): string[] {
  const out: string[] = [];
  if (t.kind === 'weekly' && t.weeksInterval > 1 && t.days.includes(0)) {
    out.push('Task Scheduler does not document whether its weeks start on Sunday or Monday. NetForge counts weeks from the Sunday on or before the start date, so Sunday runs of an every-N-weeks trigger may fall a week differently.');
  }
  if (t.kind === 'monthly' && t.days.some(d => d >= 29)) {
    out.push(`Task Scheduler does not document what a monthly trigger on day ${Math.max(...t.days)} does in months without that day. NetForge skips those months, as cron and systemd do.`);
  }
  return out;
}

const DAY_MS = 86_400_000;

function startWall(s: LocalDateTime): number {
  return utcFromWall({ ...s, millisecond: 0 });
}

/** Sunday-based week number of a day number (days since 1970-01-01, a Thursday). */
function weekIndex(dayNumber: number): number {
  return Math.floor((dayNumber + 4) / 7);
}

function dayTriggers(t: WindowsTrigger, startDay: number): (dayNumber: number) => boolean {
  switch (t.kind) {
    case 'once': return n => n === startDay;
    case 'daily': return n => n >= startDay && (n - startDay) % t.daysInterval === 0;
    case 'weekly': {
      const days = new Set(t.days);
      const firstWeek = weekIndex(startDay);
      return n => {
        if (n < startDay) return false;
        const c = civilFromDays(n);
        return days.has(weekday(c.year, c.month, c.day)) && (weekIndex(n) - firstWeek) % t.weeksInterval === 0;
      };
    }
    case 'monthly': {
      const months = new Set(t.months);
      const days = new Set(t.days);
      return n => {
        if (n < startDay) return false;
        const c = civilFromDays(n);
        if (!months.has(c.month)) return false;
        return days.has(c.day) || (t.lastDay && c.day === daysInMonth(c.year, c.month));
      };
    }
    case 'monthly-dow': {
      const months = new Set(t.months);
      const days = new Set(t.days);
      return n => {
        if (n < startDay) return false;
        const c = civilFromDays(n);
        if (!months.has(c.month)) return false;
        const w = weekday(c.year, c.month, c.day);
        if (!days.has(w)) return false;
        return t.weeks.some(k => (k === 'last' ? lastWeekday(c.year, c.month, w) === c.day : nthWeekday(c.year, c.month, w, k) === c.day));
      };
    }
  }
}

/** Trigger wall times at or after `fromWall`, in increasing order, through `lastYear`. */
export function* windowsWalls(t: WindowsTrigger, fromWall: number, lastYear: number): Generator<number> {
  const s = t.start;
  const startDay = daysFromCivil(s.year, s.month, s.day);
  const timeOfDay = startWall(s) - startDay * DAY_MS;
  const rep = t.repetition;
  const steps = (base: number): Generator<number> => (function* () {
    if (!rep) { if (base >= fromWall) yield base; return; }
    const interval = rep.intervalMinutes * 60_000;
    const duration = rep.durationMinutes === null ? Infinity : rep.durationMinutes * 60_000;
    let j = base >= fromWall ? 0 : Math.ceil((fromWall - base) / interval);
    for (; j * interval < duration; j++) yield base + j * interval;
  })();
  if (t.kind === 'once') {
    yield* steps(startWall(s));
    return;
  }
  const matches = dayTriggers(t, startDay);
  // A repetition that started the day before can still be running.
  let n = Math.max(startDay, Math.floor(fromWall / DAY_MS) - 1);
  const lastDay = daysFromCivil(lastYear, 12, 31);
  for (; n <= lastDay; n++) {
    if (t.kind === 'daily' && (n - startDay) % t.daysInterval !== 0) {
      n += t.daysInterval - ((n - startDay) % t.daysInterval) - 1;
      continue;
    }
    if (!matches(n)) continue;
    yield* steps(n * DAY_MS + timeOfDay);
  }
}

export const WINDOWS_DST_POLICY: DstPolicy = {
  nonexistent: 'uncertain',
  repeatedFirst: 'uncertain',
  repeatedSecond: 'uncertain',
  basis: 'Microsoft does not document how Task Scheduler handles DST changes',
  nonexistentNote: 'This local time does not exist. Microsoft does not document whether Task Scheduler skips such a run or starts it after the change.',
  repeatedNote: 'This local time happens twice. Microsoft does not document whether Task Scheduler runs it once or twice.',
};

export function nextWindowsRuns(t: WindowsTrigger, zone: string, fromMs: number, options: SearchOptions = {}): NextRuns {
  const count = options.count ?? DEFAULT_RUN_COUNT;
  const timeline = new ZoneTimeline(zone);
  const fromWall = fromMs + timeline.minOffsetNear(fromMs);
  const lastYear = Math.min(9999, wallFromUtc(fromWall).year + SEARCH_YEARS);
  const r = collectRuns(windowsWalls(t, fromWall, lastYear), zone, fromMs, count, WINDOWS_DST_POLICY, timeline);
  let stop: NextRuns['stop'] = null;
  if (r.found < count) {
    if (!r.exhausted) stop = { kind: 'limit', examined: r.examined };
    else if (t.kind === 'once') stop = { kind: 'ended' };
    else stop = r.found === 0 ? { kind: 'never' } : { kind: 'horizon', years: SEARCH_YEARS };
  }
  return { zone, fromMs, rows: r.rows, found: r.found, stop };
}
