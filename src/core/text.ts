/** Text helpers shared by the parsers: positions and readable descriptions of characters. */

export interface TextPosition {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, counted in Unicode code points (what an editor shows). */
  readonly column: number;
}

/**
 * Converts UTF-16 offsets into line and column numbers. Line starts are computed once, on first
 * use, so locating many positions in a large text stays fast. CRLF, LF and a lone CR each end a line.
 */
export class LineIndex {
  private starts: number[] | null = null;

  constructor(private readonly text: string) {}

  locate(offset: number): TextPosition {
    const starts = this.lineStarts();
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const start = starts[lo];
    let column = 1;
    for (let i = start; i < offset && i < this.text.length; i++) {
      const code = this.text.charCodeAt(i);
      // A surrogate pair is one code point: skip the low half.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < offset) {
        const next = this.text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
      }
      column++;
    }
    return { line: lo + 1, column };
  }

  private lineStarts(): number[] {
    if (this.starts) return this.starts;
    const starts = [0];
    const text = this.text;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x0a) starts.push(i + 1);
      else if (code === 0x0d) {
        if (text.charCodeAt(i + 1) === 0x0a) i++;
        starts.push(i + 1);
      }
    }
    this.starts = starts;
    return starts;
  }
}

/** Names for characters that are invisible or easy to confuse when they turn up in pasted text. */
const CHARACTER_NAMES: Readonly<Record<number, string>> = {
  0x00: 'null character',
  0x09: 'tab',
  0x0a: 'line feed',
  0x0d: 'carriage return',
  0xa0: 'no-break space',
  0xad: 'soft hyphen',
  0x200b: 'zero width space',
  0x200c: 'zero width non-joiner',
  0x200d: 'zero width joiner',
  0x2028: 'line separator',
  0x2029: 'paragraph separator',
  0x202f: 'narrow no-break space',
  0x2060: 'word joiner',
  0x3000: 'ideographic space',
  0xfeff: 'zero width no-break space',
};

/** U+00A0 style label for a code point. */
export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Describes the character at `offset` for an error message: printable characters are quoted,
 * invisible and control characters are named by code point so the message never shows a blank.
 */
export function describeCharAt(text: string, offset: number): string {
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return 'the end of the input';
  const name = CHARACTER_NAMES[codePoint];
  if (name) return `${codePointLabel(codePoint)} (${name})`;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return `${codePointLabel(codePoint)} (control character)`;
  return `'${String.fromCodePoint(codePoint)}'`;
}

/** True for whitespace that is not ASCII space, tab, CR or LF (the only whitespace JSON allows). */
export function isUnusualSpace(codePoint: number): boolean {
  return codePoint === 0xa0 || codePoint === 0x1680 || (codePoint >= 0x2000 && codePoint <= 0x200b)
    || codePoint === 0x2028 || codePoint === 0x2029 || codePoint === 0x202f || codePoint === 0x205f
    || codePoint === 0x2060 || codePoint === 0x3000 || codePoint === 0xfeff;
}
