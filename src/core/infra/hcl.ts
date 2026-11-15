/**
 * A small writer for HCL (Terraform's configuration syntax, native syntax specification).
 *
 * Strings are quoted templates. Inside one, a backslash and a double quote are escaped, line
 * breaks and tabs use their escapes, every other control or invisible formatting character is
 * written as \uNNNN, and the two template openers are neutralized: "${" becomes "$${" and "%{"
 * becomes "%%{", so plan text can never be evaluated as an expression. A lone surrogate cannot be
 * stored in a UTF-8 file, so a string that has one is refused.
 */

/** Characters written as \u escapes: C0, DEL, C1, line and paragraph separators, bidirectional controls, the BOM. */
const ch = (code: number) => String.fromCharCode(code);
const ESCAPED = new RegExp(`[\x00-\x1f\x7f-\x9f${ch(0x2028)}${ch(0x2029)}${ch(0x200e)}${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}${ch(0xfeff)}]`);

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** An HCL quoted string, or null when the text has a lone surrogate. */
export function hclString(text: string): string | null {
  if (hasLoneSurrogate(text)) return null;
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if ((ch === '$' || ch === '%') && text[i + 1] === '{') out += ch + ch;
    else if (ESCAPED.test(ch)) out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isHclIdentifier(text: string): boolean {
  return IDENTIFIER.test(text);
}

/** Raw HCL (a reference such as var.x["k"]) inside a value tree. */
export class HclRaw {
  constructor(readonly text: string) {}
}

export type HclValue = string | number | boolean | null | HclRaw | readonly HclValue[] | { readonly [key: string]: HclValue };

/**
 * A value as HCL, laid out the way "terraform fmt" lays it out. Object keys that are identifiers
 * are written bare and every other key is quoted. Throws on a string with a lone surrogate: callers check with hclString first.
 */
export function hclValue(value: HclValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  if (value instanceof HclRaw) return value.text;
  if (typeof value === 'string') {
    const s = hclString(value);
    if (s === null) throw new Error('lone surrogate in an HCL string');
    return s;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('HCL numbers written here are whole numbers');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const list = value as readonly HclValue[];
    if (list.length === 0) return '[]';
    if (list.every(v => typeof v === 'string' || typeof v === 'number')) return `[${list.map(v => hclValue(v)).join(', ')}]`;
    return `[\n${list.map(v => `${inner}${hclValue(v, indent + 1)},`).join('\n')}\n${pad}]`;
  }
  const entries = Object.entries(value as { readonly [key: string]: HclValue });
  if (entries.length === 0) return '{}';
  const keys = entries.map(([k]) => (isHclIdentifier(k) ? k : hclValue(k)));
  const values = entries.map(([, v]) => hclValue(v, indent + 1));
  // The layout "terraform fmt" produces: equals signs line up within each run of consecutive
  // one-line attributes. An attribute whose value spans lines ends the run and is not padded.
  const widths = keys.map(() => 0);
  for (let start = 0; start < keys.length;) {
    let end = start;
    let width = 0;
    while (end < keys.length && !values[end]!.includes('\n')) width = Math.max(width, keys[end++]!.length);
    for (let i = start; i < end; i++) widths[i] = width;
    start = end === start ? start + 1 : end;
  }
  return `{\n${keys.map((k, i) => `${inner}${k.padEnd(widths[i]!)} = ${values[i]!}`).join('\n')}\n${pad}}`;
}
