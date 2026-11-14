/**
 * Line-oriented text operations: trim, drop blank lines, change case, remove duplicates, sort,
 * add prefixes, suffixes and numbers, compare two lists, and count things. Each operation runs
 * only when asked for; with every option off, the text comes back exactly as it went in.
 *
 * Comparisons are the same on every device: by Unicode code point, or by lowercase form when case
 * is ignored. No locale-dependent collation is used, so results never vary with browser language.
 */
import { utf8Length } from '../format';

export const TEXT_LIMITS = { chars: 5_000_000, lines: 200_000 } as const;

export type Eol = '\n' | '\r\n' | '\r';

export interface LineDoc {
  readonly lines: string[];
  /** The line ending used when the text is put back together: the first one found. */
  readonly eol: Eol;
  /** True when the text mixes line endings; the output then uses `eol` throughout. */
  readonly mixedEol: boolean;
  /** True when the text ends with a line ending. */
  readonly finalEol: boolean;
}

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);

/** Splits text into lines. LF, CRLF and a lone CR each end a line. An empty text has no lines. */
export function splitLines(text: string): LineDoc {
  const lines: string[] = [];
  let eol: Eol | null = null;
  let mixedEol = false;
  let start = 0;
  let finalEol = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let found: Eol | null = null;
    if (code === 0x0a) found = LF as Eol;
    else if (code === 0x0d) found = (text.charCodeAt(i + 1) === 0x0a ? CR + LF : CR) as Eol;
    if (found === null) continue;
    lines.push(text.slice(start, i));
    if (eol === null) eol = found;
    else if (eol !== found) mixedEol = true;
    i += found.length - 1;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  else finalEol = text.length > 0;
  return { lines, eol: eol ?? (LF as Eol), mixedEol, finalEol };
}

export function joinLines(lines: readonly string[], doc: Pick<LineDoc, 'eol' | 'finalEol'>): string {
  if (lines.length === 0) return '';
  return lines.join(doc.eol) + (doc.finalEol ? doc.eol : '');
}

/** Orders two UTF-16 units the way their code points order, so astral characters sort last. */
function fixUnit(unit: number): number {
  if (unit < 0xd800) return unit;
  return unit >= 0xe000 ? unit - 0x800 : unit + 0x2000;
}

/** Compares strings by Unicode code point (not by UTF-16 unit, which misplaces astral characters). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return fixUnit(x) - fixUnit(y);
  }
  return a.length - b.length;
}

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/**
 * Natural order: runs of ASCII digits compare as whole numbers (so "item 9" sorts before
 * "item 10"), everything else by code point. Numbers of equal value order by length ("7" before "007").
 */
export function compareNatural(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(j);
    if (isDigit(x) && isDigit(y)) {
      let ie = i;
      while (ie < a.length && isDigit(a.charCodeAt(ie))) ie++;
      let je = j;
      while (je < b.length && isDigit(b.charCodeAt(je))) je++;
      let is = i;
      while (is < ie - 1 && a.charCodeAt(is) === 0x30) is++;
      let js = j;
      while (js < je - 1 && b.charCodeAt(js) === 0x30) js++;
      if (ie - is !== je - js) return (ie - is) - (je - js);
      for (let k = 0; k < ie - is; k++) {
        const d = a.charCodeAt(is + k) - b.charCodeAt(js + k);
        if (d !== 0) return d;
      }
      if (ie - i !== je - j) return (ie - i) - (je - j);
      i = ie;
      j = je;
    } else {
      if (x !== y) return fixUnit(x) - fixUnit(y);
      i++;
      j++;
    }
  }
  return (a.length - i) - (b.length - j);
}

export type TrimMode = 'none' | 'both' | 'start' | 'end';
export type CaseMode = 'none' | 'lower' | 'upper';
export type SortMode = 'none' | 'text' | 'natural' | 'length';

export interface TransformOptions {
  readonly trim: TrimMode;
  /** Remove lines that are empty or hold only whitespace. */
  readonly removeEmpty: boolean;
  readonly changeCase: CaseMode;
  /** Keep the first of each set of equal lines. */
  readonly dedupe: boolean;
  readonly sort: SortMode;
  readonly descending: boolean;
  /** Sorting and duplicate detection treat upper and lower case as equal. */
  readonly ignoreCase: boolean;
  readonly prefix: string;
  readonly suffix: string;
  readonly number: boolean;
  readonly numberStart: number;
  readonly numberSeparator: string;
  /** Pad numbers with leading zeros to the width of the largest. */
  readonly numberPad: boolean;
}

export const DEFAULT_TRANSFORM: TransformOptions = {
  trim: 'none', removeEmpty: false, changeCase: 'none', dedupe: false, sort: 'none', descending: false, ignoreCase: false,
  prefix: '', suffix: '', number: false, numberStart: 1, numberSeparator: '. ', numberPad: false,
};

export type TextErrorCode = 'too-large' | 'too-many-lines' | 'number-start';

export type TransformResult =
  | { readonly ok: false; readonly code: TextErrorCode; readonly message: string }
  | {
      readonly ok: true;
      readonly output: string;
      readonly linesIn: number;
      readonly linesOut: number;
      readonly emptyRemoved: number;
      readonly duplicatesRemoved: number;
      /** What was done, in the order it was done. Empty when nothing was asked for. */
      readonly steps: readonly string[];
      readonly mixedEol: boolean;
    };

function sizeProblem(text: string, lineCount: number | null): { code: TextErrorCode; message: string } | null {
  if (text.length > TEXT_LIMITS.chars) {
    return { code: 'too-large', message: `The text has ${text.length.toLocaleString('en-US')} characters; the limit is ${TEXT_LIMITS.chars.toLocaleString('en-US')}. Nothing was changed.` };
  }
  if (lineCount !== null && lineCount > TEXT_LIMITS.lines) {
    return { code: 'too-many-lines', message: `The text has ${lineCount.toLocaleString('en-US')} lines; the limit is ${TEXT_LIMITS.lines.toLocaleString('en-US')}. Nothing was changed.` };
  }
  return null;
}

const foldKey = (line: string, ignoreCase: boolean) => (ignoreCase ? line.toLowerCase() : line);

/**
 * Applies the selected operations in a fixed order: trim, remove empty lines, change case, remove
 * duplicates, sort, add prefix and suffix, number. Sorting is stable: lines that compare equal
 * keep their original order.
 */
export function transformLines(text: string, options: TransformOptions): TransformResult {
  const tooLarge = sizeProblem(text, null);
  if (tooLarge) return { ok: false, ...tooLarge };
  const doc = splitLines(text);
  const tooMany = sizeProblem(text, doc.lines.length);
  if (tooMany) return { ok: false, ...tooMany };
  if (options.number && !Number.isSafeInteger(options.numberStart)) {
    return { ok: false, code: 'number-start', message: 'The first line number must be a whole number.' };
  }

  let lines = doc.lines;
  const linesIn = lines.length;
  const steps: string[] = [];

  if (options.trim !== 'none') {
    lines = lines.map(l => (options.trim === 'both' ? l.trim() : options.trim === 'start' ? l.trimStart() : l.trimEnd()));
    steps.push(options.trim === 'both' ? 'Trimmed whitespace from both ends of each line' : options.trim === 'start' ? 'Trimmed leading whitespace' : 'Trimmed trailing whitespace');
  }
  let emptyRemoved = 0;
  if (options.removeEmpty) {
    const kept = lines.filter(l => l.trim() !== '');
    emptyRemoved = lines.length - kept.length;
    lines = kept;
    steps.push(`Removed ${emptyRemoved} empty ${emptyRemoved === 1 ? 'line' : 'lines'}`);
  }
  if (options.changeCase !== 'none') {
    lines = lines.map(l => (options.changeCase === 'lower' ? l.toLowerCase() : l.toUpperCase()));
    steps.push(options.changeCase === 'lower' ? 'Changed to lowercase' : 'Changed to uppercase');
  }
  let duplicatesRemoved = 0;
  if (options.dedupe) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const line of lines) {
      const key = foldKey(line, options.ignoreCase);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(line);
    }
    duplicatesRemoved = lines.length - kept.length;
    lines = kept;
    steps.push(`Removed ${duplicatesRemoved} duplicate ${duplicatesRemoved === 1 ? 'line' : 'lines'}${options.ignoreCase ? ', ignoring case' : ''} (the first of each is kept)`);
  }
  if (options.sort !== 'none') {
    const keyed = lines.map((line, index) => ({ line, key: foldKey(line, options.ignoreCase), index }));
    const direction = options.descending ? -1 : 1;
    const compare = options.sort === 'natural'
      ? compareNatural
      : options.sort === 'length'
        ? (a: string, b: string) => [...a].length - [...b].length
        : compareCodePoints;
    if (options.sort === 'length') {
      const lengths = keyed.map(k => [...k.line].length);
      keyed.sort((a, b) => (direction * (lengths[a.index] - lengths[b.index])) || (a.index - b.index));
    } else {
      keyed.sort((a, b) => (direction * compare(a.key, b.key)) || (a.index - b.index));
    }
    lines = keyed.map(k => k.line);
    const how = options.sort === 'natural' ? 'in natural order (numbers by value)' : options.sort === 'length' ? 'by length' : 'by character code';
    steps.push(`Sorted ${how}, ${options.descending ? 'descending' : 'ascending'}${options.ignoreCase && options.sort !== 'length' ? ', ignoring case' : ''}`);
  }
  if (options.prefix !== '' || options.suffix !== '') {
    lines = lines.map(l => options.prefix + l + options.suffix);
    steps.push(options.prefix !== '' && options.suffix !== '' ? 'Added the prefix and suffix' : options.prefix !== '' ? 'Added the prefix' : 'Added the suffix');
  }
  if (options.number) {
    const last = options.numberStart + lines.length - 1;
    const width = options.numberPad ? Math.max(String(Math.abs(options.numberStart)).length, String(Math.abs(last)).length) : 0;
    lines = lines.map((l, i) => {
      const n = options.numberStart + i;
      const digits = String(Math.abs(n)).padStart(width, '0');
      return `${n < 0 ? '-' : ''}${digits}${options.numberSeparator}${l}`;
    });
    steps.push(`Numbered the lines from ${options.numberStart}`);
  }

  // With nothing asked for, return the input itself: not even mixed line endings are touched.
  const output = steps.length === 0 ? text : joinLines(lines, doc);
  if (output.length > TEXT_LIMITS.chars * 2) {
    return { ok: false, code: 'too-large', message: `The result would have ${output.length.toLocaleString('en-US')} characters, more than the limit of ${(TEXT_LIMITS.chars * 2).toLocaleString('en-US')}. Shorten the prefix or suffix.` };
  }
  return { ok: true, output, linesIn, linesOut: lines.length, emptyRemoved, duplicatesRemoved, steps, mixedEol: doc.mixedEol && steps.length > 0 };
}

export interface CompareOptions {
  readonly ignoreCase: boolean;
  /** Compare lines without their leading and trailing whitespace. */
  readonly trim: boolean;
  /** Leave out lines that are empty or only whitespace. */
  readonly ignoreEmpty: boolean;
}

export type CompareResult =
  | { readonly ok: false; readonly code: TextErrorCode; readonly message: string }
  | {
      readonly ok: true;
      /** In both lists (intersection), in list A's order and spelling. */
      readonly both: readonly string[];
      /** In A but not in B (difference), in A's order. */
      readonly onlyA: readonly string[];
      /** In B but not in A, in B's order. */
      readonly onlyB: readonly string[];
      /** Everything in either list (union): A's items, then B's that A lacks. */
      readonly union: readonly string[];
      /** Distinct items in each list, and repeated lines that were counted once. */
      readonly uniqueA: number;
      readonly uniqueB: number;
      readonly repeatsA: number;
      readonly repeatsB: number;
    };

/**
 * Compares two lists as sets of lines. A line that appears several times in one list counts once.
 * Results keep the spelling of the first occurrence.
 */
export function compareLists(a: string, b: string, options: CompareOptions): CompareResult {
  const docs = [a, b].map(text => {
    const problem = sizeProblem(text, null);
    if (problem) return problem;
    const doc = splitLines(text);
    return sizeProblem(text, doc.lines.length) ?? doc;
  });
  for (const d of docs) if ('code' in d) return { ok: false, code: d.code, message: d.message };
  const distinct = (doc: LineDoc) => {
    const map = new Map<string, string>();
    let considered = 0;
    for (const raw of doc.lines) {
      const line = options.trim ? raw.trim() : raw;
      if (options.ignoreEmpty && line.trim() === '') continue;
      considered++;
      const key = foldKey(line, options.ignoreCase);
      if (!map.has(key)) map.set(key, line);
    }
    return { map, repeats: considered - map.size };
  };
  const left = distinct(docs[0] as LineDoc);
  const right = distinct(docs[1] as LineDoc);
  const both: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [key, line] of left.map) (right.map.has(key) ? both : onlyA).push(line);
  for (const [key, line] of right.map) if (!left.map.has(key)) onlyB.push(line);
  return {
    ok: true, both, onlyA, onlyB, union: [...left.map.values(), ...onlyB],
    uniqueA: left.map.size, uniqueB: right.map.size, repeatsA: left.repeats, repeatsB: right.repeats,
  };
}

export interface TextStats {
  /** Unicode code points: what most people mean by characters. */
  readonly characters: number;
  /** Code points that are not whitespace. */
  readonly nonWhitespace: number;
  readonly utf8Bytes: number;
  readonly utf16Units: number;
  readonly lines: number;
  readonly emptyLines: number;
  readonly uniqueLines: number;
  /** Runs of non-whitespace characters. */
  readonly words: number;
  /** Code points in the longest line. */
  readonly longestLine: number;
}

export function textStats(text: string): TextStats {
  const doc = splitLines(text);
  let characters = 0;
  let nonWhitespace = 0;
  let words = 0;
  let inWord = false;
  for (const ch of text) {
    characters++;
    if (ch.trim() === '') inWord = false;
    else {
      nonWhitespace++;
      if (!inWord) words++;
      inWord = true;
    }
  }
  let longestLine = 0;
  let emptyLines = 0;
  for (const line of doc.lines) {
    let length = 0;
    for (const _ch of line) length++;
    if (length > longestLine) longestLine = length;
    if (line.trim() === '') emptyLines++;
  }
  return {
    characters, nonWhitespace, utf8Bytes: utf8Length(text), utf16Units: text.length,
    lines: doc.lines.length, emptyLines, uniqueLines: new Set(doc.lines).size, words, longestLine,
  };
}
