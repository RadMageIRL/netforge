/**
 * systemd calendar expressions (the OnCalendar= value of a .timer unit; systemd.time(7), "Calendar
 * Events"), a documented subset:
 *
 *   [weekdays] [[year-]month-day | [year-]month~day] [hour:minute[:second]] [UTC | Region/City]
 *
 * - Weekdays: Mon..Sun or full names, any case, joined with "," and ranges "..", or "-".
 * - Components: *, n, a..b, n/r, a..b/r, joined with ",". There is no "* /r": write 0/r.
 * - "~" counts days from the end of the month: ~01 is the last day, ~03 the third last,
 *   ~07/1 the last seven days, ~01..07 the same.
 * - Year 1970 to 2199; one- and two-digit years mean 2000 to 2069 and 1970 to 1999.
 * - Shorthands: minutely, hourly, daily, weekly, monthly, yearly, annually, quarterly,
 *   semiannually, optionally followed by a time zone.
 * - A weekday and a date must both match (AND).
 *
 * The acceptance and normalization rules here were checked against systemd 257's
 * `systemd-analyze calendar` (tests/fixtures/systemd-oracle.json). Not supported, rejected with a
 * reason: fractional seconds, time zone abbreviations (EST, EDT: systemd reads those as the host's
 * own abbreviations), and monotonic settings such as OnBootSec=, which are not calendar events.
 */
import { fail, ok, type Result } from '../result';
import { MONTH_NAMES, WEEKDAY_NAMES, daysInMonth, joinList, ordinal, weekday } from './calendar';
import { describeItems, describeTimeOfDay, sentence, UNITS, type Item, type TimeField } from './describe';
import { compactList, scheduleFail, type CalendarPattern, type DstPolicy, type Explanation, type FieldExplanation } from './model';
import { quote, splitPiece, words, type Piece } from './tokens';
import { CURRENT_ZONE_NAMES, isValidTimeZone, listTimeZones } from '../time/zones';

export type SystemdErrorCode =
  | 'empty' | 'monotonic' | 'timespan' | 'syntax' | 'range' | 'reversed-range' | 'repeat' | 'weekday'
  | 'zone' | 'zone-abbreviation' | 'fraction' | 'year-digits' | 'extra' | 'cron-syntax' | 'empty-item';

export const SYSTEMD_FIRST_YEAR = 1970;
export const SYSTEMD_LAST_YEAR = 2199;
/** Days counted from the end of the month ("~n") go up to 28 in systemd 257. */
const EOM_MAX = 28;

export interface Component {
  readonly start: number;
  /** Inclusive end of a range, or null for a single value. */
  readonly stop: number | null;
  /** 0 for none. */
  readonly repeat: number;
}

/** null means "*": any value. */
export type Chain = readonly Component[] | null;

export interface SystemdSchedule {
  readonly dialect: 'systemd';
  readonly source: string;
  /** Bits 0 (Monday) to 6 (Sunday); 0 or 127 means any weekday. */
  readonly weekdays: number;
  readonly year: Chain;
  readonly month: Chain;
  readonly day: Chain;
  /** "~": day values count back from the last day of the month. */
  readonly endOfMonth: boolean;
  readonly hour: Chain;
  readonly minute: Chain;
  /** null is every second ("*"). */
  readonly second: Chain;
  /** "UTC", an IANA name as written, or null for the system's local zone. */
  readonly zone: string | null;
  /** The shorthand used, if any ("daily"). */
  readonly shorthand: string | null;
  /** True when the input started with "OnCalendar=". */
  readonly hadKey: boolean;
  readonly normalized: string;
  readonly warnings: readonly string[];
}

type R<T> = Result<T, SystemdErrorCode>;

const DAY_NAMES: Readonly<Record<string, number>> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, wednesday: 2, wed: 2, thursday: 3, thu: 3,
  friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6,
};
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const SHORTHANDS: Readonly<Record<string, string>> = {
  minutely: '*-*-* *:*:00',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  yearly: '*-01-01 00:00:00',
  annually: '*-01-01 00:00:00',
  quarterly: '*-01,04,07,10-01 00:00:00',
  semiannually: '*-01,07-01 00:00:00',
};

const MONOTONIC = /^(OnActiveSec|OnBootSec|OnStartupSec|OnUnitActiveSec|OnUnitInactiveSec)\s*=/i;
const TIMESPAN = /^([0-9]+(\.[0-9]+)?\s*(usec|us|msec|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d|weeks?|w|months?|M|years?|y)\s*)+$/;

interface ChainSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly year?: boolean;
  readonly eom?: boolean;
  readonly seconds?: boolean;
}

function parseValue(text: string, offset: number, spec: ChainSpec): R<number> {
  if (/^[0-9]+\.[0-9]*$/.test(text)) return scheduleFail('fraction', `${quote(text)}: NetForge does not read fractional seconds (systemd allows them). Use whole seconds.`, offset, text.length, spec.name);
  if (!/^[0-9]+$/.test(text)) return scheduleFail('syntax', `${quote(text)} is not a number in the ${spec.name} component.`, offset, Math.max(1, text.length), spec.name);
  let n = Number(text);
  if (spec.year) {
    if (text.length === 3 || text.length > 4) return scheduleFail('year-digits', `${quote(text)}: write the year with four digits (systemd reads one or two digits as 2000-2069 or 1970-1999, and rejects three).`, offset, text.length, spec.name);
    if (text.length <= 2) n = n < 70 ? 2000 + n : 1900 + n;
  }
  const max = spec.eom ? EOM_MAX : spec.max;
  if (text.length > 4 || n < spec.min || n > max) {
    const what = spec.eom ? `days counted from the end of the month (~) are ${spec.min}-${EOM_MAX}` : `use ${spec.min}-${spec.max}`;
    return scheduleFail('range', `${quote(text)} is out of range for the ${spec.name}: ${what}.`, offset, text.length, spec.name);
  }
  return ok(n);
}

function parseChain(piece: Piece, spec: ChainSpec): R<Chain> {
  const t = piece.text;
  if (t === '*') return ok(null);
  if (/^\*\/[0-9]/.test(t) || t.includes('*/')) return scheduleFail('cron-syntax', `${quote(t)}: systemd has no "*/n". Write a start and a repetition, such as 0/15 or 00/15.`, piece.offset, t.length, spec.name);
  const out: Component[] = [];
  for (const part of splitPiece(piece, ',')) {
    if (part.text === '') return scheduleFail('empty-item', `The ${spec.name} component has an empty list item.`, part.offset, 0, spec.name);
    const m = /^([0-9.]+?)(?:\.\.([0-9.]+?))?(?:\/([0-9.]+))?$/.exec(part.text);
    if (!m) return scheduleFail('syntax', `${quote(part.text)} is not a valid ${spec.name}: use n, a..b, n/r or a..b/r.`, part.offset, part.text.length, spec.name);
    const a = parseValue(m[1], part.offset, spec);
    if (!a.ok) return a;
    let start = a.value;
    let stop: number | null = null;
    if (m[2] !== undefined) {
      const b = parseValue(m[2], part.offset + m[1].length + 2, spec);
      if (!b.ok) return b;
      stop = b.value;
      if (stop < start) return scheduleFail('reversed-range', `${quote(part.text)} runs backwards: write the smaller value first${spec.eom ? ' (with ~, ~01..07 means the last seven days)' : ''}.`, part.offset, part.text.length, spec.name);
    }
    let repeat = 0;
    if (m[3] !== undefined) {
      const repText = m[3];
      const repOffset = part.offset + part.text.length - repText.length;
      if (repText.includes('.')) return scheduleFail('fraction', `${quote(repText)}: NetForge does not read fractional repetitions.`, repOffset, repText.length, spec.name);
      if (!/^[0-9]+$/.test(repText)) return scheduleFail('syntax', `${quote(repText)} is not a whole number.`, repOffset, repText.length, spec.name);
      repeat = Number(repText);
      if (repeat === 0) return scheduleFail('repeat', `A repetition of 0 is not allowed in the ${spec.name}.`, repOffset, repText.length, spec.name);
    }
    // systemd 257 normalizes ranges first: the end moves to the last value hit, a range of one value
    // becomes that value, and a repetition of 1 in a range is dropped.
    if (stop !== null) {
      if (repeat > 0) stop = start + Math.floor((stop - start) / repeat) * repeat;
      if (stop === start) {
        stop = null;
        repeat = 0;
      } else if (repeat === 1) repeat = 0;
    }
    const max = spec.eom ? EOM_MAX : spec.max;
    if (repeat > max - spec.min) return scheduleFail('repeat', `A repetition of ${repeat} is too large for the ${spec.name} (at most ${max - spec.min}).`, part.offset, part.text.length, spec.name);
    if (stop === null && repeat > 0) {
      if (spec.eom ? start - repeat < spec.min : start + repeat > max) {
        return scheduleFail('repeat', spec.eom
          ? `~${m[1]}/${repeat}: the repetition must reach at least one more day before the end of the month (${repeat} must be less than ${start}).`
          : `${quote(part.text)}: ${start} + ${repeat} is past the largest ${spec.name} (${max}), so systemd rejects it.`, part.offset, part.text.length, spec.name);
      }
    }
    out.push({ start, stop, repeat });
  }
  out.sort((x, y) => x.start - y.start || (x.stop ?? -1) - (y.stop ?? -1) || x.repeat - y.repeat);
  const unique = out.filter((c, i) => i === 0 || c.start !== out[i - 1].start || c.stop !== out[i - 1].stop || c.repeat !== out[i - 1].repeat);
  return ok(unique);
}

function parseWeekdays(piece: Piece): R<number> {
  let bits = 0;
  const parts = splitPiece(piece, ',');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.text === '') {
      if (i === parts.length - 1 && i > 0) continue; // "Wed," is accepted, as systemd's documentation shows
      return scheduleFail('empty-item', 'The weekday list has an empty item.', part.offset, 0, 'weekday');
    }
    const range = /^([A-Za-z]+)(?:(\.\.|-)([A-Za-z]+))?$/.exec(part.text);
    if (!range) return scheduleFail('weekday', `${quote(part.text)} is not a weekday or a range of weekdays (Mon..Fri).`, part.offset, part.text.length, 'weekday');
    const a = DAY_NAMES[range[1].toLowerCase()];
    if (a === undefined) return scheduleFail('weekday', `${quote(range[1])} is not a weekday name: use Mon, Tue, Wed, Thu, Fri, Sat, Sun or the full names.`, part.offset, range[1].length, 'weekday');
    if (range[3] === undefined) {
      bits |= 1 << a;
      continue;
    }
    const b = DAY_NAMES[range[3].toLowerCase()];
    const bOffset = part.offset + range[1].length + range[2].length;
    if (b === undefined) return scheduleFail('weekday', `${quote(range[3])} is not a weekday name.`, bOffset, range[3].length, 'weekday');
    if (b < a) return scheduleFail('reversed-range', `${quote(part.text)} runs backwards: systemd weeks run Monday to Sunday, so write it as two parts, for example Fri..Sun,Mon.`, part.offset, part.text.length, 'weekday');
    for (let d = a; d <= b; d++) bits |= 1 << d;
  }
  return ok(bits);
}

let zoneIndex: Map<string, string> | null = null;
/** Lowercase name to the exact spelling, for zones the runtime lists. */
function knownZones(): Map<string, string> {
  if (!zoneIndex) {
    zoneIndex = new Map();
    const names = new Set<string>(listTimeZones());
    for (const [from, to] of Object.entries(CURRENT_ZONE_NAMES)) names.add(from).add(to);
    for (const n of names) zoneIndex.set(n.toLowerCase(), n);
  }
  return zoneIndex;
}

function parseZone(piece: Piece): R<string> {
  const t = piece.text;
  if (t.toUpperCase() === 'UTC') return ok('UTC');
  if (!t.includes('/')) {
    if (DAY_NAMES[t.split(/[,.-]/)[0].toLowerCase()] !== undefined) return scheduleFail('weekday', `${quote(t)}: write all weekdays as one list without spaces, for example Mon,Tue or Mon..Fri.`, piece.offset, t.length, 'weekday');
    if (/^[A-Za-z]{1,5}$/.test(t)) return scheduleFail('zone-abbreviation', `${quote(t)}: NetForge accepts UTC or a region name such as America/New_York. systemd reads abbreviations like EST and EDT as the host's own zone, which depends on the host's configuration.`, piece.offset, t.length, 'time zone');
    return scheduleFail('zone', `${quote(t)} is not a date, a time or a time zone. Weekdays are one comma-separated list (Mon,Tue), and the zone comes last.`, piece.offset, t.length, 'time zone');
  }
  if (!isValidTimeZone(t)) return scheduleFail('zone', `${quote(t)} is not a time zone in this browser's IANA database.`, piece.offset, t.length, 'time zone');
  const exact = knownZones().get(t.toLowerCase());
  if (exact && exact !== t) return scheduleFail('zone', `systemd matches zone names exactly, with case: write ${exact}.`, piece.offset, t.length, 'time zone');
  return ok(t);
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

function formatChain(c: Chain, width: number): string {
  if (c === null) return '*';
  return c.map(x => `${pad(x.start, width)}${x.stop !== null ? `..${pad(x.stop, width)}` : ''}${x.repeat > 0 ? `/${x.repeat}` : ''}`).join(',');
}

function formatSeconds(c: Chain): string {
  if (c === null) return '*';
  if (c.length === 1 && c[0].start === 0 && c[0].stop === null && c[0].repeat === 1) return '*';
  return formatChain(c, 2);
}

/** systemd's weekday formatting: Monday first, runs of three or more as ranges, pairs with a comma. */
export function formatWeekdays(bits: number): string {
  const parts: string[] = [];
  for (let x = 0; x < 7;) {
    if (!(bits & (1 << x))) { x++; continue; }
    let y = x;
    while (y + 1 < 7 && bits & (1 << (y + 1))) y++;
    if (y - x >= 2) parts.push(`${SHORT[x]}..${SHORT[y]}`);
    else for (let k = x; k <= y; k++) parts.push(SHORT[k]);
    x = y + 1;
  }
  return parts.join(',');
}

function normalize(s: Omit<SystemdSchedule, 'normalized' | 'warnings' | 'source' | 'shorthand' | 'hadKey' | 'dialect'>): string {
  const wd = s.weekdays !== 0 && s.weekdays !== 127 ? `${formatWeekdays(s.weekdays)} ` : '';
  const date = `${formatChain(s.year, 4)}-${formatChain(s.month, 2)}${s.endOfMonth ? '~' : '-'}${formatChain(s.day, 2)}`;
  const time = `${formatChain(s.hour, 2)}:${formatChain(s.minute, 2)}:${formatSeconds(s.second)}`;
  return `${wd}${date} ${time}${s.zone ? ` ${s.zone}` : ''}`;
}

const ZERO: Chain = [{ start: 0, stop: null, repeat: 0 }];

export function parseSystemd(input: string): R<SystemdSchedule> {
  let text = input;
  let hadKey = false;
  const trimmed = input.trim();
  if (trimmed === '') return fail('empty', 'Enter a systemd calendar expression, such as Mon..Fri 09:00, daily, or *-*-01 00:00:00.');
  if (MONOTONIC.test(trimmed)) {
    const key = trimmed.split('=')[0].trim();
    return scheduleFail('monotonic', `${key}= is a monotonic timer setting: it counts time from an event (boot, activation), not from the calendar, so it has no calendar run times. NetForge reads OnCalendar= values.`, input.indexOf(key), key.length);
  }
  const keyMatch = /^(\s*)OnCalendar\s*=\s*/.exec(input);
  if (keyMatch) {
    hadKey = true;
    text = ' '.repeat(keyMatch[0].length) + input.slice(keyMatch[0].length);
  }
  const body = text.trim();
  if (body === '') return fail('empty', 'Enter the value after OnCalendar=.');
  if (TIMESPAN.test(body)) {
    return scheduleFail('timespan', `${quote(body)} is a time span, the kind of value OnBootSec= or OnUnitActiveSec= take. Those are monotonic timers, measured from an event, not calendar expressions.`, text.indexOf(body), body.length);
  }
  if (body.startsWith('@')) return scheduleFail('cron-syntax', `${quote(body.split(/\s/)[0])} is cron syntax. systemd's shorthands are minutely, hourly, daily, weekly, monthly, yearly, quarterly and semiannually.`, text.indexOf('@'), body.split(/\s/)[0].length);
  const pieces = words(text);
  const warnings: string[] = [];
  let weekdays = 0;
  let year: Chain = null;
  let month: Chain = null;
  let day: Chain = null;
  let endOfMonth = false;
  let hour: Chain = ZERO;
  let minute: Chain = ZERO;
  let second: Chain = ZERO;
  let zone: string | null = null;
  let shorthand: string | null = null;
  let i = 0;

  const first = pieces[0].text.toLowerCase();
  if (SHORTHANDS[first]) {
    shorthand = first;
    const expanded = parseSystemd(SHORTHANDS[first]);
    if (!expanded.ok) return expanded;
    ({ weekdays, year, month, day, endOfMonth, hour, minute, second } = expanded.value);
    i = 1;
    if (pieces[1] && !/[A-Za-z]/.test(pieces[1].text)) {
      return scheduleFail('extra', `${shorthand} stands alone; only a time zone may follow it. For another time, write the full form, for example *-*-* ${pieces[1].text}.`, pieces[1].offset, pieces[1].text.length);
    }
  } else {
    if (/^[A-Za-z]/.test(pieces[0].text) && !pieces[0].text.includes('/') && pieces[0].text.toUpperCase() !== 'UTC') {
      const w = parseWeekdays(pieces[0]);
      if (!w.ok) return w;
      weekdays = w.value;
      i = 1;
    }
    const isDate = (t: string) => /^[0-9*.,/~-]+$/.test(t) && /[-~]/.test(t);
    const isTime = (t: string) => /^[0-9*.,/:]+$/.test(t) && t.includes(':');
    if (i < pieces.length && isDate(pieces[i].text)) {
      const p = pieces[i];
      const m = /^(?:([^-~]+)-)?([^-~]+)([-~])([^-~]+)$/.exec(p.text);
      if (!m) return scheduleFail('syntax', `${quote(p.text)} is not a date: write year-month-day or month-day, with * for any, for example *-*-01 or 2026-12-25.`, p.offset, p.text.length, 'date');
      let at = p.offset;
      if (m[1] !== undefined) {
        const y = parseChain({ text: m[1], offset: at }, { name: 'year', min: SYSTEMD_FIRST_YEAR, max: SYSTEMD_LAST_YEAR, year: true });
        if (!y.ok) return y;
        year = y.value;
        at += m[1].length + 1;
      }
      const mo = parseChain({ text: m[2], offset: at }, { name: 'month', min: 1, max: 12 });
      if (!mo.ok) return mo;
      month = mo.value;
      at += m[2].length + 1;
      endOfMonth = m[3] === '~';
      const d = parseChain({ text: m[4], offset: at }, { name: 'day', min: 1, max: 31, eom: endOfMonth });
      if (!d.ok) return d;
      day = d.value;
      i++;
    }
    if (i < pieces.length && isTime(pieces[i].text)) {
      const p = pieces[i];
      const parts = splitPiece(p, ':');
      if (parts.length < 2 || parts.length > 3) return scheduleFail('syntax', `${quote(p.text)} is not a time: write hour:minute or hour:minute:second.`, p.offset, p.text.length, 'time');
      const h = parseChain(parts[0], { name: 'hour', min: 0, max: 23 });
      if (!h.ok) return h;
      const mi = parseChain(parts[1], { name: 'minute', min: 0, max: 59 });
      if (!mi.ok) return mi;
      hour = h.value;
      minute = mi.value;
      if (parts[2]) {
        if (parts[2].text === '*') second = [{ start: 0, stop: null, repeat: 1 }];
        else {
          const se = parseChain(parts[2], { name: 'second', min: 0, max: 59, seconds: true });
          if (!se.ok) return se;
          second = se.value;
        }
      } else second = ZERO;
      i++;
    } else if (i < pieces.length && /^[0-9*]/.test(pieces[i].text)) {
      const p = pieces[i];
      return scheduleFail('syntax', `${quote(p.text)} is neither a date (with -) nor a time (with :).`, p.offset, p.text.length);
    }
    if (i === 0) return scheduleFail('syntax', `${quote(pieces[0].text)} is not a weekday, date, time or shorthand.`, pieces[0].offset, pieces[0].text.length);
  }
  if (i < pieces.length) {
    const z = parseZone(pieces[i]);
    if (!z.ok) return z;
    zone = z.value;
    i++;
  }
  if (i < pieces.length) {
    const rest = pieces[i];
    return scheduleFail('extra', `Unexpected ${quote(rest.text)}: the time zone is the last part of the expression.`, rest.offset, input.length - rest.offset);
  }
  const parts = { weekdays, year, month, day, endOfMonth, hour, minute, second, zone };
  return ok({ dialect: 'systemd', source: trimmed, ...parts, shorthand, hadKey, normalized: normalize(parts), warnings });
}

/** Values of a non-end-of-month chain within [min, max]. */
function expand(c: Chain, min: number, max: number): number[] {
  if (c === null) {
    const all: number[] = [];
    for (let v = min; v <= max; v++) all.push(v);
    return all;
  }
  const out = new Set<number>();
  for (const x of c) {
    const end = x.stop ?? (x.repeat > 0 ? max : x.start);
    const step = x.repeat > 0 ? x.repeat : 1;
    for (let v = x.start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Distances from the end of the month (1 = last day) an end-of-month chain matches. */
function eomDistances(c: Chain): Set<number> {
  const out = new Set<number>();
  if (c === null) { for (let k = 1; k <= 31; k++) out.add(k); return out; }
  for (const x of c) {
    if (x.stop !== null) {
      for (let k = x.start; k <= x.stop; k += x.repeat > 0 ? x.repeat : 1) out.add(k);
    } else if (x.repeat > 0) {
      for (let k = x.start; k >= 1; k -= x.repeat) out.add(k);
    } else out.add(x.start);
  }
  return out;
}

export function systemdPattern(s: SystemdSchedule): CalendarPattern {
  const years = s.year === null ? null : new Set(expand(s.year, SYSTEMD_FIRST_YEAR, SYSTEMD_LAST_YEAR));
  const months = new Set(expand(s.month, 1, 12));
  const wd = s.weekdays === 0 ? 127 : s.weekdays;
  const days = s.endOfMonth ? null : new Set(expand(s.day, 1, 31));
  const eom = s.endOfMonth ? eomDistances(s.day) : null;
  return {
    seconds: s.second === null ? expand(null, 0, 59) : expand(s.second, 0, 59),
    minutes: expand(s.minute, 0, 59),
    hours: expand(s.hour, 0, 23),
    months,
    lastYear: SYSTEMD_LAST_YEAR,
    yearMatches: y => y >= SYSTEMD_FIRST_YEAR && (years === null || years.has(y)),
    dayMatches: (y, m, d) => {
      if (eom) { if (!eom.has(daysInMonth(y, m) - d + 1)) return false; }
      else if (!days!.has(d)) return false;
      if (wd === 127) return true;
      const monFirst = (weekday(y, m, d) + 6) % 7;
      return (wd & (1 << monFirst)) !== 0;
    },
  };
}

function chainItems(c: Chain): Item[] {
  if (c === null) return [{ kind: 'all', step: 1 }];
  return c.map((x): Item => x.stop !== null
    ? { kind: 'range', from: x.start, to: x.stop, step: x.repeat || 1 }
    : x.repeat > 0 ? { kind: 'from', from: x.start, step: x.repeat } : { kind: 'value', value: x.start });
}

function timeField(c: Chain, min: number, max: number): TimeField {
  const values = expand(c, min, max);
  return { items: chainItems(c), values, full: values.length === max - min + 1 };
}

function weekdayNames(bits: number): string[] {
  const out: string[] = [];
  for (let x = 0; x < 7; x++) if (bits & (1 << x)) out.push(WEEKDAY_NAMES[(x + 1) % 7]);
  return out;
}

/** "first" .. "fourth" for a weekday plus a seven-day window of the month, "last" for ~01..07. */
function nthWindow(s: SystemdSchedule): string | null {
  const wd = s.weekdays;
  if (wd === 0 || wd === 127 || (wd & (wd - 1)) !== 0 || s.day === null || s.day.length !== 1) return null;
  const c = s.day[0];
  if (s.endOfMonth) {
    if ((c.start === 7 && c.stop === null && c.repeat === 1) || (c.start === 1 && c.stop === 7 && c.repeat === 0)) return 'last';
    return null;
  }
  if (c.stop !== null && c.repeat === 0 && c.stop === c.start + 6 && (c.start - 1) % 7 === 0 && c.start <= 22) return ['first', 'second', 'third', 'fourth'][(c.start - 1) / 7];
  return null;
}

function eomPhrase(c: Chain): string {
  const k = [...eomDistances(c)].sort((a, b) => a - b);
  const name = (n: number) => (n === 1 ? 'the last day' : `the ${ordinal(n)}-to-last day`);
  if (k.length > 1 && k[k.length - 1] - k[0] === k.length - 1 && k[0] === 1) return `the last ${k.length} days`;
  return joinList(k.map(name));
}

export function explainSystemd(s: SystemdSchedule): Explanation {
  const time = describeTimeOfDay(s.second === null ? timeField(null, 0, 59) : timeField(s.second, 0, 59), timeField(s.minute, 0, 59), timeField(s.hour, 0, 23));
  const wd = s.weekdays === 127 ? 0 : s.weekdays;
  const names = weekdayNames(wd);
  const monthValues = expand(s.month, 1, 12);
  const monthText = s.month === null ? '' : joinList(monthValues.map(m => MONTH_NAMES[m - 1]));
  const nth = nthWindow(s);
  let date = '';
  if (nth) {
    date = `on the ${nth} ${names[0]} of ${s.month === null ? 'the month' : monthText}`;
  } else {
    const parts: string[] = [];
    if (wd !== 0) parts.push(wd === 0b11111 ? 'on Monday through Friday' : `on ${joinList(names)}`);
    if (s.endOfMonth) parts.push(`on ${eomPhrase(s.day)} of the month`);
    else if (s.day !== null) parts.push(`on ${describeItems(chainItems(s.day), UNITS.day)} of the month`);
    if (s.month !== null) parts.push(`in ${s.month.every(c => c.stop === null && c.repeat === 0) ? monthText : describeItems(chainItems(s.month), UNITS.month)}`);
    date = parts.join(', ');
    if (wd !== 0 && (s.day !== null || s.endOfMonth)) date += ' (the weekday and the date must both match)';
  }
  const year = s.year === null ? '' : `, ${s.year.every(c => c.stop === null && c.repeat === 0) ? `in ${joinList(expand(s.year, SYSTEMD_FIRST_YEAR, SYSTEMD_LAST_YEAR).map(String))}` : describeItems(chainItems(s.year), UNITS.year)}`;
  const zone = s.zone ? `, ${s.zone} time` : '';
  const summary = sentence(`${time}${date ? `, ${date}` : ''}${year}${zone}`);

  const fields: FieldExplanation[] = [
    { field: 'Weekday', text: wd === 0 ? '(none)' : formatWeekdays(wd), meaning: wd === 0 ? 'any weekday' : joinList(names), values: wd === 0 ? 'all' : names.map(n => n.slice(0, 3)).join(', ') },
    { field: 'Year', text: formatChain(s.year, 4), meaning: s.year === null ? `any year (${SYSTEMD_FIRST_YEAR}-${SYSTEMD_LAST_YEAR})` : describeItems(chainItems(s.year), UNITS.year), values: s.year === null ? 'all' : compactList(expand(s.year, SYSTEMD_FIRST_YEAR, SYSTEMD_LAST_YEAR)) },
    { field: 'Month', text: formatChain(s.month, 2), meaning: s.month === null ? 'every month' : describeItems(chainItems(s.month), UNITS.month), values: s.month === null ? 'all' : monthValues.map(m => MONTH_NAMES[m - 1].slice(0, 3)).join(', ') },
    {
      field: s.endOfMonth ? 'Day (from the end, ~)' : 'Day', text: formatChain(s.day, 2),
      meaning: s.day === null ? 'any day' : s.endOfMonth ? eomPhrase(s.day) : describeItems(chainItems(s.day), UNITS.day),
      values: s.day === null ? 'all' : s.endOfMonth ? [...eomDistances(s.day)].sort((a, b) => a - b).map(k => (k === 1 ? 'last' : `last-${k - 1}`)).join(', ') : compactList(expand(s.day, 1, 31)),
    },
    { field: 'Hour', text: formatChain(s.hour, 2), meaning: s.hour === null ? 'every hour' : describeItems(chainItems(s.hour), UNITS.hour), values: compactList(expand(s.hour, 0, 23)) },
    { field: 'Minute', text: formatChain(s.minute, 2), meaning: s.minute === null ? 'every minute' : describeItems(chainItems(s.minute), UNITS.minute), values: compactList(expand(s.minute, 0, 59)) },
    { field: 'Second', text: formatSeconds(s.second), meaning: s.second === null || formatSeconds(s.second) === '*' ? 'every second' : describeItems(chainItems(s.second), UNITS.second), values: compactList(s.second === null ? expand(null, 0, 59) : expand(s.second, 0, 59)) },
    { field: 'Time zone', text: s.zone ?? '(none)', meaning: s.zone ? `${s.zone} time` : 'the system\'s local time zone', values: s.zone ?? 'local' },
  ];

  const warnings = [...s.warnings];
  if (!s.endOfMonth && s.day !== null) {
    const dayValues = expand(s.day, 1, 31);
    const longest = Math.max(...monthValues.map(m => (m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31)));
    if (Math.min(...dayValues) > longest) warnings.push(`None of the selected months has day ${Math.min(...dayValues)}, so this never runs.`);
    else if (s.day.every(c => c.stop === null && c.repeat === 0) && Math.max(...dayValues) >= 29) warnings.push(`Day ${Math.max(...dayValues)} does not exist in every month; systemd skips months without it. ~01 means the last day of the month.`);
  }
  const notes = [
    'Read as a systemd calendar expression (OnCalendar=, systemd.time(7)). This is one setting of a .timer unit, not a whole timer: the unit also needs a [Timer] section, an [Install] section and a service to start.',
    s.zone ? `The expression names its own time zone, ${s.zone}, so runs are computed there.` : 'Without a time zone at the end, systemd uses the system\'s local time zone. NetForge evaluates it in the zone you select.',
    'A timer elapses within AccuracySec= of the calendar time (1 minute by default), and RandomizedDelaySec= can add more; Persistent=true runs a missed activation after a boot. The times listed are calendar times, not guaranteed start times.',
  ];
  if (s.hadKey) notes.push('Read the value after OnCalendar=.');
  if (s.shorthand) notes.push(`${s.shorthand} is shorthand for ${normalize({ ...s, zone: null })}.`);
  return { summary, fields, warnings, notes, normalized: s.normalized };
}

export const SYSTEMD_DST_POLICY: DstPolicy = {
  nonexistent: 'skipped',
  repeatedFirst: 'runs',
  repeatedSecond: 'skipped',
  basis: 'observed with systemd 257 (systemd-analyze calendar); systemd does not document it',
  nonexistentNote: 'This local time does not exist. systemd 257 skips it and moves on to the next matching time (observed; not documented, so other versions may differ).',
  repeatedNote: 'This local time happens twice. systemd 257 runs it once, the first time, and skips the repeat (observed; not documented).',
  repeatedSecondFromInside: 'runs',
  repeatedFromInsideNote: 'This local time happens twice, and the listing starts after the clocks went back. systemd 257 walks local time forward from the start, so it runs this time once, in the second pass (observed; not documented).',
};
