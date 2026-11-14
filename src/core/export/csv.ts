/** RFC 4180 CSV output. */

export type CsvCell = string | number | bigint | boolean | null | undefined;

export interface CsvOptions {
  /**
   * Prefix text cells that start with = + - @ tab or CR with an apostrophe, so a spreadsheet does
   * not run them as formulas (CSV injection). On by default; numbers are never changed.
   */
  readonly guardFormulas?: boolean;
}

const FORMULA_START = new Set(['=', '+', '-', '@', String.fromCharCode(0x09), String.fromCharCode(0x0d)]);
const QUOTE = '"';
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const CRLF = CR + LF;

export function csvCell(value: CsvCell, options: CsvOptions = {}): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Cannot write ${value} to CSV`);
    return String(value);
  }
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  let text = value;
  if ((options.guardFormulas ?? true) && text.length > 0 && FORMULA_START.has(text[0])) text = `'${text}`;
  if (text.includes(QUOTE) || text.includes(',') || text.includes(CR) || text.includes(LF)) {
    return QUOTE + text.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
  }
  return text;
}

/** Rows joined with CRLF and ending in CRLF, as RFC 4180 describes. */
export function toCsv(rows: readonly (readonly CsvCell[])[], options: CsvOptions = {}): string {
  return rows.map(row => row.map(cell => csvCell(cell, options)).join(',')).join(CRLF) + CRLF;
}
