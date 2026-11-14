/**
 * Number Bases & Bytes: integers in binary, octal, decimal and hexadecimal at a chosen bit width,
 * signed or unsigned, with byte order, and exact conversion between storage units.
 * Everything is BigInt arithmetic in the page; nothing is stored or sent.
 */
import { formatInteger } from '../../core/format';
import {
  BASE_NAME, convert, groupDigits, NUMBER_LIMITS, STANDARD_WIDTHS, widthRange, withPrefix, type Base, type Conversion,
} from '../../core/numbers/bases';
import { convertAmount, UNIT_LIMITS, UNITS, type UnitConversion } from '../../core/numbers/units';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, panel, resultTable, segmented, selectField, textField, toolPage, type ResultRow } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { noteList, numberField, statusLine } from '../util-shared/util-view';

const BASE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '10', label: 'Decimal (base 10)' },
  { value: '16', label: 'Hexadecimal (base 16)' },
  { value: '2', label: 'Binary (base 2)' },
  { value: '8', label: 'Octal (base 8)' },
];

const WIDTH_OPTIONS: readonly { value: string; label: string }[] = [
  ...STANDARD_WIDTHS.map(w => ({ value: String(w), label: `${w} bits` })),
  { value: 'custom', label: 'Custom width' },
  { value: 'none', label: 'No fixed width' },
];

function short(value: bigint): string {
  const s = value.toString();
  return s.length > 40 ? `${s.slice(0, 10)}...${s.slice(-6)} (${s.replace('-', '').length} digits)` : formatInteger(value, 'en-US');
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let signed = false;
  let group = 4;

  const input = textField({ id: 'num-input', label: 'Number', mono: true, placeholder: '255, 0xff, 1111_1111', hint: 'Digits may be separated by spaces or underscores. A 0x, 0b or 0o prefix must agree with the input base.' });
  const baseField = selectField({ id: 'num-base', label: 'Input base', groups: [{ label: null, options: BASE_OPTIONS }], value: '10' });
  const widthField = selectField({ id: 'num-width', label: 'Bit width', groups: [{ label: null, options: WIDTH_OPTIONS }], value: '32' });
  const customWidth = numberField({ id: 'num-custom-width', label: 'Custom width in bits', value: '24', hint: `${NUMBER_LIMITS.minWidth} to ${formatInteger(NUMBER_LIMITS.maxWidth)}`, onInput: () => renderNumber() });
  const signControl = segmented({
    label: 'Read as', name: 'num-sign', value: 'unsigned',
    choices: [{ value: 'unsigned', label: 'Unsigned' }, { value: 'signed', label: 'Signed' }],
    onChange: value => { signed = value === 'signed'; renderNumber(); },
  });
  const groupControl = segmented({
    label: 'Group bits by', name: 'num-group', value: '4',
    choices: [{ value: '4', label: '4' }, { value: '8', label: '8' }],
    onChange: value => { group = Number(value); renderNumber(); },
  });
  const numberStatus = h('div', { class: 'json-status', id: 'num-status', role: 'status' });
  const numberResult = h('div', { id: 'num-result', class: 'result-section' });

  function width(): number | null | 'invalid' {
    const choice = widthField.control.value;
    if (choice === 'none') return null;
    if (choice !== 'custom') return Number(choice);
    const text = customWidth.control.value.trim();
    const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
    if (!(n >= NUMBER_LIMITS.minWidth && n <= NUMBER_LIMITS.maxWidth)) return 'invalid';
    return n;
  }

  function numberRows(c: Conversion): ResultRow[] {
    const rows: ResultRow[] = [
      { key: 'decimal', label: 'Decimal', value: c.decimal, note: c.width === null ? undefined : c.signed ? 'signed reading' : 'unsigned reading' },
      { key: 'hex', label: 'Hexadecimal', value: withPrefix(c.hex, 16), copy: c.hex },
      { key: 'binary', label: 'Binary', value: groupDigits(c.binary, group), copy: c.binary, note: c.width === null ? undefined : `${c.width} ${c.width === 1 ? 'bit' : 'bits'}, most significant first` },
      { key: 'octal', label: 'Octal', value: withPrefix(c.octal, 8), copy: c.octal },
    ];
    if (c.unsignedReading !== null && c.signedReading !== null) {
      rows.push(
        { key: 'unsigned', label: 'Same bits, unsigned', value: c.unsignedReading.toString() },
        { key: 'signed', label: "Same bits, signed (two's complement)", value: c.signedReading.toString() },
      );
    }
    if (c.bytesBigEndian && c.bytesLittleEndian) {
      rows.push(
        { key: 'bytes-be', label: 'Bytes, big-endian', value: c.bytesBigEndian.join(' '), note: 'most significant byte first (network byte order)' },
        { key: 'bytes-le', label: 'Bytes, little-endian', value: c.bytesLittleEndian.join(' '), note: 'least significant byte first (x86 and most ARM systems)' },
      );
    }
    rows.push({ key: 'bits-needed', label: 'Bits needed', value: String(c.bitsNeeded), note: `fewest bits that hold this value ${c.signed ? 'signed' : 'unsigned'}`, copy: null });
    if (c.bytesBigEndian) rows.push({ key: 'byte-count', label: 'Bytes', value: String(c.bytesBigEndian.length), copy: null });
    return rows;
  }

  function renderNumber(): void {
    customWidth.root.hidden = widthField.control.value !== 'custom';
    input.setError(null);
    customWidth.setError(null);
    const text = input.control.value;
    const w = width();
    if (w === 'invalid') {
      customWidth.setError(`Enter a whole number from ${NUMBER_LIMITS.minWidth} to ${NUMBER_LIMITS.maxWidth}.`);
      replaceChildren(numberStatus);
      replaceChildren(numberResult);
      return;
    }
    if (text.trim() === '') {
      replaceChildren(numberStatus);
      replaceChildren(numberResult, h('p', { class: 'empty-state' }, 'Enter a number to see it in every base.'));
      return;
    }
    const base = Number(baseField.control.value) as Base;
    const result = convert(text, { base, signed, width: w });
    if (!result.ok) {
      input.setError(result.error.message);
      replaceChildren(numberStatus, statusLine('error', 'Not converted', result.error.offset === undefined ? undefined : `position ${result.error.offset + 1}`));
      replaceChildren(numberResult);
      return;
    }
    const c = result.value;
    const range = w === null ? null : widthRange(w, signed);
    replaceChildren(numberStatus, statusLine('ok', `${BASE_NAME[base].charAt(0).toUpperCase()}${BASE_NAME[base].slice(1)} input read`,
      range ? `${w}-bit ${signed ? 'signed' : 'unsigned'}: ${short(range.min)} to ${short(range.max)}` : `no fixed width, ${signed ? 'signed' : 'unsigned'}`));
    replaceChildren(numberResult,
      resultTable('The number in each base', numberRows(c), services),
      c.bytesNote ? h('p', { class: 'source-note', id: 'num-bytes-note' }, c.bytesNote) : null,
      noteList(c.notes, 'num-notes'),
    );
  }

  input.control.addEventListener('input', renderNumber);
  baseField.control.addEventListener('change', renderNumber);
  widthField.control.addEventListener('change', renderNumber);
  const example = button({ label: 'Example', variant: 'ghost', onClick: () => {
    input.control.value = '-2';
    baseField.control.value = '10';
    widthField.control.value = '16';
    signed = true;
    signControl.set('signed');
    renderNumber();
  } });
  const clearNumber = button({ label: 'Clear', variant: 'ghost', onClick: () => { input.control.value = ''; renderNumber(); input.control.focus(); } });

  // Storage units
  const amount = textField({ id: 'unit-amount', label: 'Amount', mono: true, placeholder: '1.5', hint: `A plain decimal number, up to ${UNIT_LIMITS.amountChars} characters.` });
  const unitField = selectField({
    id: 'unit-from', label: 'Unit', value: 'GiB',
    groups: [
      { label: null, options: UNITS.filter(u => u.family === 'base').map(u => ({ value: u.id, label: `${u.id} (${u.name})` })) },
      { label: 'Decimal: powers of 1000', options: UNITS.filter(u => u.family === 'decimal').map(u => ({ value: u.id, label: `${u.id} (${u.name})` })) },
      { label: 'Binary: powers of 1024', options: UNITS.filter(u => u.family === 'binary').map(u => ({ value: u.id, label: `${u.id} (${u.name})` })) },
    ],
  });
  const unitStatus = h('div', { class: 'json-status', id: 'unit-status', role: 'status' });
  const unitResult = h('div', { id: 'unit-result', class: 'result-section' });

  function unitRows(c: UnitConversion): ResultRow[] {
    return c.rows.map(row => ({
      key: `unit-${row.unit.id}`,
      label: `${row.unit.id} (${row.unit.name}s)`,
      value: row.exact,
      note: row.rounded === null ? undefined : `exact; about ${row.rounded} rounded to ${UNIT_LIMITS.roundedDigits} significant digits`,
    }));
  }

  function renderUnits(): void {
    amount.setError(null);
    if (amount.control.value.trim() === '') {
      replaceChildren(unitStatus);
      replaceChildren(unitResult, h('p', { class: 'empty-state' }, 'Enter an amount to see it in every unit.'));
      return;
    }
    const result = convertAmount(amount.control.value, unitField.control.value);
    if (!result.ok) {
      amount.setError(result.error.message);
      replaceChildren(unitStatus);
      replaceChildren(unitResult);
      return;
    }
    const c = result.value;
    const detail = c.wholeBytes !== null
      ? `exactly ${formatInteger(c.wholeBytes, 'en-US')} ${c.wholeBytes === 1n ? 'byte' : 'bytes'}`
      : c.wholeBits !== null ? `${formatInteger(c.wholeBits, 'en-US')} ${c.wholeBits === 1n ? 'bit' : 'bits'}, which is not a whole number of bytes` : 'not a whole number of bits';
    replaceChildren(unitStatus, statusLine('ok', `${amount.control.value.trim()} ${c.from.id}`, detail));
    replaceChildren(unitResult, resultTable('The amount in each unit', unitRows(c), services));
  }

  amount.control.addEventListener('input', renderUnits);
  unitField.control.addEventListener('change', renderUnits);

  host.appendChild(toolPage(meta, categoryName,
    panel('Integer', [
      h('div', { class: 'controls-row' }, input.root, baseField.root),
      h('div', { class: 'controls-row' }, widthField.root, customWidth.root, signControl.root, groupControl.root),
    ], [example, clearNumber]),
    numberStatus,
    panel('In every base', [
      numberResult,
      h('p', { class: 'source-note' }, 'Decimal input is a value and must fit the width. Binary, octal and hexadecimal input is a bit pattern: in signed mode a pattern whose top bit is set is a negative number. All arithmetic is exact, at any size.'),
    ], undefined, 'result-panel'),
    panel('Storage units', [
      h('div', { class: 'controls-row' }, amount.root, unitField.root),
      unitStatus,
      unitResult,
      h('p', { class: 'source-note' }, 'Decimal units (kB, MB, GB) are powers of 1000 bytes; binary units (KiB, MiB, GiB) are powers of 1024 bytes. Operating systems and vendors often write "GB" for either, which is why a 500 GB disk shows as about 465 GiB. A byte is 8 bits. Every figure is exact unless it says rounded.'),
    ]),
  ));
  renderNumber();
  renderUnits();
}
