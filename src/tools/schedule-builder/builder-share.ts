/**
 * Schedule Builder settings links: the schedule itself (how often, when, which days), the time
 * zone when one was chosen, and the start date. Only the settings that the chosen frequency uses
 * are written, and a link naming any other is refused, so a link cannot contradict itself. The
 * task or unit name, program, arguments and date format are command content and never included.
 */
import { describeSpec, validateBuilder, type BuilderInput, type Frequency, type MonthlyKind, type Nth } from '../../core/schedule/builder';
import { DEVICE_ZONE_NOTE, oneOf, onlyKeys, zoneName, type ShareOffer } from '../../app/share';

/** The builder's choices, with zone null for "this device". */
export type BuilderShare = Omit<BuilderInput, 'zone'> & { readonly zone: string | null };

const FREQUENCIES = ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'days', 'monthly'] as const;
const MONTHLY = ['day', 'last-day', 'nth'] as const;
const NTHS = ['1', '2', '3', '4', 'last'] as const;
const DAYS = /^[0-6](,[0-6]){0,6}$/;
const SMALL = /^[0-9]{1,2}$/;

/** The defaults the builder starts with, for settings a link does not name. */
export const BUILDER_DEFAULTS: Omit<BuilderShare, 'zone' | 'startDate'> = {
  frequency: 'daily', everyMinutes: '15', everyHours: '1', minute: '0', time: '09:00', weekday: '1', everyWeeks: '1',
  weekdays: [1, 3, 5], monthlyKind: 'day', monthDay: '1', nth: '1', nthWeekday: '1',
};

function keysFor(f: Frequency, monthly: MonthlyKind): string[] {
  const keys = ['freq', 'tz', 'start'];
  if (f === 'minutes') keys.push('every');
  else if (f === 'hourly') keys.push('every', 'minute');
  else keys.push('time');
  if (f === 'weekly') keys.push('day', 'weeks');
  if (f === 'days') keys.push('days');
  if (f === 'monthly') {
    keys.push('monthly');
    if (monthly === 'day') keys.push('mday');
    if (monthly === 'nth') keys.push('nth', 'wday');
  }
  return keys;
}

export function builderOffer(s: BuilderShare, deviceZone: string): ShareOffer {
  const v = validateBuilder({ ...s, zone: s.zone ?? deviceZone });
  if (!v.spec) return { ok: false, reason: 'Fix the highlighted choices to put the schedule in a link.' };
  const f = s.frequency;
  const params: [string, string][] = [['freq', f]];
  if (f === 'minutes') params.push(['every', s.everyMinutes.trim()]);
  else if (f === 'hourly') params.push(['every', s.everyHours.trim()], ['minute', s.minute.trim()]);
  else params.push(['time', s.time.trim()]);
  if (f === 'weekly') params.push(['day', s.weekday], ['weeks', s.everyWeeks.trim()]);
  if (f === 'days') params.push(['days', v.spec.weekdays.join(',')]);
  if (f === 'monthly') {
    params.push(['monthly', s.monthlyKind]);
    if (s.monthlyKind === 'day') params.push(['mday', s.monthDay.trim()]);
    if (s.monthlyKind === 'nth') params.push(['nth', s.nth], ['wday', s.nthWeekday]);
  }
  const summary = [`Schedule: ${describeSpec(v.spec)}`];
  if (s.zone !== null) {
    params.push(['tz', s.zone]);
    summary.push(`Time zone: ${s.zone}`);
  } else summary.push(DEVICE_ZONE_NOTE);
  params.push(['start', s.startDate.trim()]);
  summary.push(`Start date: ${s.startDate.trim()}`, 'Not included: the task or unit name, program, arguments and date format');
  return { ok: true, params, summary };
}

/** A link's schedule, or null. startDate is '' when the link does not name one (the field keeps its value). */
export function readBuilderShare(params: ReadonlyMap<string, string>): BuilderShare | null {
  const f = oneOf(params.get('freq'), FREQUENCIES);
  if (f === null) return null;
  const monthly = f === 'monthly' ? (params.has('monthly') ? oneOf(params.get('monthly'), MONTHLY) : 'day') : 'day';
  if (monthly === null || !onlyKeys(params, keysFor(f, monthly))) return null;
  const small = (key: string, fallback: string): string | null => {
    const value = params.get(key);
    return value === undefined ? fallback : SMALL.test(value) ? value : null;
  };
  const d = BUILDER_DEFAULTS;
  const everyMinutes = f === 'minutes' ? small('every', d.everyMinutes) : d.everyMinutes;
  const everyHours = f === 'hourly' ? small('every', d.everyHours) : d.everyHours;
  const minute = small('minute', d.minute);
  const time = params.get('time') ?? d.time;
  if (!/^[0-9]{2}:[0-9]{2}$/.test(time)) return null;
  const weekday = small('day', d.weekday);
  const everyWeeks = small('weeks', d.everyWeeks);
  const daysText = params.get('days');
  if (daysText !== undefined && !DAYS.test(daysText)) return null;
  const weekdays = daysText === undefined ? d.weekdays : daysText.split(',').map(Number);
  if (new Set(weekdays).size !== weekdays.length) return null;
  const monthDay = small('mday', d.monthDay);
  const nth = params.has('nth') ? oneOf(params.get('nth'), NTHS) : d.nth;
  const nthWeekday = small('wday', d.nthWeekday);
  const zone = params.has('tz') ? zoneName(params.get('tz')) : null;
  const startDate = params.get('start') ?? '';
  if (everyMinutes === null || everyHours === null || minute === null || weekday === null || everyWeeks === null || monthDay === null || nth === null || nthWeekday === null) return null;
  if (params.has('tz') && zone === null) return null;
  const share: BuilderShare = { frequency: f, everyMinutes, everyHours, minute, time, weekday, everyWeeks, weekdays, monthlyKind: monthly, monthDay, nth: nth as Nth, nthWeekday, zone, startDate };
  // Validate as the builder will: any issue refuses the whole link. A zone is checked here only
  // for its name; the tool checks that this browser lists it.
  const v = validateBuilder({ ...share, zone: zone ?? 'UTC', startDate: startDate === '' ? '2026-01-01' : startDate });
  return v.spec ? share : null;
}
