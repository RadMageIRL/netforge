/**
 * Schedule Builder: a schedule chosen from simple options, in one time zone, translated into each
 * scheduler's format. Every translation is labeled:
 *
 * - exact: the format runs at the same local times as the chosen schedule (outside DST changes,
 *   which every scheduler handles in its own way; each output carries its own DST note).
 * - approximate: it runs, but at times that differ; the differences are listed.
 * - unsupported: the format cannot express the schedule; the reason is given and no text is produced.
 *
 * The chosen schedule has a precise meaning of its own (intendedPattern), so labels can be tested by
 * comparing next runs.
 */
import { WEEKDAY_NAMES, daysFromCivil, daysInMonth, formatClock, formatDate, joinList, lastWeekday, nthWeekday, weekday } from './calendar';
import { EMPTY_DETAILS, powershellCommands, schtasksCommand, timerUnit, type DateFormat, type GeneratedText, type TaskDetails } from './commands';
import { cronDstPolicy, cronPattern, parseCron } from './cron';
import type { CalendarPattern, DstPolicy } from './model';
import { QUARTZ_DST_POLICY, parseQuartz, quartzPattern } from './quartz';
import { nextPatternRuns, type NextRuns, type SearchOptions } from './search';
import { SYSTEMD_DST_POLICY, formatWeekdays, parseSystemd, systemdPattern } from './systemd';
import { describeWindowsTrigger, nextWindowsRuns, validateWindowsTrigger, WINDOWS_DST_POLICY, windowsLimitations, type WeekOfMonth, type WindowsTrigger } from './windows';
import { isValidTimeZone, wallInZone } from '../time/zones';

export type Frequency = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'days' | 'monthly';
export type MonthlyKind = 'day' | 'last-day' | 'nth';
export type Nth = '1' | '2' | '3' | '4' | 'last';

export const FREQUENCY_LABEL: Readonly<Record<Frequency, string>> = {
  minutes: 'Every N minutes', hourly: 'Hourly', daily: 'Daily', weekdays: 'Weekdays (Monday to Friday)',
  weekly: 'Weekly', days: 'Specific weekdays', monthly: 'Monthly',
};

/** The builder's inputs as the form holds them (text, so half-typed values can be reported). */
export interface BuilderInput {
  readonly frequency: Frequency;
  readonly everyMinutes: string;
  readonly everyHours: string;
  /** Minute past the hour, for hourly schedules. */
  readonly minute: string;
  /** HH:MM, for daily and longer schedules. */
  readonly time: string;
  /** 0 (Sunday) to 6, for weekly. */
  readonly weekday: string;
  readonly everyWeeks: string;
  /** For "specific weekdays". */
  readonly weekdays: readonly number[];
  readonly monthlyKind: MonthlyKind;
  readonly monthDay: string;
  readonly nth: Nth;
  readonly nthWeekday: string;
  readonly zone: string;
  /** YYYY-MM-DD: the Windows start boundary, and the first week of an every-N-weeks schedule. */
  readonly startDate: string;
}

export interface BuilderSpec {
  readonly frequency: Frequency;
  readonly everyMinutes: number;
  readonly everyHours: number;
  readonly minute: number;
  readonly hour: number;
  readonly timeMinute: number;
  readonly weekday: number;
  readonly everyWeeks: number;
  readonly weekdays: readonly number[];
  readonly monthly: { readonly kind: 'day'; readonly day: number } | { readonly kind: 'last-day' } | { readonly kind: 'nth'; readonly nth: WeekOfMonth; readonly weekday: number };
  readonly zone: string;
  readonly start: { readonly year: number; readonly month: number; readonly day: number };
}

export interface BuilderIssue {
  readonly field: keyof BuilderInput;
  readonly message: string;
}

function int(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^[0-9]{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

export function validateBuilder(input: BuilderInput): { spec: BuilderSpec | null; issues: BuilderIssue[]; warnings: string[] } {
  const issues: BuilderIssue[] = [];
  const warnings: string[] = [];
  const f = input.frequency;
  const need = (field: keyof BuilderInput, value: number | null, message: string): number => {
    if (value === null) issues.push({ field, message });
    return value ?? 0;
  };
  const everyMinutes = f === 'minutes' ? need('everyMinutes', int(input.everyMinutes, 1, 59), 'Enter a whole number of minutes from 1 to 59.') : 15;
  const everyHours = f === 'hourly' ? need('everyHours', int(input.everyHours, 1, 23), 'Enter a whole number of hours from 1 to 23.') : 1;
  const minute = f === 'hourly' ? need('minute', int(input.minute, 0, 59), 'Enter the minute past the hour, 0 to 59.') : 0;
  let hour = 0;
  let timeMinute = 0;
  if (f !== 'minutes' && f !== 'hourly') {
    const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(input.time.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) issues.push({ field: 'time', message: 'Enter a time of day as HH:MM, 00:00 to 23:59.' });
    else { hour = Number(m[1]); timeMinute = Number(m[2]); }
  }
  const weekday = f === 'weekly' ? need('weekday', int(input.weekday, 0, 6), 'Choose a day of the week.') : 1;
  const everyWeeks = f === 'weekly' ? need('everyWeeks', int(input.everyWeeks, 1, 52), 'Enter a number of weeks from 1 to 52.') : 1;
  const weekdays = [...new Set(input.weekdays)].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (f === 'days' && weekdays.length === 0) issues.push({ field: 'weekdays', message: 'Choose at least one day of the week.' });
  let monthly: BuilderSpec['monthly'] = { kind: 'day', day: 1 };
  if (f === 'monthly') {
    if (input.monthlyKind === 'day') monthly = { kind: 'day', day: need('monthDay', int(input.monthDay, 1, 31), 'Enter a day of the month from 1 to 31.') };
    else if (input.monthlyKind === 'last-day') monthly = { kind: 'last-day' };
    else monthly = { kind: 'nth', nth: input.nth === 'last' ? 'last' : (Number(input.nth) as 1 | 2 | 3 | 4), weekday: need('nthWeekday', int(input.nthWeekday, 0, 6), 'Choose a day of the week.') };
  }
  const zone = input.zone.trim();
  if (!isValidTimeZone(zone)) issues.push({ field: 'zone', message: 'Choose a time zone.' });
  const d = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(input.startDate.trim());
  let start = { year: 2026, month: 1, day: 1 };
  if (!d || Number(d[2]) < 1 || Number(d[2]) > 12 || Number(d[3]) < 1 || Number(d[3]) > daysInMonth(Number(d[1]), Number(d[2])) || Number(d[1]) < 1970 || Number(d[1]) > 2099) {
    issues.push({ field: 'startDate', message: 'Enter the start date as YYYY-MM-DD, between 1970 and 2099.' });
  } else start = { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) };
  if (issues.length > 0) return { spec: null, issues, warnings };

  if (f === 'minutes' && 60 % everyMinutes !== 0) {
    const last = Math.floor(59 / everyMinutes) * everyMinutes;
    warnings.push(`Every ${everyMinutes} minutes restarts at minute 0 each hour: after minute ${last} the next run is ${60 - last} minutes later. Divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30) give an even interval.`);
  }
  if (f === 'hourly' && 24 % everyHours !== 0) {
    const last = Math.floor(23 / everyHours) * everyHours;
    warnings.push(`Every ${everyHours} hours restarts at midnight: after ${formatClock(last, minute)} the next run is at ${formatClock(0, minute)}, ${24 - last} hours later.`);
  }
  if (f === 'monthly' && monthly.kind === 'day' && monthly.day >= 29) {
    warnings.push(`Day ${monthly.day} does not exist in every month; those months have no run. Choose "last day" to run at the end of every month.`);
  }
  return { spec: { frequency: f, everyMinutes, everyHours, minute, hour, timeMinute, weekday, everyWeeks, weekdays, monthly, zone, start }, issues, warnings };
}

const NTH_WORD: Readonly<Record<string, string>> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', last: 'last' };

export function describeSpec(s: BuilderSpec): string {
  const at = formatClock(s.hour, s.timeMinute);
  let text: string;
  switch (s.frequency) {
    case 'minutes': text = s.everyMinutes === 1 ? 'Every minute' : `Every ${s.everyMinutes} minutes, starting at minute 0 of each hour`; break;
    case 'hourly': text = s.everyHours === 1 ? `Every hour at minute ${s.minute}` : `Every ${s.everyHours} hours at minute ${s.minute}, starting at ${formatClock(0, s.minute)}`; break;
    case 'daily': text = `Every day at ${at}`; break;
    case 'weekdays': text = `Monday to Friday at ${at}`; break;
    case 'weekly': text = s.everyWeeks === 1 ? `Every ${WEEKDAY_NAMES[s.weekday]} at ${at}` : `Every ${s.everyWeeks} weeks on ${WEEKDAY_NAMES[s.weekday]} at ${at}, counting from the week of ${formatDate(s.start.year, s.start.month, s.start.day)}`; break;
    case 'days': text = `On ${joinList(s.weekdays.map(d => WEEKDAY_NAMES[d]))} at ${at}`; break;
    case 'monthly':
      text = s.monthly.kind === 'day' ? `On day ${s.monthly.day} of every month at ${at}`
        : s.monthly.kind === 'last-day' ? `On the last day of every month at ${at}`
          : `On the ${NTH_WORD[String(s.monthly.nth)]} ${WEEKDAY_NAMES[s.monthly.weekday]} of every month at ${at}`;
      break;
  }
  return `${text}, ${s.zone} time.`;
}

const startDayNumber = (s: BuilderSpec) => daysFromCivil(s.start.year, s.start.month, s.start.day);
/** Weeks start on Sunday; 1970-01-01 was a Thursday. */
const weekIndex = (dayNumber: number) => Math.floor((dayNumber + 4) / 7);

/** The chosen schedule's own meaning, as a calendar pattern. */
export function intendedPattern(s: BuilderSpec): CalendarPattern {
  const all = (n: number) => Array.from({ length: n }, (_, i) => i);
  const months = new Set(all(12).map(m => m + 1));
  const base = { seconds: [0], months, lastYear: 9999, yearMatches: () => true };
  switch (s.frequency) {
    case 'minutes': return { ...base, minutes: all(60).filter(m => m % s.everyMinutes === 0), hours: all(24), dayMatches: () => true };
    case 'hourly': return { ...base, minutes: [s.minute], hours: all(24).filter(h => h % s.everyHours === 0), dayMatches: () => true };
    default: break;
  }
  const time = { minutes: [s.timeMinute], hours: [s.hour] };
  switch (s.frequency) {
    case 'daily': return { ...base, ...time, dayMatches: () => true };
    case 'weekdays': return { ...base, ...time, dayMatches: (y, m, d) => { const w = weekday(y, m, d); return w >= 1 && w <= 5; } };
    case 'days': { const set = new Set(s.weekdays); return { ...base, ...time, dayMatches: (y, m, d) => set.has(weekday(y, m, d)) }; }
    case 'weekly': {
      const first = startDayNumber(s);
      const firstWeek = weekIndex(first);
      return {
        ...base, ...time,
        dayMatches: (y, m, d) => {
          if (weekday(y, m, d) !== s.weekday) return false;
          if (s.everyWeeks === 1) return true;
          const n = daysFromCivil(y, m, d);
          return n >= first && (weekIndex(n) - firstWeek) % s.everyWeeks === 0;
        },
      };
    }
    default: {
      const mo = s.monthly;
      if (mo.kind === 'day') return { ...base, ...time, dayMatches: (_y, _m, d) => d === mo.day };
      if (mo.kind === 'last-day') return { ...base, ...time, dayMatches: (y, m, d) => d === daysInMonth(y, m) };
      return { ...base, ...time, dayMatches: (y, m, d) => d === (mo.nth === 'last' ? lastWeekday(y, m, mo.weekday) : nthWeekday(y, m, mo.weekday, mo.nth)) };
    }
  }
}

export const BUILDER_DST_POLICY: DstPolicy = {
  nonexistent: 'uncertain',
  repeatedFirst: 'runs',
  repeatedSecond: 'uncertain',
  basis: 'each scheduler handles DST changes in its own way',
  nonexistentNote: 'This local time does not exist on this date. Each scheduler handles it differently: see the DST note of each output.',
  repeatedNote: 'This local time happens twice on this date. Each scheduler handles it differently: see the DST note of each output.',
};

export function intendedRuns(s: BuilderSpec, fromMs: number, options: SearchOptions = {}): NextRuns {
  return nextPatternRuns(intendedPattern(s), s.zone, fromMs, BUILDER_DST_POLICY, options);
}

export type Fidelity = 'exact' | 'approximate' | 'unsupported';
export type TargetId = 'cron' | 'quartz' | 'systemd' | 'powershell' | 'schtasks';

export const TARGET_LABEL: Readonly<Record<TargetId, string>> = {
  cron: 'Standard cron', quartz: 'Quartz cron', systemd: 'systemd calendar (OnCalendar=)',
  powershell: 'Windows: PowerShell (ScheduledTasks)', schtasks: 'Windows: schtasks.exe',
};

export interface Translation {
  readonly target: TargetId;
  readonly label: string;
  readonly fidelity: Fidelity;
  /** The expression or commands; '' when unsupported. */
  readonly text: string;
  /** Approximate: how the runs differ. Unsupported: why it cannot be expressed. */
  readonly differences: readonly string[];
  /** What must hold for the output to mean the chosen schedule (time zone, host settings). */
  readonly conditions: readonly string[];
  readonly notes: readonly string[];
  /** Placeholders remain that the person must fill in. */
  readonly template: boolean;
  readonly dst: DstPolicy;
}

export interface BuilderResult {
  readonly spec: BuilderSpec;
  readonly description: string;
  readonly translations: readonly Translation[];
  readonly windowsTrigger: WindowsTrigger;
  /** A .timer preview when the systemd output is supported. */
  readonly timerUnit: GeneratedText | null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const QUARTZ_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const SYSTEMD_NTH_DAYS: Readonly<Record<string, string>> = { 1: '01..07', 2: '08..14', 3: '15..21', 4: '22..28' };

function unsupported(target: TargetId, reason: string, dst: DstPolicy, notes: string[] = []): Translation {
  return { target, label: TARGET_LABEL[target], fidelity: 'unsupported', text: '', differences: [reason], conditions: [], notes, template: false, dst };
}

function cronTranslation(s: BuilderSpec): Translation {
  const t = `${s.timeMinute} ${s.hour}`;
  let expr: string;
  switch (s.frequency) {
    case 'minutes': expr = s.everyMinutes === 1 ? '* * * * *' : `*/${s.everyMinutes} * * * *`; break;
    case 'hourly': expr = `${s.minute} ${s.everyHours === 1 ? '*' : `*/${s.everyHours}`} * * *`; break;
    case 'daily': expr = `${t} * * *`; break;
    case 'weekdays': expr = `${t} * * 1-5`; break;
    case 'weekly':
      if (s.everyWeeks > 1) return unsupported('cron', `Standard cron has no week counter, so it cannot run every ${s.everyWeeks} weeks: "${t} * * ${s.weekday}" runs every week. A common workaround tests the week number inside the command, which NetForge does not generate.`, cronDstPolicy(parseCronOk(`${t} * * ${s.weekday}`)));
      expr = `${t} * * ${s.weekday}`;
      break;
    case 'days': expr = `${t} * * ${s.weekdays.join(',')}`; break;
    default: {
      const mo = s.monthly;
      const policy = cronDstPolicy(parseCronOk(`${t} 1 * *`));
      if (mo.kind === 'last-day') return unsupported('cron', 'Standard cron has no "last day of the month": "28-31" in the day field runs on every one of those days. Quartz (L) and systemd (~01) can express it.', policy);
      if (mo.kind === 'nth') return unsupported('cron', `Standard cron cannot select the ${NTH_WORD[String(mo.nth)]} ${WEEKDAY_NAMES[mo.weekday]}: with both day fields set it runs when EITHER matches, so "${t} 1-7 * ${mo.weekday}" would run on days 1 to 7 and on every ${WEEKDAY_NAMES[mo.weekday]}.`, policy);
      expr = `${t} ${mo.day} * *`;
    }
  }
  const parsed = parseCronOk(expr);
  return {
    target: 'cron', label: TARGET_LABEL.cron, fidelity: 'exact', text: expr, differences: [],
    conditions: [`Cron reads the expression in the cron daemon's time zone. It means ${s.zone} time only if cron runs in ${s.zone} (the system zone, or CRON_TZ=${s.zone} above the line in cronie).`],
    notes: ['Add the command after the five fields in a crontab line.'], template: false, dst: cronDstPolicy(parsed),
  };
}

function parseCronOk(expr: string) {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(`builder produced invalid cron ${expr}: ${r.error.message}`);
  return r.value;
}

function quartzTranslation(s: BuilderSpec): Translation {
  const t = `0 ${s.timeMinute} ${s.hour}`;
  let expr: string;
  switch (s.frequency) {
    case 'minutes': expr = s.everyMinutes === 1 ? '0 * * * * ?' : `0 0/${s.everyMinutes} * * * ?`; break;
    case 'hourly': expr = `0 ${s.minute} ${s.everyHours === 1 ? '*' : `0/${s.everyHours}`} * * ?`; break;
    case 'daily': expr = `${t} * * ?`; break;
    case 'weekdays': expr = `${t} ? * MON-FRI`; break;
    case 'weekly':
      if (s.everyWeeks > 1) return unsupported('quartz', `Quartz cron expressions have no week counter, so they cannot run every ${s.everyWeeks} weeks. A Quartz CalendarIntervalTrigger can (an interval of ${s.everyWeeks} weeks), but it is not a cron expression.`, QUARTZ_DST_POLICY);
      expr = `${t} ? * ${QUARTZ_DAYS[s.weekday]}`;
      break;
    case 'days': expr = `${t} ? * ${s.weekdays.map(d => QUARTZ_DAYS[d]).join(',')}`; break;
    default: {
      const mo = s.monthly;
      expr = mo.kind === 'day' ? `${t} ${mo.day} * ?` : mo.kind === 'last-day' ? `${t} L * ?` : `${t} ? * ${mo.weekday + 1}${mo.nth === 'last' ? 'L' : `#${mo.nth}`}`;
    }
  }
  const check = parseQuartz(expr);
  if (!check.ok) throw new Error(`builder produced invalid Quartz ${expr}: ${check.error.message}`);
  return {
    target: 'quartz', label: TARGET_LABEL.quartz, fidelity: 'exact', text: expr, differences: [],
    conditions: [`Quartz takes the time zone from the trigger: build it with CronScheduleBuilder.cronSchedule(...).inTimeZone(TimeZone.getTimeZone("${s.zone}")), or it uses the JVM's default zone.`],
    notes: [], template: false, dst: QUARTZ_DST_POLICY,
  };
}

function systemdTranslation(s: BuilderSpec): Translation {
  const t = `${pad2(s.hour)}:${pad2(s.timeMinute)}:00`;
  let expr: string;
  switch (s.frequency) {
    case 'minutes': expr = s.everyMinutes === 1 ? '*-*-* *:*:00' : `*-*-* *:00/${s.everyMinutes}:00`; break;
    case 'hourly': expr = s.everyHours === 1 ? `*-*-* *:${pad2(s.minute)}:00` : `*-*-* 00/${s.everyHours}:${pad2(s.minute)}:00`; break;
    case 'daily': expr = `*-*-* ${t}`; break;
    case 'weekdays': expr = `Mon..Fri *-*-* ${t}`; break;
    case 'weekly':
      if (s.everyWeeks > 1) return unsupported('systemd', `Calendar expressions have no week counter, so OnCalendar= cannot run every ${s.everyWeeks} weeks. OnUnitActiveSec=${s.everyWeeks}w repeats ${s.everyWeeks} weeks after the last activation, but that is a monotonic timer, measured from the last run, not from the calendar.`, SYSTEMD_DST_POLICY);
      expr = `${formatWeekdays(1 << ((s.weekday + 6) % 7))} *-*-* ${t}`;
      break;
    case 'days': expr = `${formatWeekdays(s.weekdays.reduce((bits, d) => bits | (1 << ((d + 6) % 7)), 0))} *-*-* ${t}`; break;
    default: {
      const mo = s.monthly;
      const day = formatWeekdays(1 << (((mo.kind === 'nth' ? mo.weekday : 0) + 6) % 7));
      expr = mo.kind === 'day' ? `*-*-${pad2(mo.day)} ${t}` : mo.kind === 'last-day' ? `*-*~01 ${t}` : mo.nth === 'last' ? `${day} *-*~07/1 ${t}` : `${day} *-*-${SYSTEMD_NTH_DAYS[String(mo.nth)]} ${t}`;
    }
  }
  expr += ` ${s.zone === 'UTC' ? 'UTC' : s.zone}`;
  const check = parseSystemd(expr);
  if (!check.ok) throw new Error(`builder produced invalid systemd ${expr}: ${check.error.message}`);
  return {
    target: 'systemd', label: TARGET_LABEL.systemd, fidelity: 'exact', text: check.value.normalized, differences: [],
    conditions: [`The expression names ${s.zone} itself. Time zone names in OnCalendar= need a systemd release that supports them (systemd 257 does); without one, drop the zone and run the host in ${s.zone}.`],
    notes: ['This is the OnCalendar= value of a .timer unit; see the timer unit preview.'], template: false, dst: SYSTEMD_DST_POLICY,
  };
}

export function windowsTrigger(s: BuilderSpec): WindowsTrigger {
  const start = (hour: number, minute: number) => ({ ...s.start, hour, minute, second: 0 });
  const day = { repetition: null };
  switch (s.frequency) {
    case 'minutes': return { kind: 'daily', start: start(0, 0), daysInterval: 1, repetition: { intervalMinutes: s.everyMinutes, durationMinutes: 1440 } };
    case 'hourly': return { kind: 'daily', start: start(0, s.minute), daysInterval: 1, repetition: { intervalMinutes: s.everyHours * 60, durationMinutes: 1440 } };
    case 'daily': return { kind: 'daily', start: start(s.hour, s.timeMinute), daysInterval: 1, ...day };
    case 'weekdays': return { kind: 'weekly', start: start(s.hour, s.timeMinute), weeksInterval: 1, days: [1, 2, 3, 4, 5], ...day };
    case 'weekly': return { kind: 'weekly', start: start(s.hour, s.timeMinute), weeksInterval: s.everyWeeks, days: [s.weekday], ...day };
    case 'days': return { kind: 'weekly', start: start(s.hour, s.timeMinute), weeksInterval: 1, days: s.weekdays, ...day };
    default: {
      const mo = s.monthly;
      const months = Array.from({ length: 12 }, (_, i) => i + 1);
      if (mo.kind === 'nth') return { kind: 'monthly-dow', start: start(s.hour, s.timeMinute), months, weeks: [mo.nth], days: [mo.weekday], ...day };
      return { kind: 'monthly', start: start(s.hour, s.timeMinute), months, days: mo.kind === 'day' ? [mo.day] : [], lastDay: mo.kind === 'last-day', ...day };
    }
  }
}

/** How the Windows trigger's runs differ from the chosen schedule, if they do. */
function windowsDifferences(s: BuilderSpec, t: WindowsTrigger): string[] {
  const out: string[] = [];
  if (s.frequency === 'minutes' && 60 % s.everyMinutes !== 0) {
    const n = s.everyMinutes;
    const next = Math.floor(59 / n) * n + n;
    out.push(`Task Scheduler repeats every ${n} minutes through the whole day from 00:00 (... ${formatClock(0, next - n)}, ${formatClock(Math.floor(next / 60), next % 60)}, ...), while the schedule restarts at minute 0 of every hour, so the minutes differ after the first hour.`);
  }
  out.push(...windowsLimitations(t));
  return out;
}

function windowsTranslations(s: BuilderSpec, details: TaskDetails, dateFormat: DateFormat): Translation[] {
  const t = windowsTrigger(s);
  const valid = validateWindowsTrigger(t);
  if (!valid.ok) throw new Error(`builder produced an invalid Windows trigger: ${valid.error.message}`);
  const differences = windowsDifferences(s, t);
  const fidelity: Fidelity = differences.length > 0 ? 'approximate' : 'exact';
  const conditions = [`Task Scheduler uses the computer's local time zone. This matches ${s.zone} time only on a computer set to that zone.`];
  const ps = powershellCommands(t, details);
  const sch = schtasksCommand(t, details, dateFormat);
  const make = (target: TargetId, g: GeneratedText): Translation => g.supported
    ? { target, label: TARGET_LABEL[target], fidelity, text: g.text, differences, conditions, notes: [`Trigger: ${describeWindowsTrigger(t)}`, ...g.reasons, ...g.notes], template: g.template, dst: WINDOWS_DST_POLICY }
    : unsupported(target, g.reasons.join(' '), WINDOWS_DST_POLICY);
  return [make('powershell', ps), make('schtasks', sch)];
}

export function buildSchedule(s: BuilderSpec, details: TaskDetails = EMPTY_DETAILS, dateFormat: DateFormat = 'MDY'): BuilderResult {
  const sd = systemdTranslation(s);
  return {
    spec: s,
    description: describeSpec(s),
    translations: [cronTranslation(s), quartzTranslation(s), sd, ...windowsTranslations(s, details, dateFormat)],
    windowsTrigger: windowsTrigger(s),
    timerUnit: sd.fidelity === 'unsupported' ? null : timerUnit(sd.text, details.name),
  };
}

/** The runs of one output under its own scheduler's rules (parsing the generated text again). */
export function translationRuns(r: BuilderResult, target: TargetId, fromMs: number, options: SearchOptions = {}): NextRuns | null {
  const tr = r.translations.find(x => x.target === target);
  if (!tr || tr.fidelity === 'unsupported') return null;
  const zone = r.spec.zone;
  switch (target) {
    case 'cron': { const p = parseCron(tr.text); return p.ok ? nextPatternRuns(cronPattern(p.value), zone, fromMs, cronDstPolicy(p.value), options) : null; }
    case 'quartz': { const p = parseQuartz(tr.text); return p.ok ? nextPatternRuns(quartzPattern(p.value), zone, fromMs, QUARTZ_DST_POLICY, options) : null; }
    case 'systemd': { const p = parseSystemd(tr.text); return p.ok ? nextPatternRuns(systemdPattern(p.value), p.value.zone ?? zone, fromMs, SYSTEMD_DST_POLICY, options) : null; }
    default: return nextWindowsRuns(r.windowsTrigger, zone, fromMs, options);
  }
}

/** Today's date in `zone`, as YYYY-MM-DD, for the start date default. */
export function todayIn(zone: string, nowMs: number): string {
  const w = wallInZone(nowMs, zone);
  return formatDate(w.year, w.month, w.day);
}
