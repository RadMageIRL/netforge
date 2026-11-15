/**
 * Number Bases & Bytes settings links: the integer with its base, width, signedness and grouping,
 * and the storage amount with its unit. A value is shared only when it converts, and a link's
 * value is used only when it converts again here.
 */
import { BASE_NAME, convert, NUMBER_LIMITS, type Base } from '../../core/numbers/bases';
import { convertAmount, UNIT_LIMITS, UNITS } from '../../core/numbers/units';
import { intIn, oneOf, onlyKeys, type ShareOffer } from '../../app/share';

export interface NumberShare {
  /** The number as typed (trimmed), or null to leave the field as it is. */
  readonly number: string | null;
  readonly base: Base;
  /** A bit width, or null for no fixed width. */
  readonly width: number | null;
  readonly signed: boolean;
  readonly group: 4 | 8;
  readonly amount: string | null;
  readonly unit: string;
}

const KEYS = ['n', 'base', 'width', 'sign', 'group', 'amount', 'unit'] as const;
const BASES = ['2', '8', '10', '16'] as const;
/** Longest number a link carries: 128 bits in binary with separators fits. */
export const MAX_NUMBER_CHARS = 200;
const UNIT_IDS = UNITS.map(u => u.id);

export function numberOffer(s: NumberShare): ShareOffer {
  const params: [string, string][] = [];
  const summary: string[] = [];
  if (s.number !== null) {
    if (s.number.length > MAX_NUMBER_CHARS) return { ok: false, reason: `Numbers longer than ${MAX_NUMBER_CHARS} characters are not put in links.` };
    if (!convert(s.number, { base: s.base, signed: s.signed, width: s.width }).ok) return { ok: false, reason: 'Fix the number to put it in a link.' };
    params.push(['n', s.number]);
    summary.push(`Number: ${s.number} (${BASE_NAME[s.base]})`);
  }
  params.push(['base', String(s.base)], ['width', s.width === null ? 'none' : String(s.width)], ['sign', s.signed ? 'signed' : 'unsigned'], ['group', String(s.group)]);
  summary.push(`${s.width === null ? 'No fixed width' : `${s.width} bits`}, ${s.signed ? 'signed' : 'unsigned'}, bits grouped by ${s.group}`);
  if (s.amount !== null) {
    if (!convertAmount(s.amount, s.unit).ok) return { ok: false, reason: 'Fix the storage amount to put it in a link.' };
    params.push(['amount', s.amount], ['unit', s.unit]);
    summary.push(`Storage amount: ${s.amount} ${s.unit}`);
  }
  return { ok: true, params, summary };
}

export function readNumberShare(params: ReadonlyMap<string, string>): NumberShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const base = params.has('base') ? oneOf(params.get('base'), BASES) : '10';
  const widthText = params.get('width');
  const width = widthText === undefined ? 32 : widthText === 'none' ? null : intIn(widthText, NUMBER_LIMITS.minWidth, NUMBER_LIMITS.maxWidth);
  const sign = params.has('sign') ? oneOf(params.get('sign'), ['signed', 'unsigned'] as const) : 'unsigned';
  const group = params.has('group') ? oneOf(params.get('group'), ['4', '8'] as const) : '4';
  if (base === null || (widthText !== undefined && widthText !== 'none' && width === null) || sign === null || group === null) return null;
  const number = params.get('n') ?? null;
  const signed = sign === 'signed';
  if (number !== null && (number.trim() === '' || number.length > MAX_NUMBER_CHARS || !convert(number, { base: Number(base) as Base, signed, width }).ok)) return null;
  const amount = params.get('amount') ?? null;
  const unitText = params.get('unit');
  if (amount === null && unitText !== undefined) return null;
  const unit = unitText === undefined ? 'GiB' : oneOf(unitText, UNIT_IDS);
  if (unit === null) return null;
  if (amount !== null && (amount.trim() === '' || amount.length > UNIT_LIMITS.amountChars || !convertAmount(amount, unit).ok)) return null;
  return { number, base: Number(base) as Base, width, signed, group: group === '8' ? 8 : 4, amount, unit };
}
