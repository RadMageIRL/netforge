/**
 * Quartz Scheduler cron expressions (the CronExpression class of Quartz 2.x, as its documentation
 * and the CronTrigger tutorial describe them):
 *
 *   seconds  minutes  hours  day-of-month  month  day-of-week  [year]
 *   0-59     0-59     0-23   1-31          1-12   1-7          1970-2099
 *                                           JAN-DEC SUN-SAT (1 = Sunday)
 *
 * Items: *, ?, n, a-b, a-b/s, n/s and * /s, joined with commas; names in any case. Exactly one of
 * day-of-month and day-of-week must be "?" (Quartz does not implement both at once).
 *
 * Day-of-month specials: L (last day), L-n (n days before the last day), LW (last weekday), nW
 * (weekday nearest day n, never crossing into another month).
 * Day-of-week specials: L alone (7, Saturday), nL (last weekday n of the month), n#k (kth weekday n).
 *
 * Rejected explicitly instead of approximated:
 * - nW for days 29 to 31 and L-n for n of 28 or more: Quartz does not document what they do in a
 *   month that is too short.
 * - L, W and # inside lists or ranges: the documentation warns of "confusing/unexpected results".
 * - Wrapping ranges (FRI-MON, 22-2): Quartz versions disagree on them.
 * - A step after names (MON-FRI/2): write it with numbers.
 * - A bare "/n" and empty list items, which the documentation does not define.
 */
import { fail, ok, type Result } from '../result';
import { MONTH_NAMES, WEEKDAY_NAMES, daysInMonth, joinList, lastBusinessDay, lastWeekday, nearestWeekday, nthWeekday, ordinal, weekday } from './calendar';
import { describeItems, describeTimeOfDay, sentence, UNITS, weekdayUnit, type Item, type TimeField } from './describe';
import { compactList, scheduleFail, sortedUnique, type CalendarPattern, type DstPolicy, type Explanation, type FieldExplanation } from './model';
import { isDigits, quote, splitPiece, words, type Piece } from './tokens';

export type QuartzErrorCode =
  | 'empty' | 'field-count' | 'syntax' | 'range' | 'reversed-range' | 'step' | 'name' | 'question-mark'
  | 'day-fields' | 'special' | 'unsupported' | 'empty-item' | 'cron-syntax';

export type QuartzFieldKey = 'second' | 'minute' | 'hour' | 'day-of-month' | 'month' | 'day-of-week' | 'year';

interface FieldSpec {
  readonly key: QuartzFieldKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
  /** The number of the first name. */
  readonly nameBase?: number;
}

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const SPECS: readonly FieldSpec[] = [
  { key: 'second', label: 'Second', min: 0, max: 59 },
  { key: 'minute', label: 'Minute', min: 0, max: 59 },
  { key: 'hour', label: 'Hour', min: 0, max: 23 },
  { key: 'day-of-month', label: 'Day of month', min: 1, max: 31 },
  { key: 'month', label: 'Month', min: 1, max: 12, names: MONTH_ABBR, nameBase: 1 },
  { key: 'day-of-week', label: 'Day of week', min: 1, max: 7, names: DOW_ABBR, nameBase: 1 },
  { key: 'year', label: 'Year', min: 1970, max: 2099 },
];

export const QUARTZ_LAST_YEAR = 2099;

export type DomSpecial =
  | { readonly kind: 'last'; readonly offset: number }
  | { readonly kind: 'last-weekday' }
  | { readonly kind: 'nearest-weekday'; readonly day: number };

export type DowSpecial =
  | { readonly kind: 'last-of'; readonly dow: number }
  | { readonly kind: 'nth'; readonly dow: number; readonly n: number };

export interface QuartzField {
  readonly key: QuartzFieldKey;
  readonly label: string;
  readonly text: string;
  readonly offset: number;
  readonly items: readonly Item[];
  readonly values: readonly number[];
  readonly full: boolean;
  /** "?" */
  readonly noSpecific: boolean;
}

export interface QuartzSchedule {
  readonly dialect: 'quartz';
  readonly source: string;
  readonly fields: Readonly<Record<Exclude<QuartzFieldKey, 'year'>, QuartzField>> & { readonly year: QuartzField | null };
  readonly domSpecial: DomSpecial | null;
  readonly dowSpecial: DowSpecial | null;
  /** Which day field decides: the other one is "?". */
  readonly dayField: 'day-of-month' | 'day-of-week';
  readonly warnings: readonly string[];
}

type R<T> = Result<T, QuartzErrorCode>;

function parseNumber(piece: Piece, spec: FieldSpec): R<number> {
  const t = piece.text.toUpperCase();
  if (isDigits(t)) {
    const n = Number(t);
    if (t.length > 4 || n < spec.min || n > spec.max) {
      const cronHint = spec.key === 'day-of-week' && n === 0 ? ' Quartz numbers weekdays 1 (Sunday) to 7 (Saturday); 0 is standard cron numbering.' : '';
      return scheduleFail('range', `${quote(piece.text)} is out of range for ${spec.label.toLowerCase()}: use ${spec.min}-${spec.max}${spec.names ? ` or ${spec.names[0]}-${spec.names[spec.names.length - 1]}` : ''}.${cronHint}`, piece.offset, piece.text.length, spec.key);
    }
    return ok(n);
  }
  if (/^[A-Z]+$/.test(t)) {
    if (!spec.names) return scheduleFail('name', `${quote(piece.text)} is not a number. ${spec.label} takes ${spec.min}-${spec.max}.`, piece.offset, piece.text.length, spec.key);
    const index = spec.names.indexOf(t);
    if (index < 0) {
      return scheduleFail('name', `${quote(piece.text)} is not a ${spec.key === 'month' ? 'month' : 'weekday'} name. Use three letters: ${spec.names.join(', ')}.`, piece.offset, piece.text.length, spec.key);
    }
    return ok(index + spec.nameBase!);
  }
  return scheduleFail('syntax', `${quote(piece.text)} is not a number${spec.names ? ' or a name' : ''}.`, piece.offset, piece.text.length, spec.key);
}

const isName = (t: string) => /^[A-Za-z]{3}$/.test(t);

function parseItem(piece: Piece, spec: FieldSpec): R<{ item: Item; values: number[] }> {
  const t = piece.text;
  if (t === '') return scheduleFail('empty-item', `${spec.label} has an empty list item (two commas, or a comma at an end). Remove the extra comma.`, piece.offset, 0, spec.key);
  const dayField = spec.key === 'day-of-month' || spec.key === 'day-of-week';
  if (t === '?') {
    return scheduleFail('question-mark', dayField ? '"?" must be the whole field, not part of a list.' : '"?" is allowed only in the day-of-month or day-of-week field.', piece.offset, 1, spec.key);
  }
  if (dayField && /[LW#]/i.test(t) && !/^[A-Za-z]{3}$/.test(t) && !(/^[A-Za-z]{3}-[A-Za-z]{3}$/.test(t))) {
    return scheduleFail('special', `${quote(t)}: L, W and # must be the whole ${spec.label.toLowerCase()} field. Quartz's documentation warns that combining them with lists or ranges gives unexpected results.`, piece.offset, t.length, spec.key);
  }
  if (t.startsWith('/')) return scheduleFail('step', `${quote(t)}: write */${t.slice(1)} or 0/${t.slice(1)} to say where the steps start.`, piece.offset, t.length, spec.key);
  const slash = t.indexOf('/');
  const baseText = slash < 0 ? t : t.slice(0, slash);
  let step = 1;
  if (slash >= 0) {
    const stepText = t.slice(slash + 1);
    const limit = spec.key === 'second' || spec.key === 'minute' ? 59 : spec.key === 'hour' ? 23 : spec.key === 'year' ? 129 : spec.max;
    if (!isDigits(stepText)) return scheduleFail('step', `The step after "/" must be a whole number, not ${quote(stepText)}.`, piece.offset + slash + 1, Math.max(1, stepText.length), spec.key);
    step = Number(stepText);
    if (step === 0 || step > limit) return scheduleFail('step', `A step of ${stepText} is not allowed in ${spec.label.toLowerCase()}: use 1 to ${limit}.`, piece.offset + slash + 1, stepText.length, spec.key);
    const dash = baseText.indexOf('-');
    if ((dash >= 0 && (isName(baseText.slice(0, dash)) || isName(baseText.slice(dash + 1)))) || isName(baseText)) {
      return scheduleFail('unsupported', `${quote(t)}: NetForge does not accept a step after names in Quartz. Write it with numbers (for example 2-6/2).`, piece.offset, t.length, spec.key);
    }
  }
  if (baseText === '*') {
    const from = spec.min;
    const values: number[] = [];
    for (let v = from; v <= spec.max; v += step) values.push(v);
    return ok({ item: { kind: 'all', step }, values });
  }
  const dash = baseText.indexOf('-');
  if (dash < 0) {
    const n = parseNumber({ text: baseText, offset: piece.offset }, spec);
    if (!n.ok) return n;
    if (slash < 0) return ok({ item: { kind: 'value', value: n.value }, values: [n.value] });
    const values: number[] = [];
    for (let v = n.value; v <= spec.max; v += step) values.push(v);
    return ok({ item: { kind: 'from', from: n.value, step }, values });
  }
  const a = parseNumber({ text: baseText.slice(0, dash), offset: piece.offset }, spec);
  if (!a.ok) return a;
  const b = parseNumber({ text: baseText.slice(dash + 1), offset: piece.offset + dash + 1 }, spec);
  if (!b.ok) return b;
  if (isName(baseText.slice(0, dash)) !== isName(baseText.slice(dash + 1))) {
    return scheduleFail('name', `${quote(baseText)}: Quartz reads a range of names only as NAME-NAME (MON-FRI) and a range of numbers as n-n (2-6); it does not mix them.`, piece.offset, baseText.length, spec.key);
  }
  if (a.value > b.value) {
    return scheduleFail('reversed-range', `${quote(baseText)} runs backwards. Quartz versions treat wrapping ranges differently, so NetForge does not accept them: split it, for example ${spec.key === 'day-of-week' ? 'FRI-SAT,SUN-MON' : '22-23,0-2'}.`, piece.offset, baseText.length, spec.key);
  }
  const values: number[] = [];
  for (let v = a.value; v <= b.value; v += step) values.push(v);
  return ok({ item: { kind: 'range', from: a.value, to: b.value, step }, values });
}

function parseList(piece: Piece, spec: FieldSpec, warnings: string[]): R<QuartzField> {
  const items: Item[] = [];
  const values: number[] = [];
  for (const part of splitPiece(piece, ',')) {
    const r = parseItem(part, spec);
    if (!r.ok) return r;
    items.push(r.value.item);
    values.push(...r.value.values);
    const it = r.value.item;
    if (it.kind !== 'value' && r.value.values.length === 1 && 'step' in it && it.step > 1) {
      warnings.push(`${spec.label} ${quote(part.text)}: the step ${it.step} leaves only one value, ${r.value.values[0]}.`);
    }
  }
  const unique = sortedUnique(values);
  return ok({ key: spec.key, label: spec.label, text: piece.text, offset: piece.offset, items, values: unique, full: unique.length === spec.max - spec.min + 1, noSpecific: false });
}

function noSpecificField(piece: Piece, spec: FieldSpec): QuartzField {
  return { key: spec.key, label: spec.label, text: '?', offset: piece.offset, items: [], values: [], full: false, noSpecific: true };
}

function parseDom(piece: Piece, spec: FieldSpec, warnings: string[]): R<{ field: QuartzField; special: DomSpecial | null }> {
  const t = piece.text.toUpperCase();
  const field = (special: DomSpecial): R<{ field: QuartzField; special: DomSpecial | null }> =>
    ok({ field: { key: spec.key, label: spec.label, text: piece.text, offset: piece.offset, items: [], values: [], full: false, noSpecific: false }, special });
  if (t === 'L') return field({ kind: 'last', offset: 0 });
  if (t === 'LW') return field({ kind: 'last-weekday' });
  let m = /^L-([0-9]+)$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    if (n > 30) return scheduleFail('range', `L-${m[1]}: Quartz allows an offset of at most 30 days before the last day.`, piece.offset, t.length, spec.key);
    if (n >= 28) return scheduleFail('unsupported', `L-${n} would fall before the 1st in February, and Quartz does not document what happens then, so NetForge does not accept offsets of 28 or more.`, piece.offset, t.length, spec.key);
    return field({ kind: 'last', offset: n });
  }
  if (/^L-[0-9]+W$/.test(t)) return scheduleFail('unsupported', `${quote(piece.text)}: Quartz does not document combining an L-n offset with W, so NetForge does not accept it. LW (last weekday) and L-n are supported.`, piece.offset, t.length, spec.key);
  m = /^([0-9]+)W$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 31) return scheduleFail('range', `${quote(piece.text)}: the day before W must be 1 to 31.`, piece.offset, t.length, spec.key);
    if (n > 28) return scheduleFail('unsupported', `${n}W: some months have no day ${n}, and Quartz does not document what W does then, so NetForge accepts W only for days 1 to 28.`, piece.offset, t.length, spec.key);
    return field({ kind: 'nearest-weekday', day: n });
  }
  if (/W/.test(t) && !/^[A-Z]{3}$/.test(t)) return scheduleFail('special', `${quote(piece.text)}: W follows a single day (15W) or L (LW), and must be the whole field.`, piece.offset, t.length, spec.key);
  const r = parseList(piece, spec, warnings);
  if (!r.ok) return r;
  return ok({ field: r.value, special: null });
}

function parseDow(piece: Piece, spec: FieldSpec, warnings: string[]): R<{ field: QuartzField; special: DowSpecial | null }> {
  const t = piece.text.toUpperCase();
  const plainField = (text: string, values: number[]): QuartzField => ({ key: spec.key, label: spec.label, text, offset: piece.offset, items: values.map(v => ({ kind: 'value' as const, value: v })), values, full: false, noSpecific: false });
  if (t === 'L') return ok({ field: plainField(piece.text, [7]), special: null });
  const dowNumber = (text: string, offset: number): R<number> => parseNumber({ text, offset }, spec);
  let m = /^([0-9]+|[A-Z]{3})L$/.exec(t);
  if (m) {
    const d = dowNumber(m[1], piece.offset);
    if (!d.ok) return d;
    return ok({ field: { ...plainField(piece.text, []), items: [] }, special: { kind: 'last-of', dow: d.value } });
  }
  m = /^([0-9]+|[A-Z]{3})#([0-9]+)$/.exec(t);
  if (m) {
    const d = dowNumber(m[1], piece.offset);
    if (!d.ok) return d;
    const n = Number(m[2]);
    if (n < 1 || n > 5) return scheduleFail('range', `${quote(piece.text)}: the number after # must be 1 to 5.`, piece.offset + m[1].length + 1, m[2].length, spec.key);
    if (n === 5) warnings.push(`${WEEKDAY_NAMES[d.value - 1]} #5 exists only in months with five ${WEEKDAY_NAMES[d.value - 1]}s; other months have no run.`);
    return ok({ field: { ...plainField(piece.text, []), items: [] }, special: { kind: 'nth', dow: d.value, n } });
  }
  if (/[L#]/.test(t) && !/^[A-Z]{3}(-[A-Z]{3})?$/.test(t)) {
    return scheduleFail('special', `${quote(piece.text)}: write nL (last weekday n, for example 6L) or n#k (kth weekday n, for example 2#1) as the whole field.`, piece.offset, t.length, spec.key);
  }
  const r = parseList(piece, spec, warnings);
  if (!r.ok) return r;
  return ok({ field: r.value, special: null });
}

export function parseQuartz(input: string): R<QuartzSchedule> {
  const source = input.trim();
  if (source === '') return fail('empty', 'Enter a Quartz cron expression, such as 0 0/15 * * * ? or 0 0 9 ? * MON-FRI.');
  const pieces = words(input);
  if (source.startsWith('@')) return scheduleFail('cron-syntax', `${quote(pieces[0].text)} is a standard cron nickname; Quartz has none. Choose Standard cron, or write the fields, for example 0 0 0 * * ? for @daily.`, pieces[0].offset, pieces[0].text.length);
  if (pieces.length < 6 || pieces.length > 7) {
    const hint = pieces.length === 5
      ? ' Five fields look like standard cron: choose Standard cron to read it, or add the seconds field first.'
      : ' The fields are second, minute, hour, day of month, month, day of week and an optional year.';
    return scheduleFail('field-count', `Quartz expressions have 6 or 7 fields; this has ${pieces.length}.${hint}`, pieces[0].offset, source.length);
  }
  const warnings: string[] = [];
  const out: Partial<Record<QuartzFieldKey, QuartzField>> = {};
  for (const i of [0, 1, 2, 4]) {
    const r = parseList(pieces[i], SPECS[i], warnings);
    if (!r.ok) return r;
    out[SPECS[i].key] = r.value;
  }
  const domPiece = pieces[3];
  const dowPiece = pieces[5];
  const domQ = domPiece.text === '?';
  const dowQ = dowPiece.text === '?';
  if (domQ && dowQ) return scheduleFail('day-fields', 'Only one of day-of-month and day-of-week can be "?". Put the day rule in the other field.', dowPiece.offset, 1, 'day-of-week');
  if (!domQ && !dowQ) {
    return scheduleFail('day-fields', `Quartz needs "?" in either day-of-month or day-of-week: it does not implement both at once. For any day, write ${pieces.slice(0, 3).map(p => p.text).join(' ')} * ${pieces[4].text} ?${pieces[6] ? ` ${pieces[6].text}` : ''}.`, dowPiece.offset, dowPiece.text.length, 'day-of-week');
  }
  let domSpecial: DomSpecial | null = null;
  let dowSpecial: DowSpecial | null = null;
  if (domQ) out['day-of-month'] = noSpecificField(domPiece, SPECS[3]);
  else {
    const r = parseDom(domPiece, SPECS[3], warnings);
    if (!r.ok) return r;
    out['day-of-month'] = r.value.field;
    domSpecial = r.value.special;
  }
  if (dowQ) out['day-of-week'] = noSpecificField(dowPiece, SPECS[5]);
  else {
    const r = parseDow(dowPiece, SPECS[5], warnings);
    if (!r.ok) return r;
    out['day-of-week'] = r.value.field;
    dowSpecial = r.value.special;
  }
  let year: QuartzField | null = null;
  if (pieces[6]) {
    const r = parseList(pieces[6], SPECS[6], warnings);
    if (!r.ok) return r;
    year = r.value;
  }
  return ok({
    dialect: 'quartz', source,
    fields: { second: out.second!, minute: out.minute!, hour: out.hour!, 'day-of-month': out['day-of-month']!, month: out.month!, 'day-of-week': out['day-of-week']!, year },
    domSpecial, dowSpecial, dayField: domQ ? 'day-of-week' : 'day-of-month', warnings,
  });
}

export function quartzPattern(s: QuartzSchedule): CalendarPattern {
  const f = s.fields;
  const years = f.year ? new Set(f.year.values) : null;
  let dayMatches: CalendarPattern['dayMatches'];
  if (s.dayField === 'day-of-month') {
    const sp = s.domSpecial;
    if (!sp) {
      const days = new Set(f['day-of-month'].values);
      dayMatches = (_y, _m, d) => days.has(d);
    } else if (sp.kind === 'last') dayMatches = (y, m, d) => d === daysInMonth(y, m) - sp.offset;
    else if (sp.kind === 'last-weekday') dayMatches = (y, m, d) => d === lastBusinessDay(y, m);
    else dayMatches = (y, m, d) => d === nearestWeekday(y, m, sp.day);
  } else {
    const sp = s.dowSpecial;
    if (!sp) {
      const dows = new Set(f['day-of-week'].values);
      dayMatches = (y, m, d) => dows.has(weekday(y, m, d) + 1);
    } else if (sp.kind === 'last-of') dayMatches = (y, m, d) => d === lastWeekday(y, m, sp.dow - 1);
    else dayMatches = (y, m, d) => d === nthWeekday(y, m, sp.dow - 1, sp.n);
  }
  return {
    seconds: f.second.values, minutes: f.minute.values, hours: f.hour.values,
    months: new Set(f.month.values), lastYear: QUARTZ_LAST_YEAR,
    yearMatches: years ? y => years.has(y) : () => true,
    dayMatches,
  };
}

const DOW_UNIT = weekdayUnit(1);
const tf = (f: QuartzField): TimeField => ({ items: f.items, values: f.values, full: f.full });

function domSpecialPhrase(sp: DomSpecial): string {
  if (sp.kind === 'last') return sp.offset === 0 ? 'on the last day of the month' : `${sp.offset} day${sp.offset === 1 ? '' : 's'} before the last day of the month`;
  if (sp.kind === 'last-weekday') return 'on the last weekday (Monday to Friday) of the month';
  return `on the weekday (Monday to Friday) nearest the ${ordinal(sp.day)} of the month`;
}

const NTH_WORDS = ['first', 'second', 'third', 'fourth', 'fifth'];

function dowSpecialPhrase(sp: DowSpecial): string {
  const name = WEEKDAY_NAMES[sp.dow - 1];
  return sp.kind === 'last-of' ? `on the last ${name} of the month` : `on the ${NTH_WORDS[sp.n - 1]} ${name} of the month`;
}

function dowListPhrase(f: QuartzField): string {
  const v = f.values;
  if (v.length === 5 && [2, 3, 4, 5, 6].every(x => v.includes(x))) return 'Monday through Friday';
  if (f.items.every(i => i.kind === 'value')) return joinList(v.map(x => WEEKDAY_NAMES[x - 1]));
  return describeItems(f.items, DOW_UNIT);
}

export function explainQuartz(s: QuartzSchedule): Explanation {
  const f = s.fields;
  const time = describeTimeOfDay(tf(f.second), tf(f.minute), tf(f.hour));
  let date = '';
  if (s.dayField === 'day-of-month') {
    if (s.domSpecial) date = domSpecialPhrase(s.domSpecial);
    else if (!f['day-of-month'].full) date = `on ${describeItems(f['day-of-month'].items, UNITS.day)} of the month`;
  } else if (s.dowSpecial) date = dowSpecialPhrase(s.dowSpecial);
  else if (!f['day-of-week'].full) date = `on ${dowListPhrase(f['day-of-week'])}`;
  const month = f.month.full ? '' : ` in ${f.month.items.every(i => i.kind === 'value') ? joinList(f.month.values.map(m => MONTH_NAMES[m - 1])) : describeItems(f.month.items, UNITS.month)}`;
  const year = f.year && !(f.year.full) ? `, ${f.year.items.every(i => i.kind === 'value') ? `in ${joinList(f.year.values.map(String))}` : describeItems(f.year.items, UNITS.year)}` : '';
  const summary = sentence(`${time}${date ? `, ${date}` : ''}${month}${year}`);

  const dom = f['day-of-month'];
  const dow = f['day-of-week'];
  const fields: FieldExplanation[] = [
    { field: 'Second', text: f.second.text, meaning: f.second.full ? 'every second' : describeItems(f.second.items, UNITS.second), values: compactList(f.second.values) },
    { field: 'Minute', text: f.minute.text, meaning: f.minute.full ? 'every minute' : describeItems(f.minute.items, UNITS.minute), values: compactList(f.minute.values) },
    { field: 'Hour', text: f.hour.text, meaning: f.hour.full ? 'every hour' : describeItems(f.hour.items, UNITS.hour), values: compactList(f.hour.values) },
    {
      field: 'Day of month', text: dom.text,
      meaning: dom.noSpecific ? 'no specific value (the day-of-week field decides)' : s.domSpecial ? domSpecialPhrase(s.domSpecial).replace(/^on /, '') : dom.full ? 'any day of the month' : describeItems(dom.items, UNITS.day),
      values: dom.noSpecific ? '?' : s.domSpecial ? rule(s.domSpecial) : compactList(dom.values),
    },
    { field: 'Month', text: f.month.text, meaning: f.month.full ? 'every month' : describeItems(f.month.items, UNITS.month), values: f.month.full ? 'all' : f.month.values.map(m => MONTH_NAMES[m - 1].slice(0, 3)).join(', ') },
    {
      field: 'Day of week', text: dow.text,
      meaning: dow.noSpecific ? 'no specific value (the day-of-month field decides)' : s.dowSpecial ? dowSpecialPhrase(s.dowSpecial).replace(/^on /, '') : dow.full ? 'any day of the week' : describeItems(dow.items, DOW_UNIT),
      values: dow.noSpecific ? '?' : s.dowSpecial ? (s.dowSpecial.kind === 'last-of' ? `last ${WEEKDAY_NAMES[s.dowSpecial.dow - 1].slice(0, 3)}` : `${ordinal(s.dowSpecial.n)} ${WEEKDAY_NAMES[s.dowSpecial.dow - 1].slice(0, 3)}`) : dow.full ? 'all' : dow.values.map(v => `${WEEKDAY_NAMES[v - 1].slice(0, 3)} (${v})`).join(', '),
    },
  ];
  if (f.year) fields.push({ field: 'Year', text: f.year.text, meaning: f.year.full ? 'every year to 2099' : describeItems(f.year.items, UNITS.year), values: compactList(f.year.values) });

  const warnings = [...s.warnings];
  if (s.domSpecial?.kind === 'last' && s.domSpecial.offset > 0) {
    warnings.push(`L-${s.domSpecial.offset} is the day ${s.domSpecial.offset} day${s.domSpecial.offset === 1 ? '' : 's'} before the last day (the ${ordinal(31 - s.domSpecial.offset)} in a 31-day month). Quartz's documentation calls L-3 "the third-to-last day", but Quartz counts back from the last day, which NetForge follows.`);
  }
  if (!s.domSpecial && s.dayField === 'day-of-month' && dom.items.every(i => i.kind === 'value')) {
    const maxDay = Math.max(...dom.values);
    const longest = Math.max(...f.month.values.map(m => (m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31)));
    if (Math.min(...dom.values) > longest) warnings.push(`None of the selected months has day ${Math.min(...dom.values)}, so this never runs.`);
    else if (maxDay >= 29) warnings.push(`Day ${maxDay} does not exist in every month; Quartz skips months without it. Use L for the last day.`);
  }
  for (const key of ['second', 'minute', 'hour'] as const) {
    const field = f[key];
    const span = key === 'hour' ? 24 : 60;
    for (const it of field.items) {
      const from = it.kind === 'all' ? 0 : it.kind === 'from' ? it.from : -1;
      if (from === 0 && 'step' in it && it.step > 1 && span % it.step !== 0) {
        const last = Math.floor((span - 1) / it.step) * it.step;
        warnings.push(`${field.label} step ${it.step} does not divide ${span}: after ${key} ${last} the next run is at ${key} 0, ${span - last} ${key}s later, not ${it.step}.`);
      }
    }
  }
  const notes = [
    'Read as a Quartz cron expression: second, minute, hour, day of month, month, day of week (1 = Sunday to 7 = Saturday), optional year (Quartz Scheduler 2.x).',
    'Quartz takes the time zone from the trigger (CronScheduleBuilder.inTimeZone), not from the expression; without one it uses the JVM default zone. NetForge evaluates it in the zone you select.',
    `NetForge lists Quartz runs up to ${QUARTZ_LAST_YEAR}, the last year the Quartz year field accepts.`,
  ];
  if (dow.text.toUpperCase() === 'L') notes.push('L alone in the day-of-week field means 7, Saturday (not "last").');
  return { summary, fields, warnings, notes, normalized: null };
}

function rule(sp: DomSpecial): string {
  if (sp.kind === 'last') return sp.offset === 0 ? 'last day' : `last day - ${sp.offset}`;
  if (sp.kind === 'last-weekday') return 'last weekday';
  return `weekday nearest ${sp.day}`;
}

export const QUARTZ_DST_POLICY: DstPolicy = {
  nonexistent: 'uncertain',
  repeatedFirst: 'uncertain',
  repeatedSecond: 'uncertain',
  basis: 'the Quartz documentation says only that DST changes "can cause a skip or a repeat"',
  nonexistentNote: 'This local time does not exist. Quartz documents only that a DST change can cause a skip or a repeat; the outcome depends on the Quartz version and the JVM.',
  repeatedNote: 'This local time happens twice. Quartz documents only that a DST change can cause a skip or a repeat; whether it fires once or twice depends on the Quartz version and the JVM.',
};
