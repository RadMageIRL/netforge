/**
 * English phrasing shared by the dialect explainers. Only wording lives here; what an item means
 * (and which items a dialect allows) is decided by each dialect's parser.
 */
import { MONTH_NAMES, WEEKDAY_NAMES, formatClock, joinList, ordinal } from './calendar';

export type Item =
  | { readonly kind: 'all'; readonly step: number }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'range'; readonly from: number; readonly to: number; readonly step: number }
  /** Quartz and systemd "n/s": n, n+s, n+2s, ... up to the end of the field. */
  | { readonly kind: 'from'; readonly from: number; readonly step: number };

export interface Unit {
  readonly singular: string;
  /** Set for clock units, whose plain lists read "minutes 10, 20 and 30". */
  readonly plural?: string;
  /** "minute 5", "the 15th", "March", "Monday". */
  readonly one: (n: number) => string;
  /** "minutes 10 through 20", "the 1st through the 7th", "March through June". */
  readonly span: (a: number, b: number) => string;
  /** "every 15 minutes", "every 2nd day", "every 3rd month". */
  readonly every: (step: number) => string;
  /** "at minute 5", "on the 1st", "in January", "on Monday". */
  readonly start: (n: number) => string;
}

function clockUnit(singular: string, plural: string): Unit {
  return {
    singular,
    plural,
    one: n => `${singular} ${n}`,
    span: (a, b) => `${plural} ${a} through ${b}`,
    every: step => (step === 1 ? `every ${singular}` : `every ${step} ${plural}`),
    start: n => `at ${singular} ${n}`,
  };
}

function namedUnit(singular: string, name: (n: number) => string, preposition: string): Unit {
  return {
    singular,
    one: name,
    span: (a, b) => `${name(a)} through ${name(b)}`,
    every: step => (step === 1 ? `every ${singular}` : `every ${ordinal(step)} ${singular}`),
    start: n => `${preposition} ${name(n)}`,
  };
}

export const UNITS = {
  second: clockUnit('second', 'seconds'),
  minute: clockUnit('minute', 'minutes'),
  hour: clockUnit('hour', 'hours'),
  day: namedUnit('day', n => `the ${ordinal(n)}`, 'on'),
  month: namedUnit('month', n => MONTH_NAMES[n - 1], 'in'),
  year: { ...clockUnit('year', 'years'), one: (n: number) => String(n), span: (a: number, b: number) => `${a} through ${b}`, start: (n: number) => `in ${n}` },
} satisfies Record<string, Unit>;

/** Weekday unit for a numbering where `sunday` is the number of Sunday (0 in cron, 1 in Quartz). */
export function weekdayUnit(sunday: number): Unit {
  return namedUnit('weekday', n => WEEKDAY_NAMES[(n - sunday + 7) % 7], 'on');
}

export function describeItem(item: Item, unit: Unit): string {
  switch (item.kind) {
    case 'all': return unit.every(item.step);
    case 'value': return unit.one(item.value);
    case 'range': return item.step === 1 ? unit.span(item.from, item.to) : `${unit.every(item.step)} from ${unit.one(item.from)} through ${unit.one(item.to)}`;
    case 'from': return `${unit.every(item.step)} starting ${unit.start(item.from)}`;
  }
}

export function describeItems(items: readonly Item[], unit: Unit): string {
  if (items.length > 1 && unit.plural && items.every(i => i.kind === 'value')) {
    return `${unit.plural} ${joinList(items.map(i => String((i as { value: number }).value)))}`;
  }
  return joinList(items.map(i => describeItem(i, unit)));
}

export interface TimeField {
  readonly items: readonly Item[];
  readonly values: readonly number[];
  /** True when the values cover the whole field. */
  readonly full: boolean;
}

/** One "* /n" item covering the field from its start, as in "every 15 minutes". */
function simpleStep(f: TimeField): number | null {
  if (f.items.length !== 1) return null;
  const it = f.items[0];
  if (it.kind === 'all') return it.step;
  if (it.kind === 'from' && it.from === 0) return it.step;
  return null;
}

/** A phrase for the times of day: "at 09:00", "every 15 minutes", "at minute 5 past every hour". */
export function describeTimeOfDay(sec: TimeField | null, min: TimeField, hour: TimeField): string {
  const seconds = sec ? sec.values : [0];
  const withSeconds = seconds.some(s => s !== 0);
  const combos = seconds.length * min.values.length * hour.values.length;
  const listable = (f: TimeField) => !f.items.some(i => i.kind === 'all' || i.kind === 'from');
  if (combos <= 6 && listable(min) && listable(hour) && (!sec || listable(sec))) {
    const times: string[] = [];
    for (const h of hour.values) for (const m of min.values) for (const s of seconds) times.push(withSeconds ? formatClock(h, m, s) : formatClock(h, m));
    return `at ${joinList(times)}`;
  }
  const minuteStep = simpleStep(min);
  const hourStep = simpleStep(hour);
  let prefix = '';
  if (sec) {
    if (sec.full && min.full && hour.full) return 'every second';
    const secStep = simpleStep(sec);
    if (sec.full) prefix = 'every second of ';
    else if (secStep !== null && min.full && hour.full) return `every ${secStep} seconds`;
    else if (!(sec.values.length === 1 && sec.values[0] === 0)) prefix = `at ${describeItems(sec.items, UNITS.second)} of `;
  }
  if (!prefix && min.full && hour.full) return 'every minute';
  if (!prefix && hour.full && minuteStep !== null) return minuteStep === 1 ? 'every minute' : `every ${minuteStep} minutes`;
  if (!prefix && (min.full || minuteStep !== null)) {
    const what = min.full || minuteStep === 1 ? 'every minute' : `every ${minuteStep} minutes`;
    const scope = hourScope(hour);
    if (scope) return `${what} ${scope}`;
  }
  if (min.values.length === 1 && min.items.length === 1 && min.items[0].kind === 'value') {
    const m = min.values[0];
    const at = prefix ? `${prefix}minute ${m}` : m === 0 ? 'at the start of' : `at minute ${m} of`;
    const joiner = prefix ? ' past ' : ' ';
    if (hour.full) return `${at}${joiner}every hour`;
    if (hourStep !== null) return `${at}${joiner}every ${hourStep === 1 ? 'hour' : `${ordinal(hourStep)} hour`}`;
    return `${at}${joiner}${describeItems(hour.items, UNITS.hour)}`;
  }
  const hours = hour.full ? 'every hour' : describeItems(hour.items, UNITS.hour);
  if (!prefix && minuteStep !== null) return `${minuteStep === 1 ? 'every minute' : `every ${minuteStep} minutes`} during ${hours}`;
  const minutes = min.full ? 'every minute' : describeItems(min.items, UNITS.minute);
  return `${prefix || (min.full ? '' : 'at ')}${minutes} past ${hours}`;
}

/** "from 09:00 through 17:59" for one hour or one plain range of hours; null otherwise. */
function hourScope(hour: TimeField): string | null {
  if (hour.items.length !== 1) return null;
  const it = hour.items[0];
  if (it.kind === 'value') return `from ${formatClock(it.value, 0)} through ${formatClock(it.value, 59)}`;
  if (it.kind === 'range' && it.step === 1) return `from ${formatClock(it.from, 0)} through ${formatClock(it.to, 59)}`;
  return null;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ends a sentence with one period. */
export function sentence(text: string): string {
  const t = capitalize(text.trim());
  return t.endsWith('.') ? t : `${t}.`;
}
