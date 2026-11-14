/**
 * Runs a JavaScript regular expression against text and reports every match, its capture groups
 * and a replacement preview. This is the browser's own RegExp engine (ECMAScript semantics), not
 * PCRE, .NET or RE2.
 *
 * It is meant to run inside a Web Worker: a pattern with catastrophic backtracking can run for
 * years, and the only way to stop a regular expression in JavaScript is to terminate the thread it
 * runs on. This module bounds everything else: input sizes, how many matches and captures are
 * kept, and how large the replacement preview may grow.
 */

export const REGEX_LIMITS = {
  patternChars: 10_000,
  textChars: 1_000_000,
  replacementChars: 10_000,
  /** Matches reported in detail. All matches are still counted. */
  matches: 2_000,
  /** Capture groups reported in detail, across all matches. */
  captures: 50_000,
  /** Characters of any one match or capture shown; longer values are cut with their length kept. */
  valueChars: 1_000,
  /** Characters of match and capture text kept in total. */
  detailChars: 2_000_000,
  /** The replacement preview is not produced beyond this size. */
  replacedChars: 4_000_000,
  /** Wall-clock limit enforced by terminating the worker. */
  timeoutMs: 2_000,
} as const;

export interface RegexRequest {
  readonly pattern: string;
  readonly flags: string;
  readonly text: string;
  /** Null when no replacement preview is wanted. */
  readonly replacement: string | null;
}

/** A piece of matched text, cut to REGEX_LIMITS.valueChars with the full length kept. */
export interface Excerpt {
  readonly text: string;
  readonly length: number;
}

export interface GroupCapture {
  /** 1-based group number. */
  readonly number: number;
  readonly name: string | null;
  /** Null when the group did not take part in the match. */
  readonly value: Excerpt | null;
  readonly start: number;
  readonly end: number;
}

export interface RegexMatch {
  /** UTF-16 offsets into the text. */
  readonly start: number;
  readonly end: number;
  readonly value: Excerpt;
  readonly groups: readonly GroupCapture[];
}

export type RegexErrorCode = 'pattern-empty' | 'pattern-syntax' | 'flags' | 'too-large';

export type RegexResponse =
  | { readonly ok: false; readonly code: RegexErrorCode; readonly message: string }
  | {
      readonly ok: true;
      /** Every match found. */
      readonly total: number;
      /** The first matches in detail; fewer than `total` when a detail limit was reached. */
      readonly matches: readonly RegexMatch[];
      /** Why details stop early, or null when every match is listed. */
      readonly detailLimit: string | null;
      /** Start and end of every match (flat pairs), for highlighting, up to 100,000 matches. */
      readonly spans: readonly number[];
      readonly groupCount: number;
      readonly groupNames: readonly string[];
      readonly zeroLength: number;
      /** The text after replacement, or null when not requested or too large. */
      readonly replaced: string | null;
      readonly replacedNote: string | null;
    };

const FLAG_NAMES: Readonly<Record<string, string>> = {
  d: 'indices', g: 'global', i: 'ignore case', m: 'multiline', s: 'dot matches line breaks', u: 'Unicode', v: 'Unicode sets', y: 'sticky',
};
export const REGEX_FLAGS = Object.keys(FLAG_NAMES);

const MAX_SPANS = 100_000;
const BACKSLASH = String.fromCharCode(0x5c);

function checkFlags(flags: string): string | null {
  const seen = new Set<string>();
  for (const f of flags) {
    if (!Object.hasOwn(FLAG_NAMES, f)) return `"${f}" is not a JavaScript regular expression flag. The flags are ${REGEX_FLAGS.join(', ')}.`;
    if (seen.has(f)) return `The flag "${f}" is given twice.`;
    seen.add(f);
  }
  if (seen.has('u') && seen.has('v')) return 'The flags "u" and "v" cannot be used together; "v" includes everything "u" does.';
  return null;
}

type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'match' | 'before' | 'after' }
  | { readonly kind: 'group'; readonly number: number }
  | { readonly kind: 'named'; readonly name: string };

/**
 * Parses a replacement string the way String.prototype.replace reads it: $$, $&, $`, $', $1 to
 * $99 (only for groups that exist) and $<name> (only when the pattern has named groups). Anything
 * else is literal text.
 */
export function parseReplacement(template: string, groupCount: number, hasNamedGroups: boolean): Piece[] {
  const pieces: Piece[] = [];
  let literal = '';
  const flush = () => { if (literal !== '') { pieces.push({ kind: 'text', text: literal }); literal = ''; } };
  const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    const next = template[i + 1];
    if (ch !== '$' || next === undefined) { literal += ch; i++; continue; }
    if (next === '$') { literal += '$'; i += 2; continue; }
    if (next === '&') { flush(); pieces.push({ kind: 'match' }); i += 2; continue; }
    if (next === '`') { flush(); pieces.push({ kind: 'before' }); i += 2; continue; }
    if (next === "'") { flush(); pieces.push({ kind: 'after' }); i += 2; continue; }
    if (isDigit(next)) {
      const third = template[i + 2];
      const two = isDigit(third) ? Number(next + third) : 0;
      const one = Number(next);
      if (two >= 1 && two <= groupCount) { flush(); pieces.push({ kind: 'group', number: two }); i += 3; continue; }
      if (one >= 1 && one <= groupCount) { flush(); pieces.push({ kind: 'group', number: one }); i += 2; continue; }
      literal += ch;
      i++;
      continue;
    }
    if (next === '<' && hasNamedGroups) {
      const close = template.indexOf('>', i + 2);
      if (close >= 0) { flush(); pieces.push({ kind: 'named', name: template.slice(i + 2, close) }); i = close + 1; continue; }
    }
    literal += ch;
    i++;
  }
  flush();
  return pieces;
}

function excerpt(value: string, budget: { chars: number }): Excerpt {
  const text = value.length > REGEX_LIMITS.valueChars ? value.slice(0, REGEX_LIMITS.valueChars) : value;
  budget.chars -= text.length;
  return { text, length: value.length };
}

/** Moves past a zero-length match: one code point with the u or v flag, one UTF-16 unit without. */
function advance(text: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff) return index + 1;
  const second = text.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}

/**
 * The name of each capturing group by number (index 0 unused), read from the pattern text: a "("
 * opens a capturing group unless "?" follows it, and "(?<name>" opens a named one. Escapes and
 * character classes are skipped (classes nest only with the v flag).
 */
export function scanGroupNames(pattern: string, unicodeSets: boolean): (string | null)[] {
  const names: (string | null)[] = [null];
  let classDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === BACKSLASH) { i++; continue; }
    if (classDepth > 0) {
      if (ch === ']') classDepth--;
      else if (ch === '[' && unicodeSets) classDepth++;
      continue;
    }
    if (ch === '[') { classDepth = 1; continue; }
    if (ch !== '(') continue;
    if (pattern[i + 1] !== '?') { names.push(null); continue; }
    if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') {
      const close = pattern.indexOf('>', i + 3);
      names.push(close > 0 ? pattern.slice(i + 3, close) : null);
    }
  }
  return names;
}

export function runRegex(request: RegexRequest): RegexResponse {
  const { pattern, flags, text, replacement } = request;
  if (pattern.length > REGEX_LIMITS.patternChars) return { ok: false, code: 'too-large', message: `The pattern has ${pattern.length.toLocaleString('en-US')} characters; the limit is ${REGEX_LIMITS.patternChars.toLocaleString('en-US')}.` };
  if (text.length > REGEX_LIMITS.textChars) return { ok: false, code: 'too-large', message: `The test text has ${text.length.toLocaleString('en-US')} characters; the limit is ${REGEX_LIMITS.textChars.toLocaleString('en-US')}. Nothing was matched.` };
  if (replacement !== null && replacement.length > REGEX_LIMITS.replacementChars) return { ok: false, code: 'too-large', message: `The replacement has ${replacement.length.toLocaleString('en-US')} characters; the limit is ${REGEX_LIMITS.replacementChars.toLocaleString('en-US')}.` };
  if (pattern === '') return { ok: false, code: 'pattern-empty', message: 'Enter a pattern.' };
  const flagProblem = checkFlags(flags);
  if (flagProblem) return { ok: false, code: 'flags', message: flagProblem };

  let re: RegExp;
  try {
    // "d" adds capture positions to each result and changes nothing about what matches.
    re = new RegExp(pattern, flags.includes('d') ? flags : `${flags}d`);
  } catch (error) {
    const message = (error as Error).message.replace(/^Invalid regular expression: /, '');
    return { ok: false, code: 'pattern-syntax', message: `The pattern is not a valid JavaScript regular expression: ${message}` };
  }

  const global = re.global;
  const unicode = flags.includes('u') || flags.includes('v');
  const matches: RegexMatch[] = [];
  const spans: number[] = [];
  const budget = { chars: REGEX_LIMITS.detailChars };
  let captures = 0;
  let detailLimit: string | null = null;
  let total = 0;
  let zeroLength = 0;
  const out: string[] = [];
  let outChars = 0;
  let replacedNote: string | null = null;
  let cursor = 0;

  // The group structure comes from the pattern alone, so it is known even when nothing matches.
  const probe = new RegExp(`${pattern}|`, flags.replace(/[gyd]/g, '')).exec('');
  const groupCount = probe ? probe.length - 1 : 0;
  const groupNames = probe?.groups ? Object.keys(probe.groups) : [];
  let namesByNumber = scanGroupNames(pattern, flags.includes('v'));
  if (namesByNumber.length !== groupCount + 1) namesByNumber = new Array<string | null>(groupCount + 1).fill(null);
  const pieces = replacement === null ? null : parseReplacement(replacement, groupCount, groupNames.length > 0);

  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const start = m.index;
    const end = start + m[0].length;
    total++;
    if (m[0] === '') zeroLength++;
    if (spans.length < MAX_SPANS * 2) spans.push(start, end);

    if (detailLimit === null) {
      if (matches.length >= REGEX_LIMITS.matches) detailLimit = `Details are listed for the first ${REGEX_LIMITS.matches.toLocaleString('en-US')} matches.`;
      else if (captures + groupCount > REGEX_LIMITS.captures) detailLimit = `Details stop after ${matches.length.toLocaleString('en-US')} matches: the limit of ${REGEX_LIMITS.captures.toLocaleString('en-US')} listed capture groups was reached.`;
      else if (budget.chars <= 0) detailLimit = `Details stop after ${matches.length.toLocaleString('en-US')} matches: the limit of ${REGEX_LIMITS.detailChars.toLocaleString('en-US')} characters of listed text was reached.`;
      else {
        const groups: GroupCapture[] = [];
        for (let g = 1; g <= groupCount; g++) {
          const value = m[g];
          const at = m.indices?.[g];
          groups.push({ number: g, name: namesByNumber[g], value: value === undefined ? null : excerpt(value, budget), start: at ? at[0] : -1, end: at ? at[1] : -1 });
        }
        captures += groupCount;
        matches.push({ start, end, value: excerpt(m[0], budget), groups });
      }
    }

    if (pieces && replacedNote === null) {
      const parts: string[] = [text.slice(cursor, start)];
      for (const piece of pieces) {
        if (piece.kind === 'text') parts.push(piece.text);
        else if (piece.kind === 'match') parts.push(m[0]);
        else if (piece.kind === 'after') parts.push(text.slice(end));
        else if (piece.kind === 'before') parts.push(text.slice(0, start));
        else if (piece.kind === 'group') parts.push(m[piece.number] ?? '');
        else if (piece.kind === 'named') parts.push(m.groups?.[piece.name] ?? '');
      }
      for (const part of parts) outChars += part.length;
      if (outChars > REGEX_LIMITS.replacedChars) {
        replacedNote = `The replacement result would be larger than ${REGEX_LIMITS.replacedChars.toLocaleString('en-US')} characters, so it is not shown.`;
        out.length = 0;
      } else out.push(...parts);
      cursor = end;
    }

    if (!global) break;
    if (m[0] === '') re.lastIndex = advance(text, re.lastIndex, unicode);
  }

  let replaced: string | null = null;
  if (replacement !== null && replacedNote === null) {
    if (outChars + (text.length - cursor) > REGEX_LIMITS.replacedChars) {
      replacedNote = `The replacement result would be larger than ${REGEX_LIMITS.replacedChars.toLocaleString('en-US')} characters, so it is not shown.`;
    } else {
      out.push(text.slice(cursor));
      replaced = out.join('');
    }
  }
  return { ok: true, total, matches, detailLimit, spans, groupCount, groupNames, zeroLength, replaced, replacedNote };
}
