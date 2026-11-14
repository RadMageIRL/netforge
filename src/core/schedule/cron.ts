/**
 * Standard five-field cron, as Vixie cron defines it and cronie and Debian cron follow:
 *
 *   minute (0-59)  hour (0-23)  day-of-month (1-31)  month (1-12 or jan-dec)  day-of-week (0-7 or sun-sat; 0 and 7 are Sunday)
 *
 * Items are *, n, a-b, * /s and a-b/s, joined with commas; three-letter names for months and
 * weekdays, in any case; @yearly, @annually, @monthly, @weekly, @daily, @midnight and @hourly.
 * POSIX defines only numbers, ranges, lists and *; steps, names and nicknames are the Vixie
 * extensions every common cron supports.
 *
 * Day rule (Vixie cron, entry.c and cron.c): when the day-of-month or the day-of-week field starts
 * with *, a day must match both fields; otherwise it may match either. So "0 0 1,15 * 1" runs on
 * the 1st, the 15th and every Monday, while "0 0 * /2 * 1" runs only on odd-numbered Mondays.
 * Other implementations (and POSIX for "* /2", which it does not define) may read the second case
 * as OR; the explanation says so.
 *
 * Rejected, with a reason: Quartz operators (? L W #), "n/s" without a range, wrapping ranges,
 * step 0, full weekday names, @reboot (not a calendar schedule), and anything but five fields.
 */
import { fail, ok, type Result } from '../result';
import { MONTH_NAMES, WEEKDAY_NAMES, joinList, weekday as weekdayOf } from './calendar';
import { describeItems, describeTimeOfDay, sentence, UNITS, weekdayUnit, type Item, type TimeField } from './describe';
import { compactList, scheduleFail, sortedUnique, type CalendarPattern, type DstPolicy, type Explanation, type FieldExplanation } from './model';
import { isDigits, quote, splitPiece, words, type Piece } from './tokens';

export type CronErrorCode =
  | 'empty' | 'field-count' | 'nickname' | 'reboot' | 'syntax' | 'range' | 'reversed-range'
  | 'step' | 'name' | 'quartz-syntax' | 'empty-item';

export type CronFieldKey = 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week';

interface FieldSpec {
  readonly key: CronFieldKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  readonly nameBase?: number;
}

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const SPECS: readonly FieldSpec[] = [
  { key: 'minute', label: 'Minute', min: 0, max: 59 },
  { key: 'hour', label: 'Hour', min: 0, max: 23 },
  { key: 'day-of-month', label: 'Day of month', min: 1, max: 31 },
  { key: 'month', label: 'Month', min: 1, max: 12, names: MONTH_ABBR, nameBase: 1 },
  { key: 'day-of-week', label: 'Day of week', min: 0, max: 7, names: DOW_ABBR, nameBase: 0 },
];

export const CRON_NICKNAMES: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface CronField {
  readonly key: CronFieldKey;
  readonly label: string;
  readonly text: string;
  readonly offset: number;
  readonly items: readonly Item[];
  /** Matching values; day-of-week 7 is folded into 0. */
  readonly values: readonly number[];
  /** Vixie's MIN_STAR / HR_STAR / DOM_STAR / DOW_STAR flag: the field text starts with "*". */
  readonly star: boolean;
  /** The values cover the whole field. */
  readonly full: boolean;
}

export interface CronSchedule {
  readonly dialect: 'cron';
  readonly source: string;
  /** The nickname as written (lowercase), when the input was one. */
  readonly nickname: string | null;
  /** The five fields after nickname expansion. */
  readonly expression: string;
  readonly fields: Readonly<Record<CronFieldKey, CronField>>;
  /** Vixie's day rule for this expression. */
  readonly dayRule: 'and' | 'or';
  readonly warnings: readonly string[];
}

type R<T> = Result<T, CronErrorCode>;

function parseNumber(piece: Piece, spec: FieldSpec): R<number> {
  const t = piece.text;
  if (isDigits(t)) {
    if (t.length > 4 || Number(t) < spec.min || Number(t) > spec.max) {
      return scheduleFail('range', `${quote(t)} is out of range for ${spec.label.toLowerCase()}: use ${spec.min}-${spec.max}${spec.names ? ` or ${spec.names[0]}-${spec.names[spec.names.length - 1]}` : ''}.`, piece.offset, t.length, spec.key);
    }
    return ok(Number(t));
  }
  if (/^[A-Za-z]+$/.test(t)) {
    if (!spec.names) return scheduleFail('name', `${quote(t)} is not a number. ${spec.label} takes numbers ${spec.min}-${spec.max}.`, piece.offset, t.length, spec.key);
    const index = spec.names.indexOf(t.toLowerCase());
    if (index < 0) {
      const full = spec.key === 'day-of-week' ? WEEKDAY_NAMES : MONTH_NAMES;
      const match = full.findIndex(n => n.toLowerCase() === t.toLowerCase());
      if (match >= 0) return scheduleFail('name', `Use the three-letter name ${quote(spec.names[match])}: cron does not read ${quote(t)}.`, piece.offset, t.length, spec.key);
      return scheduleFail('name', `${quote(t)} is not a ${spec.key === 'month' ? 'month' : 'weekday'} name. Use ${spec.names.join(', ')}.`, piece.offset, t.length, spec.key);
    }
    return ok(index + spec.nameBase!);
  }
  return scheduleFail('syntax', `${quote(t)} is not a number${spec.names ? ' or a name' : ''}.`, piece.offset, t.length, spec.key);
}

function quartzHint(piece: Piece, spec: FieldSpec): R<never> | null {
  const t = piece.text;
  const at = (ch: string) => piece.offset + t.indexOf(ch);
  if (t.includes('?')) return scheduleFail('quartz-syntax', '"?" is Quartz syntax. Standard cron uses * for "any day". Choose Quartz to read Quartz expressions.', at('?'), 1, spec.key);
  if (t.includes('#')) return scheduleFail('quartz-syntax', '"#" (nth weekday) is Quartz syntax and is not part of standard cron. Choose Quartz, or note that "0 0 1-7 * 1" in cron means days 1-7 OR Mondays, not the first Monday.', at('#'), 1, spec.key);
  if (/^[0-9]*L(-[0-9]+)?W?$|^LW$|^[0-9]+W$/i.test(t) && (spec.key === 'day-of-month' || spec.key === 'day-of-week')) {
    return scheduleFail('quartz-syntax', `${quote(t)} uses Quartz's L or W, which standard cron does not have. Choose Quartz to read it.`, piece.offset, t.length, spec.key);
  }
  return null;
}

function parseItem(piece: Piece, spec: FieldSpec): R<{ item: Item; values: number[] }> {
  const t = piece.text;
  if (t === '') return scheduleFail('empty-item', `${spec.label} has an empty list item (two commas, or a comma at an end).`, piece.offset, 0, spec.key);
  const hint = quartzHint(piece, spec);
  if (hint) return hint;
  const slash = t.indexOf('/');
  const base: Piece = { text: slash < 0 ? t : t.slice(0, slash), offset: piece.offset };
  let step = 1;
  if (slash >= 0) {
    const stepText = t.slice(slash + 1);
    const stepPiece: Piece = { text: stepText, offset: piece.offset + slash + 1 };
    if (!isDigits(stepText)) return scheduleFail('step', `The step after "/" must be a whole number, not ${quote(stepText)}.`, stepPiece.offset, Math.max(1, stepText.length), spec.key);
    step = Number(stepText);
    if (step === 0 || stepText.length > 4) return scheduleFail('step', `A step of ${stepText} is not allowed: use 1 or more.`, stepPiece.offset, stepText.length, spec.key);
  }
  let from: number;
  let to: number;
  let item: Item;
  if (base.text === '*') {
    from = spec.min;
    to = spec.max;
    item = { kind: 'all', step };
  } else {
    const dash = base.text.indexOf('-');
    if (dash < 0) {
      const n = parseNumber(base, spec);
      if (!n.ok) return n;
      if (slash >= 0) {
        return scheduleFail('quartz-syntax', `${quote(t)}: in standard cron a step needs * or a range. Write ${n.value}-${spec.max}/${step} for "every ${step} starting at ${n.value}" (${t} is Quartz syntax).`, piece.offset, t.length, spec.key);
      }
      return ok({ item: { kind: 'value', value: n.value }, values: [fold(n.value, spec)] });
    }
    const a = parseNumber({ text: base.text.slice(0, dash), offset: base.offset }, spec);
    if (!a.ok) return a;
    const b = parseNumber({ text: base.text.slice(dash + 1), offset: base.offset + dash + 1 }, spec);
    if (!b.ok) return b;
    if (a.value > b.value) {
      return scheduleFail('reversed-range', `${quote(base.text)} runs backwards. Standard cron does not wrap ranges: split it, for example ${spec.key === 'day-of-week' ? 'fri-sat,sun-mon' : '22-23,0-2'}.`, base.offset, base.text.length, spec.key);
    }
    from = a.value;
    to = b.value;
    item = { kind: 'range', from, to, step };
  }
  const values: number[] = [];
  for (let v = from; v <= to; v += step) values.push(fold(v, spec));
  return ok({ item, values });
}

/** Day-of-week 7 is Sunday, the same as 0. */
function fold(v: number, spec: FieldSpec): number {
  return spec.key === 'day-of-week' && v === 7 ? 0 : v;
}

function parseField(piece: Piece, spec: FieldSpec, warnings: string[]): R<CronField> {
  const items: Item[] = [];
  const values: number[] = [];
  for (const part of splitPiece(piece, ',')) {
    const r = parseItem(part, spec);
    if (!r.ok) return r;
    items.push(r.value.item);
    values.push(...r.value.values);
    const it = r.value.item;
    if ((it.kind === 'all' || it.kind === 'range') && it.step > 1) {
      const lo = it.kind === 'all' ? spec.min : it.from;
      const hi = it.kind === 'all' ? spec.max : it.to;
      if (it.step > hi - lo) warnings.push(`${spec.label} ${quote(part.text)}: the step ${it.step} is larger than the range, so it matches only ${lo}.`);
    }
  }
  const unique = sortedUnique(values);
  const size = spec.key === 'day-of-week' ? 7 : spec.max - spec.min + 1;
  return ok({ key: spec.key, label: spec.label, text: piece.text, offset: piece.offset, items, values: unique, star: piece.text.startsWith('*'), full: unique.length === size });
}

export function parseCron(input: string): R<CronSchedule> {
  const source = input.trim();
  if (source === '') return fail('empty', 'Enter a cron expression, such as */15 * * * * or 0 9 * * 1-5.');
  const lead = input.length - input.trimStart().length;
  let expression = source;
  let nickname: string | null = null;
  if (source.startsWith('@')) {
    const word = source.split(/[ \t]/)[0].toLowerCase();
    if (word === '@reboot') return scheduleFail('reboot', '@reboot runs once when cron starts, not on a calendar, so it has no next run times.', lead, 7);
    const expansion = CRON_NICKNAMES[word];
    if (!expansion) return scheduleFail('nickname', `${quote(word)} is not a cron nickname. Use @yearly, @annually, @monthly, @weekly, @daily, @midnight or @hourly.`, lead, word.length);
    if (source.length > word.length) return scheduleFail('field-count', `A nickname stands alone: remove the text after ${word} (a crontab line's command is not part of the schedule).`, lead + word.length, source.length - word.length);
    nickname = word;
    expression = expansion;
  }
  // Offsets point into the input; the fields of an expanded nickname all point at the nickname.
  const pieces = words(expression).map(p => ({ text: p.text, offset: nickname ? lead : p.offset + lead }));
  if (pieces.length !== 5) {
    const hint = pieces.length === 6 || pieces.length === 7
      ? ' Six or seven fields usually mean Quartz (seconds first, optional year): choose Quartz to read it. A crontab line\'s command, or the user field of /etc/crontab, is not part of the schedule.'
      : pieces.length < 5 ? ' The fields are minute, hour, day of month, month and day of week.' : ' A crontab line\'s command is not part of the schedule: enter only the five time fields.';
    return scheduleFail('field-count', `Standard cron has exactly 5 fields; this has ${pieces.length}.${hint}`, lead, source.length);
  }
  const warnings: string[] = [];
  const fields = {} as Record<CronFieldKey, CronField>;
  for (let i = 0; i < 5; i++) {
    const r = parseField(pieces[i], SPECS[i], warnings);
    if (!r.ok) return r;
    fields[SPECS[i].key] = r.value;
  }
  const dom = fields['day-of-month'];
  const dow = fields['day-of-week'];
  const dayRule = dom.star || dow.star ? 'and' : 'or';
  return ok({ dialect: 'cron', source, nickname, expression: pieces.map(p => p.text).join(' '), fields, dayRule, warnings });
}

/** The shared normalized form of a parsed cron expression. */
export function cronPattern(s: CronSchedule): CalendarPattern {
  const dom = new Set(s.fields['day-of-month'].values);
  const dow = new Set(s.fields['day-of-week'].values);
  const and = s.dayRule === 'and';
  return {
    seconds: [0],
    minutes: s.fields.minute.values,
    hours: s.fields.hour.values,
    months: new Set(s.fields.month.values),
    lastYear: 9999,
    yearMatches: () => true,
    dayMatches: (year, month, day) => {
      const w = weekdayOf(year, month, day);
      return and ? dom.has(day) && dow.has(w) : dom.has(day) || dow.has(w);
    },
  };
}


const DOW_UNIT = weekdayUnit(0);

function timeField(f: CronField): TimeField {
  return { items: f.items, values: f.values, full: f.full };
}

function domPhrase(f: CronField): string {
  return `on ${describeItems(f.items, UNITS.day)} of the month`;
}

function dowPhrase(f: CronField): string {
  const names = f.values.map(v => WEEKDAY_NAMES[v]);
  if (f.values.length === 5 && [1, 2, 3, 4, 5].every(v => f.values.includes(v))) return 'Monday through Friday';
  if (f.items.every(i => i.kind === 'value')) return joinList(names);
  return describeItems(f.items, DOW_UNIT);
}

export function explainCron(s: CronSchedule): Explanation {
  const f = s.fields;
  const time = describeTimeOfDay(null, timeField(f.minute), timeField(f.hour));
  const domRestricted = !f['day-of-month'].full;
  const dowRestricted = !f['day-of-week'].full;
  let date = '';
  if (domRestricted && dowRestricted) {
    date = s.dayRule === 'or'
      ? `${domPhrase(f['day-of-month'])}, and also on ${dowPhrase(f['day-of-week'])}`
      : `${domPhrase(f['day-of-month'])}, but only when that day is also ${dowPhrase(f['day-of-week'])}`;
  } else if (domRestricted) date = domPhrase(f['day-of-month']);
  else if (dowRestricted) date = `on ${dowPhrase(f['day-of-week'])}`;
  const month = f.month.full ? '' : ` in ${f.month.items.every(i => i.kind === 'value') ? joinList(f.month.values.map(m => MONTH_NAMES[m - 1])) : describeItems(f.month.items, UNITS.month)}`;
  const summary = sentence(`${time}${date ? `, ${date}` : ''}${month}`);

  const fields: FieldExplanation[] = [
    { field: 'Minute', text: f.minute.text, meaning: f.minute.full ? 'every minute' : describeItems(f.minute.items, UNITS.minute), values: compactList(f.minute.values) },
    { field: 'Hour', text: f.hour.text, meaning: f.hour.full ? 'every hour' : describeItems(f.hour.items, UNITS.hour), values: compactList(f.hour.values) },
    { field: 'Day of month', text: f['day-of-month'].text, meaning: f['day-of-month'].full ? 'any day of the month' : describeItems(f['day-of-month'].items, UNITS.day), values: compactList(f['day-of-month'].values) },
    { field: 'Month', text: f.month.text, meaning: f.month.full ? 'every month' : describeItems(f.month.items, UNITS.month), values: f.month.full ? 'all' : f.month.values.map(m => MONTH_NAMES[m - 1].slice(0, 3)).join(', ') },
    { field: 'Day of week', text: f['day-of-week'].text, meaning: f['day-of-week'].full ? 'any day of the week' : describeItems(f['day-of-week'].items, DOW_UNIT), values: f['day-of-week'].full ? 'all' : f['day-of-week'].values.map(v => WEEKDAY_NAMES[v].slice(0, 3)).join(', ') },
  ];

  const warnings = [...s.warnings];
  if (domRestricted && dowRestricted && s.dayRule === 'or') {
    warnings.push('Both day fields are restricted, so cron runs on days that match EITHER one (the OR rule), not only days that match both. For example, 0 0 1-7 * 1 runs on the 1st to the 7th and on every Monday, not on the first Monday.');
  }
  if (s.dayRule === 'and' && domRestricted && dowRestricted) {
    const which = f['day-of-month'].star ? 'day-of-month' : 'day-of-week';
    warnings.push(`The ${which} field starts with *, so Vixie cron and cronie require BOTH day fields to match (AND). POSIX does not define this case, and some cron implementations use OR here instead; check yours before relying on it.`);
  }
  for (const key of ['minute', 'hour'] as const) {
    const field = f[key];
    const span = key === 'minute' ? 60 : 24;
    for (const it of field.items) {
      const covers = it.kind === 'all' || (it.kind === 'range' && it.from === 0 && it.to === span - 1);
      const step = it.kind === 'all' || it.kind === 'range' ? it.step : 1;
      if (covers && step > 1 && span % step !== 0) {
        const last = Math.floor((span - 1) / step) * step;
        warnings.push(`${field.label} step ${step} does not divide ${span}: runs at ${key} ${last} and then ${key} 0 of the next ${key === 'minute' ? 'hour' : 'day'}, ${span - last} ${key}s apart, not ${step}.`);
      }
    }
  }
  const days = f['day-of-month'].values;
  if (domRestricted && f['day-of-month'].items.every(i => i.kind === 'value') && !(dowRestricted && s.dayRule === 'or')) {
    const maxDay = Math.max(...days);
    const months = f.month.values;
    const longest = Math.max(...months.map(m => (m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31)));
    if (Math.min(...days) > longest) warnings.push(`None of the selected months has day ${Math.min(...days)}, so this never runs.`);
    else if (maxDay >= 29) warnings.push(`Day ${maxDay} does not exist in every month; cron skips months without it (it does not move to the last day).${days.length === 1 && maxDay === 29 && months.includes(2) ? ' February 29 occurs only in leap years.' : ''}`);
  }
  const notes = [
    'Read as standard five-field cron: minute, hour, day of month, month, day of week (Vixie cron, as in cronie and Debian cron).',
    'Cron uses the time zone of the cron daemon (normally the system zone; cronie also reads CRON_TZ). NetForge evaluates the expression in the zone you select.',
  ];
  if (f['day-of-week'].values.includes(0) && /7/.test(f['day-of-week'].text)) notes.push('Day of week 7 is Sunday, the same as 0.');
  return { summary, fields, warnings, notes, normalized: s.nickname ? s.expression : null };
}

/**
 * Cron daemons differ at DST changes. cronie's cron(8) documents: for changes under three hours,
 * jobs with a fixed time that fall in a skipped interval run right after the jump, and fixed-time
 * jobs are not run twice when clocks go back; jobs with * in the minute or hour field run as the
 * clock shows. Other cron implementations may skip or repeat instead. NetForge therefore marks
 * these times as uncertain.
 */
export function cronDstPolicy(s: CronSchedule): DstPolicy {
  const wildcard = s.fields.minute.star || s.fields.hour.star;
  return {
    nonexistent: 'uncertain',
    repeatedFirst: 'runs',
    repeatedSecond: 'uncertain',
    basis: 'cron implementations differ; cronie documents its behavior in cron(8)',
    nonexistentNote: wildcard
      ? 'This local time does not exist. cronie skips it for entries with * in the minute or hour field; other cron daemons also skip it or behave differently.'
      : 'This local time does not exist. cronie runs fixed-time entries right after the clocks jump (for changes under 3 hours); other cron daemons may skip the run.',
    repeatedNote: wildcard
      ? 'This local time happens twice. cronie runs entries with * in the minute or hour field both times; other cron daemons may differ.'
      : 'This local time happens twice. cronie runs fixed-time entries only the first time; other cron daemons may run them twice.',
  };
}
