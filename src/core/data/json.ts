/**
 * Strict JSON (RFC 8259) validator and formatter.
 *
 * The formatter never parses values into JavaScript and back. It re-emits every token exactly as
 * written and changes only the whitespace between tokens, so numbers keep their digits
 * (12345678901234567890 and 1.0 stay as typed), strings keep their escapes, and duplicate property
 * names are kept rather than silently collapsed. It is iterative, so deep nesting cannot overflow
 * the call stack.
 */
import { describeCharAt, isUnusualSpace, LineIndex, type TextPosition } from '../text';

export type JsonErrorCode =
  | 'empty'
  | 'unexpected-end'
  | 'unterminated-string'
  | 'unexpected-char'
  | 'unusual-space'
  | 'trailing-comma'
  | 'single-quote'
  | 'curly-quote'
  | 'unquoted-key'
  | 'unquoted-string'
  | 'invalid-escape'
  | 'control-char'
  | 'leading-zero'
  | 'invalid-number'
  | 'hex-number'
  | 'invalid-literal'
  | 'comment'
  | 'expected-colon'
  | 'expected-comma-or-close'
  | 'expected-key'
  | 'expected-value'
  | 'mismatched-close'
  | 'trailing-content';

export type JsonWarningCode = 'duplicate-key' | 'unsafe-integer' | 'bom';

export interface JsonLocation extends TextPosition {
  /** 0-based UTF-16 offset into the input. */
  readonly offset: number;
}

export interface JsonIssue<C extends string> {
  readonly code: C;
  readonly message: string;
  readonly location: JsonLocation;
}

export type JsonValueType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonStats {
  readonly rootType: JsonValueType;
  /** Every value counted once: containers, strings, numbers, booleans and nulls. */
  readonly values: number;
  readonly maxDepth: number;
}

export type JsonFormat =
  | { readonly kind: 'validate' }
  | { readonly kind: 'minify' }
  | { readonly kind: 'pretty'; readonly indent: string };

export type JsonAnalysis =
  | {
      readonly ok: true;
      /** Null when only validating, or when the output would exceed the size limit. */
      readonly output: string | null;
      readonly outputTooLarge: boolean;
      readonly stats: JsonStats;
      readonly warnings: readonly JsonIssue<JsonWarningCode>[];
      readonly omittedWarnings: number;
    }
  | {
      readonly ok: false;
      readonly error: JsonIssue<JsonErrorCode>;
      readonly warnings: readonly JsonIssue<JsonWarningCode>[];
      readonly omittedWarnings: number;
    };

export interface JsonOptions {
  /** Stop producing output past this many characters (validation continues). */
  readonly maxOutputChars?: number;
  /** Keep at most this many warnings; the rest are counted. */
  readonly maxWarnings?: number;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 50_000_000;
export const DEFAULT_MAX_WARNINGS = 100;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const BS = String.fromCharCode(0x5c);
// Characters that may follow a backslash in a JSON string: " \ / b f n r t (and u, handled apart).
const SIMPLE_ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);
const VALID_ESCAPES = `${BS}" ${BS}${BS} ${BS}/ ${BS}b ${BS}f ${BS}n ${BS}r ${BS}t and ${BS}uXXXX`;

type State =
  | 'value' // a value is required: top level, after ':' or after ',' in an array
  | 'first-value-or-close' // just after '['
  | 'first-key-or-close' // just after '{'
  | 'key' // after ',' in an object
  | 'colon'
  | 'comma-or-close'
  | 'done';

interface Frame {
  readonly kind: 'object' | 'array';
  readonly open: number;
  /** Completed members. In an array this is also the index of the element being read. */
  count: number;
  readonly keys: Set<string> | null;
  key: string;
}

class Failure {
  constructor(readonly code: JsonErrorCode, readonly message: string, readonly offset: number) {}
}

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHex = (code: number) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
const isWordStart = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x24;
const isWordPart = (code: number) => isWordStart(code) || isDigit(code);

class Scanner {
  private i = 0;
  private state: State = 'value';
  private readonly stack: Frame[] = [];
  private readonly out: string[] = [];
  private outChars = 0;
  private emitting: boolean;
  private outputTooLarge = false;
  private readonly pretty: boolean;
  private readonly indentUnit: string;
  private readonly indents: string[] = [];
  private readonly warnings: JsonIssue<JsonWarningCode>[] = [];
  private omittedWarnings = 0;
  private readonly lines: LineIndex;
  private lastComma = -1;
  private values = 0;
  private maxDepth = 0;
  private rootType: JsonValueType | null = null;
  private readonly maxOutput: number;
  private readonly maxWarnings: number;

  constructor(private readonly text: string, format: JsonFormat, options: JsonOptions) {
    this.emitting = format.kind !== 'validate';
    this.pretty = format.kind === 'pretty';
    this.indentUnit = format.kind === 'pretty' ? format.indent : '';
    this.lines = new LineIndex(text);
    this.maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.maxWarnings = options.maxWarnings ?? DEFAULT_MAX_WARNINGS;
  }

  run(): JsonAnalysis {
    try {
      this.scan();
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      return { ok: false, error: { code: e.code, message: e.message, location: this.locate(e.offset) }, warnings: this.warnings, omittedWarnings: this.omittedWarnings };
    }
    return {
      ok: true,
      output: this.emitting ? this.out.join('') : null,
      outputTooLarge: this.outputTooLarge,
      stats: { rootType: this.rootType!, values: this.values, maxDepth: this.maxDepth },
      warnings: this.warnings,
      omittedWarnings: this.omittedWarnings,
    };
  }

  private scan(): void {
    const text = this.text;
    if (text.charCodeAt(0) === 0xfeff) {
      this.warn('bom', 'The input starts with a byte order mark (U+FEFF). It is not part of the JSON text, so it is left out of the output.', 0);
      this.i = 1;
    }
    this.skipWhitespace();
    if (this.i >= text.length) {
      throw new Failure('empty', text.length === 0 ? 'Paste or type some JSON.' : 'The input contains only whitespace.', this.i);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.i >= text.length) break;
      this.step();
    }
    if (this.stack.length > 0) this.failAtEnd();
  }

  private skipWhitespace(): void {
    const text = this.text;
    while (this.i < text.length) {
      const c = text.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private step(): void {
    const text = this.text;
    const i = this.i;
    const c = text.charCodeAt(i);
    const ch = text[i];

    // Problems that look the same in every state.
    if (c === 0x2f && (text[i + 1] === '/' || text[i + 1] === '*')) throw new Failure('comment', 'Comments are not allowed in JSON.', i);
    const cp = text.codePointAt(i)!;
    if (isUnusualSpace(cp)) {
      throw new Failure('unusual-space', `Unexpected ${describeCharAt(text, i)}. Only spaces, tabs and line breaks may separate JSON tokens; this character often comes from text copied out of a web page or document.`, i);
    }

    switch (this.state) {
      case 'value':
      case 'first-value-or-close':
        if (ch === ']' && this.state === 'first-value-or-close') return this.close();
        if (ch === ']' || ch === '}') {
          if (this.lastComma >= 0) throw new Failure('trailing-comma', `Trailing comma: JSON does not allow a comma before '${ch}'.`, this.lastComma);
          throw new Failure('expected-value', `Expected a value but found '${ch}'.`, i);
        }
        return this.value();
      case 'first-key-or-close':
      case 'key':
        if (ch === '}' && this.state === 'first-key-or-close') return this.close();
        if (ch === '}') throw new Failure('trailing-comma', "Trailing comma: JSON does not allow a comma before '}'.", this.lastComma);
        if (ch === '"') return this.key();
        return this.badKey();
      case 'colon':
        if (ch === ':') {
          this.i++;
          this.emit(this.pretty ? ': ' : ':');
          this.state = 'value';
          this.lastComma = -1;
          return;
        }
        throw new Failure('expected-colon', `Expected ':' after the property name but found ${describeCharAt(text, i)}.`, i);
      case 'comma-or-close': {
        const top = this.stack[this.stack.length - 1];
        const close = top.kind === 'object' ? '}' : ']';
        if (ch === ',') {
          this.lastComma = i;
          this.i++;
          this.emit(',');
          this.newline(this.stack.length);
          this.state = top.kind === 'object' ? 'key' : 'value';
          return;
        }
        if (ch === close) return this.close();
        if (ch === '}' || ch === ']') {
          const where = this.locate(top.open);
          throw new Failure('mismatched-close', `Expected ',' or '${close}' but found '${ch}'. The ${top.kind} opened at line ${where.line}, column ${where.column} is still open.`, i);
        }
        const hint = ch === '"' || ch === '{' || ch === '[' || isDigit(c) ? ' Is a comma missing?' : '';
        throw new Failure('expected-comma-or-close', `Expected ',' or '${close}' but found ${describeCharAt(text, i)}.${hint}`, i);
      }
      case 'done':
        throw new Failure('trailing-content', `Unexpected ${describeCharAt(text, i)} after the end of the JSON value. A JSON document holds exactly one value; JSON Lines files have one document per line.`, i);
    }
  }

  private failAtEnd(): never {
    const top = this.stack[this.stack.length - 1];
    const where = this.locate(top.open);
    const close = top.kind === 'object' ? '}' : ']';
    const expected: Record<State, string> = {
      'value': 'a value',
      'first-value-or-close': `a value or '${close}'`,
      'first-key-or-close': `a property name or '${close}'`,
      'key': 'a property name',
      'colon': "':'",
      'comma-or-close': `',' or '${close}'`,
      'done': 'nothing',
    };
    throw new Failure('unexpected-end', `Unexpected end of input: expected ${expected[this.state]}. The ${top.kind} opened at line ${where.line}, column ${where.column} is not closed.`, this.text.length);
  }

  private value(): void {
    const text = this.text;
    const i = this.i;
    const c = text.charCodeAt(i);
    const top = this.stack[this.stack.length - 1];
    if (top && top.kind === 'array' && top.count === 0) this.newline(this.stack.length);

    if (c === 0x7b || c === 0x5b) return this.open(c === 0x7b ? 'object' : 'array');
    if (c === 0x22) {
      const end = this.scanString();
      this.emit(text.slice(i, end));
      this.i = end;
      return this.completeValue('string');
    }
    if (c === 0x2d || isDigit(c)) return this.number();
    for (const [word, type] of [['true', 'boolean'], ['false', 'boolean'], ['null', 'null']] as const) {
      if (text.startsWith(word, i)) {
        this.emit(word);
        this.i = i + word.length;
        return this.completeValue(type);
      }
    }
    this.badValue();
  }

  private open(kind: 'object' | 'array'): void {
    this.countValue(kind);
    this.stack.push({ kind, open: this.i, count: 0, keys: kind === 'object' ? new Set() : null, key: '' });
    this.maxDepth = Math.max(this.maxDepth, this.stack.length);
    this.emit(kind === 'object' ? '{' : '[');
    this.i++;
    this.state = kind === 'object' ? 'first-key-or-close' : 'first-value-or-close';
    this.lastComma = -1;
  }

  private close(): void {
    const frame = this.stack.pop()!;
    if (frame.count > 0) this.newline(this.stack.length);
    this.emit(frame.kind === 'object' ? '}' : ']');
    this.i++;
    this.afterValue();
  }

  private completeValue(type: JsonValueType): void {
    this.countValue(type);
    this.afterValue();
  }

  private countValue(type: JsonValueType): void {
    this.values++;
    if (this.rootType === null) this.rootType = type;
  }

  private afterValue(): void {
    this.lastComma = -1;
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.state = 'done';
      return;
    }
    top.count++;
    this.state = 'comma-or-close';
  }

  private key(): void {
    const top = this.stack[this.stack.length - 1];
    if (top.count === 0) this.newline(this.stack.length);
    const start = this.i;
    const end = this.scanString();
    const raw = this.text.slice(start, end);
    this.emit(raw);
    this.i = end;
    // The token is already validated, so JSON.parse is only used to decode its escapes:
    // "a" and "a" are the same name.
    const name = JSON.parse(raw) as string;
    if (top.keys!.has(name)) {
      this.warn('duplicate-key', `Duplicate property name ${raw} in ${this.containerPath()}. Most JSON parsers keep only the last value.`, start);
    } else top.keys!.add(name);
    top.key = name;
    this.state = 'colon';
  }

  /** Returns the offset just past the closing quote of the string starting at this.i. */
  private scanString(): number {
    const text = this.text;
    const open = this.i;
    let i = open + 1;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x22) return i + 1;
      if (c === 0x5c) {
        const e = text.charCodeAt(i + 1);
        if (Number.isNaN(e)) break;
        if (SIMPLE_ESCAPES.has(e)) {
          i += 2;
          continue;
        }
        if (e === 0x75) {
          for (let k = 2; k < 6; k++) {
            if (!isHex(text.charCodeAt(i + k))) throw new Failure('invalid-escape', `Invalid ${BS}u escape: ${BS}u must be followed by four hex digits.`, i);
          }
          i += 6;
          continue;
        }
        throw new Failure('invalid-escape', `Invalid escape ${BS}${String.fromCodePoint(text.codePointAt(i + 1)!)}. Valid escapes are ${VALID_ESCAPES}.`, i);
      }
      if (c < 0x20) {
        const where = this.locate(open);
        const detail = c === 0x0a || c === 0x0d
          ? `Strings cannot contain a raw line break (write it as ${BS}n), or the string that starts at line ${where.line}, column ${where.column} is missing its closing quote.`
          : `${describeCharAt(text, i)} must be escaped inside a string.`;
        throw new Failure('control-char', detail, i);
      }
      i++;
    }
    throw new Failure('unterminated-string', 'This string is never closed: it is missing its closing quote.', open);
  }

  private number(): void {
    const text = this.text;
    const start = this.i;
    let i = start;
    if (text.charCodeAt(i) === 0x2d) {
      i++;
      if (text.startsWith('Infinity', i)) throw new Failure('invalid-literal', 'Infinity is not valid JSON.', start);
      if (!isDigit(text.charCodeAt(i))) throw new Failure('invalid-number', "A '-' sign must be followed by a digit.", start);
    }
    if (text.charCodeAt(i) === 0x30) {
      i++;
      const next = text.charCodeAt(i);
      if (next === 0x78 || next === 0x58) throw new Failure('hex-number', 'Hexadecimal numbers are not allowed in JSON. Write the number in decimal.', start);
      if (isDigit(next)) throw new Failure('leading-zero', 'Numbers cannot have leading zeros in JSON.', start);
    } else {
      while (isDigit(text.charCodeAt(i))) i++;
    }
    let integer = true;
    if (text.charCodeAt(i) === 0x2e) {
      integer = false;
      i++;
      if (!isDigit(text.charCodeAt(i))) throw new Failure('invalid-number', 'A decimal point must be followed by at least one digit.', i - 1);
      while (isDigit(text.charCodeAt(i))) i++;
    }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      integer = false;
      i++;
      const sign = text.charCodeAt(i);
      if (sign === 0x2b || sign === 0x2d) i++;
      if (!isDigit(text.charCodeAt(i))) throw new Failure('invalid-number', 'An exponent must have at least one digit.', i);
      while (isDigit(text.charCodeAt(i))) i++;
    }
    const raw = text.slice(start, i);
    if (integer && raw.length >= 16) {
      const magnitude = BigInt(raw.startsWith('-') ? raw.slice(1) : raw);
      if (magnitude > MAX_SAFE) {
        this.warn('unsafe-integer', `${raw} is larger than ${Number.MAX_SAFE_INTEGER}. NetForge keeps its digits exactly, but JavaScript and many other JSON parsers round integers this large.`, start);
      }
    }
    this.emit(raw);
    this.i = i;
    this.completeValue('number');
  }

  private readWord(at: number): string {
    let end = at;
    while (end < this.text.length && isWordPart(this.text.charCodeAt(end))) end++;
    return this.text.slice(at, end);
  }

  private badValue(): never {
    const text = this.text;
    const i = this.i;
    const c = text.charCodeAt(i);
    if (c === 0x27) throw new Failure('single-quote', 'Strings must use double quotes ("), not single quotes.', i);
    if (c === 0x201c || c === 0x201d || c === 0x2018 || c === 0x2019) throw new Failure('curly-quote', 'Curly quotes are not valid JSON. Use straight double quotes (").', i);
    if (c === 0x2e && isDigit(text.charCodeAt(i + 1))) throw new Failure('invalid-number', 'Numbers need a digit before the decimal point (0.5, not .5).', i);
    if (c === 0x2b) throw new Failure('invalid-number', "A leading '+' sign is not allowed in JSON numbers.", i);
    if (isWordStart(c)) {
      const word = this.readWord(i);
      const lower = word.toLowerCase();
      if (word === 'NaN' || word === 'Infinity') throw new Failure('invalid-literal', `${word} is not valid JSON.`, i);
      if (word === 'undefined') throw new Failure('invalid-literal', 'undefined is not valid JSON. Use null, or leave the property out.', i);
      if (lower === 'none' || lower === 'nil') throw new Failure('invalid-literal', `${word} is not valid JSON. Use null.`, i);
      if (lower === 'true' || lower === 'false' || lower === 'null') throw new Failure('invalid-literal', `${word} is not valid JSON. Literals are lowercase: true, false and null.`, i);
      if (c === 0x74 || c === 0x66 || c === 0x6e) throw new Failure('invalid-literal', `'${word}' is not valid JSON. Expected true, false or null.`, i);
      throw new Failure('unquoted-string', `Unexpected word '${word}'. Strings must be in double quotes.`, i);
    }
    throw new Failure('unexpected-char', `Unexpected ${describeCharAt(text, i)}.`, i);
  }

  private badKey(): never {
    const text = this.text;
    const i = this.i;
    const c = text.charCodeAt(i);
    if (c === 0x27) throw new Failure('single-quote', 'Property names must use double quotes ("), not single quotes.', i);
    if (c === 0x201c || c === 0x201d || c === 0x2018 || c === 0x2019) throw new Failure('curly-quote', 'Curly quotes are not valid JSON. Use straight double quotes (").', i);
    if (isWordStart(c) || isDigit(c)) {
      const word = isWordStart(c) ? this.readWord(i) : text.slice(i, i + 1);
      throw new Failure('unquoted-key', `Property names must be strings in double quotes. Found ${isWordStart(c) ? `'${word}'` : 'a number'}.`, i);
    }
    throw new Failure('expected-key', `Expected a property name in double quotes but found ${describeCharAt(text, i)}.`, i);
  }

  /** JSONPath-style location of the container currently being read, such as $.users[3]. */
  private containerPath(): string {
    let path = '$';
    for (let k = 0; k < this.stack.length - 1; k++) {
      const frame = this.stack[k];
      path += frame.kind === 'array' ? `[${frame.count}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(frame.key) ? `.${frame.key}` : `[${JSON.stringify(frame.key)}]`;
    }
    return path;
  }

  private emit(token: string): void {
    if (!this.emitting) return;
    this.outChars += token.length;
    if (this.outChars > this.maxOutput) {
      this.emitting = false;
      this.outputTooLarge = true;
      this.out.length = 0;
      return;
    }
    this.out.push(token);
  }

  private newline(depth: number): void {
    if (!this.pretty || !this.emitting) return;
    let indent = this.indents[depth];
    if (indent === undefined) {
      indent = this.indentUnit.repeat(depth);
      this.indents[depth] = indent;
    }
    this.emit(`\n${indent}`);
  }

  private warn(code: JsonWarningCode, message: string, offset: number): void {
    if (this.warnings.length >= this.maxWarnings) {
      this.omittedWarnings++;
      return;
    }
    this.warnings.push({ code, message, location: this.locate(offset) });
  }

  private locate(offset: number): JsonLocation {
    return { offset, ...this.lines.locate(offset) };
  }
}

/** Validates `text` as JSON and, unless `format.kind` is 'validate', reformats it. */
export function analyzeJson(text: string, format: JsonFormat = { kind: 'validate' }, options: JsonOptions = {}): JsonAnalysis {
  return new Scanner(text, format, options).run();
}

export const INDENTS = { '2': '  ', '4': '    ', tab: String.fromCharCode(0x09) } as const;
export type IndentChoice = keyof typeof INDENTS;
