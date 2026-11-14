import { describe, expect, it } from 'vitest';
import {
  compareCodePoints, compareLists, compareNatural, DEFAULT_TRANSFORM, joinLines, splitLines, TEXT_LIMITS, textStats, transformLines,
  type Eol, type TransformOptions,
} from '../../src/core/textops/lines';
import { rng } from '../helpers';

const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const CRLF = CR + LF;
const TAB = String.fromCharCode(0x09);
const cp = (...points: number[]) => String.fromCodePoint(...points);
const GRIN = cp(0x1f600);
/** Lines joined with LF. */
const L = (...lines: string[]) => lines.join(LF);

function run(text: string, options: Partial<TransformOptions> = {}) {
  const result = transformLines(text, { ...DEFAULT_TRANSFORM, ...options });
  if (!result.ok) throw new Error(`unexpected failure: ${result.code}`);
  return result;
}

const out = (text: string, options: Partial<TransformOptions> = {}) => run(text, options).output;
const failCode = (text: string, options: Partial<TransformOptions> = {}) => {
  const result = transformLines(text, { ...DEFAULT_TRANSFORM, ...options });
  return result.ok ? 'ok' : result.code;
};

describe('splitLines and joinLines', () => {
  it('splits on LF, CRLF and a lone CR', () => {
    expect(splitLines(L('a', 'b', 'c'))).toEqual({ lines: ['a', 'b', 'c'], eol: LF, mixedEol: false, finalEol: false });
    expect(splitLines(`a${CRLF}b${CRLF}`)).toEqual({ lines: ['a', 'b'], eol: CRLF, mixedEol: false, finalEol: true });
    expect(splitLines(`a${CR}b`)).toEqual({ lines: ['a', 'b'], eol: CR, mixedEol: false, finalEol: false });
    expect(splitLines(`a${CR}`)).toEqual({ lines: ['a'], eol: CR, mixedEol: false, finalEol: true });
  });

  it('treats empty text as no lines, and a lone line ending as one empty line', () => {
    expect(splitLines('')).toEqual({ lines: [], eol: LF, mixedEol: false, finalEol: false });
    expect(splitLines(LF)).toEqual({ lines: [''], eol: LF, mixedEol: false, finalEol: true });
    expect(splitLines(CRLF + CRLF)).toEqual({ lines: ['', ''], eol: CRLF, mixedEol: false, finalEol: true });
    expect(splitLines('a')).toEqual({ lines: ['a'], eol: LF, mixedEol: false, finalEol: false });
  });

  it('keeps empty lines in the middle and whitespace inside lines', () => {
    expect(splitLines(L('a', '', '', ' b ')).lines).toEqual(['a', '', '', ' b ']);
    expect(splitLines(`${LF}a`).lines).toEqual(['', 'a']);
  });

  it('notices mixed line endings and remembers the first', () => {
    expect(splitLines(`a${CRLF}b${LF}c${CR}d`)).toEqual({ lines: ['a', 'b', 'c', 'd'], eol: CRLF, mixedEol: true, finalEol: false });
    expect(splitLines(`a${LF}b${CRLF}`)).toEqual({ lines: ['a', 'b'], eol: LF, mixedEol: true, finalEol: true });
    // CR then CRLF are two different endings; LF CR is LF followed by a lone CR.
    expect(splitLines(`a${CR}${CRLF}b`).lines).toEqual(['a', '', 'b']);
    expect(splitLines(`a${LF}${CR}b`)).toEqual({ lines: ['a', '', 'b'], eol: LF, mixedEol: true, finalEol: false });
  });

  it('does not split on other separators', () => {
    const text = `a${cp(0x2028)}b${cp(0x0b)}c${cp(0x0c)}d${cp(0x85)}e`;
    expect(splitLines(text).lines).toEqual([text]);
  });

  it('joins back to the original text whenever the endings are consistent', () => {
    for (const eol of [LF, CRLF, CR]) {
      for (const lines of [['a'], ['a', 'b'], ['', 'a', ''], ['a', '', 'b'], [' ', TAB]]) {
        for (const final of [true, false]) {
          const text = lines.join(eol) + (final ? eol : '');
          const doc = splitLines(text);
          expect(joinLines(doc.lines, doc)).toBe(text);
        }
      }
    }
    expect(joinLines([], { eol: CRLF as Eol, finalEol: true })).toBe('');
    expect(joinLines(['x'], { eol: CRLF as Eol, finalEol: true })).toBe(`x${CRLF}`);
  });
});

describe('transformLines with nothing selected', () => {
  it('returns the identical text, whatever it holds', () => {
    const texts = [
      '', 'a', LF, L('b', 'a', 'b', ''), `  spaces  ${LF}${TAB}tab${LF}`, `a${CRLF}b${LF}c${CR}d${CRLF}`, `MiXed${CR}${CR}`, `${GRIN}${cp(0x301)}${LF}`,
      `trailing   ${CRLF}${CRLF}${CRLF}`, cp(0xfeff) + L('bom', 'x'),
    ];
    for (const text of texts) {
      const result = run(text);
      expect(result.output).toBe(text);
      expect(result.steps).toEqual([]);
      expect(result.mixedEol).toBe(false);
      expect([result.emptyRemoved, result.duplicatesRemoved]).toEqual([0, 0]);
      expect(result.linesOut).toBe(result.linesIn);
    }
  });

  it('ignores options that only matter when their operation is on', () => {
    const text = `B${CRLF}a${LF}b`;
    expect(out(text, { descending: true, ignoreCase: true, numberStart: 5, numberSeparator: ') ', numberPad: true })).toBe(text);
    expect(out(text, { numberStart: Number.NaN })).toBe(text);
  });

  it('has every operation off by default', () => {
    expect(DEFAULT_TRANSFORM).toEqual({
      trim: 'none', removeEmpty: false, changeCase: 'none', dedupe: false, sort: 'none', descending: false, ignoreCase: false,
      prefix: '', suffix: '', number: false, numberStart: 1, numberSeparator: '. ', numberPad: false,
    });
  });
});

describe('each operation alone', () => {
  it('trims both ends, the start or the end', () => {
    const text = L('  a  ', `${TAB}b${TAB}`, 'c', `${cp(0xa0)}d${cp(0x3000)}`);
    expect(out(text, { trim: 'both' })).toBe(L('a', 'b', 'c', 'd'));
    expect(out(text, { trim: 'start' })).toBe(L('a  ', `b${TAB}`, 'c', `d${cp(0x3000)}`));
    expect(out(text, { trim: 'end' })).toBe(L('  a', `${TAB}b`, 'c', `${cp(0xa0)}d`));
    expect(run(text, { trim: 'both' }).steps).toHaveLength(1);
  });

  it('trimming keeps empty lines and inner spaces', () => {
    expect(out(L(' a  b ', '   ', ''), { trim: 'both' })).toBe(L('a  b', '', ''));
  });

  it('removes lines that are empty or only whitespace, and counts them', () => {
    const result = run(L('a', '', '   ', TAB, ' b ', '') + LF, { removeEmpty: true });
    expect(result.output).toBe(L('a', ' b ') + LF);
    expect([result.linesIn, result.linesOut, result.emptyRemoved]).toEqual([6, 2, 4]);
  });

  it('can remove every line', () => {
    const result = run(L('', ' ', '') + LF, { removeEmpty: true });
    expect([result.output, result.linesOut, result.emptyRemoved]).toEqual(['', 0, 3]);
  });

  it('changes case', () => {
    expect(out(L('Hello', `${cp(0xc9)}t${cp(0xe9)}`), { changeCase: 'lower' })).toBe(L('hello', `${cp(0xe9)}t${cp(0xe9)}`));
    expect(out(L('Hello', `${cp(0xc9)}t${cp(0xe9)}`), { changeCase: 'upper' })).toBe(L('HELLO', `${cp(0xc9)}T${cp(0xc9)}`));
  });

  it('removes duplicates, keeping the first of each', () => {
    const result = run(L('b', 'a', 'b', 'A', 'a', 'c', 'b'), { dedupe: true });
    expect(result.output).toBe(L('b', 'a', 'A', 'c'));
    expect(result.duplicatesRemoved).toBe(3);
  });

  it('removes duplicates ignoring case, keeping the first spelling', () => {
    const result = run(L('Beta', 'alpha', 'BETA', 'Alpha', 'beta', 'gamma'), { dedupe: true, ignoreCase: true });
    expect(result.output).toBe(L('Beta', 'alpha', 'gamma'));
    expect(result.duplicatesRemoved).toBe(3);
  });

  it('treats lines that differ only in whitespace as different unless trimmed', () => {
    expect(out(L('a', 'a ', ' a'), { dedupe: true })).toBe(L('a', 'a ', ' a'));
    expect(out(L('a', 'a ', ' a'), { dedupe: true, trim: 'both' })).toBe('a');
  });

  it('does not confuse lines with object property names', () => {
    expect(out(L('__proto__', 'constructor', '__proto__', 'toString'), { dedupe: true })).toBe(L('__proto__', 'constructor', 'toString'));
  });

  it('sorts by character code, ascending and descending', () => {
    expect(out(L('b', 'B', 'a', '10', '9', '', 'A'), { sort: 'text' })).toBe(L('', '10', '9', 'A', 'B', 'a', 'b'));
    expect(out(L('b', 'B', 'a', '10', '9', '', 'A'), { sort: 'text', descending: true })).toBe(L('b', 'a', 'B', 'A', '9', '10', ''));
  });

  it('sorts by code point, not by UTF-16 unit', () => {
    const astral = cp(0x10000);
    const privateUse = cp(0xe000);
    const fullwidth = cp(0xff21);
    // In UTF-16 the astral character starts with 0xD800, which is below 0xE000.
    expect(astral < privateUse).toBe(true);
    expect(out(L(astral, fullwidth, privateUse, 'z'), { sort: 'text' })).toBe(L('z', privateUse, fullwidth, astral));
    expect(out(L(`a${GRIN}`, `a${fullwidth}`), { sort: 'text' })).toBe(L(`a${fullwidth}`, `a${GRIN}`));
    expect(out(L(GRIN, cp(0x1f601), cp(0x1f5ff)), { sort: 'text' })).toBe(L(cp(0x1f5ff), GRIN, cp(0x1f601)));
  });

  it('sorts ignoring case, keeping the original order of lines that then compare equal', () => {
    expect(out(L('b', 'A', 'a', 'B', 'c', 'C'), { sort: 'text', ignoreCase: true })).toBe(L('A', 'a', 'b', 'B', 'c', 'C'));
    expect(out(L('b', 'A', 'a', 'B', 'c', 'C'), { sort: 'text', ignoreCase: true, descending: true })).toBe(L('c', 'C', 'b', 'B', 'A', 'a'));
    // Without ignoring case, capitals come first.
    expect(out(L('b', 'A', 'a', 'B'), { sort: 'text' })).toBe(L('A', 'B', 'a', 'b'));
  });

  it('sorts in natural order, numbers by value', () => {
    expect(out(L('item 10', 'item 9', 'item 100', 'item 1'), { sort: 'natural' })).toBe(L('item 1', 'item 9', 'item 10', 'item 100'));
    expect(out(L('item 10', 'item 9', 'item 100', 'item 1'), { sort: 'text' })).toBe(L('item 1', 'item 10', 'item 100', 'item 9'));
    expect(out(L('v1.10.2', 'v1.9.10', 'v1.9.9', 'v1.10.10'), { sort: 'natural' })).toBe(L('v1.9.9', 'v1.9.10', 'v1.10.2', 'v1.10.10'));
    expect(out(L('10.0.0.20', '10.0.0.3', '9.255.0.1'), { sort: 'natural' })).toBe(L('9.255.0.1', '10.0.0.3', '10.0.0.20'));
    expect(out(L('b2', 'B10', 'b1'), { sort: 'natural', ignoreCase: true })).toBe(L('b1', 'b2', 'B10'));
    expect(out(L('a2', 'a10', 'a1'), { sort: 'natural', descending: true })).toBe(L('a10', 'a2', 'a1'));
  });

  it('sorts by length in code points, stable for equal lengths', () => {
    expect(out(L('ccc', 'a', GRIN + GRIN, 'bb', '', 'b'), { sort: 'length' })).toBe(L('', 'a', 'b', GRIN + GRIN, 'bb', 'ccc'));
    expect(out(L('ccc', 'a', 'bb', 'b', 'dd'), { sort: 'length', descending: true })).toBe(L('ccc', 'bb', 'dd', 'a', 'b'));
  });

  it('sorting is stable for a large shuffled input', () => {
    const random = rng(12);
    const lines = Array.from({ length: 3000 }, (_, i) => `${['k', 'K'][Math.floor(random() * 2)]}${Math.floor(random() * 20)}#${i}`);
    const keyed = lines.map(l => l.split('#')[0]);
    const result = transformLines(keyed.join(LF), { ...DEFAULT_TRANSFORM, sort: 'text', ignoreCase: true });
    expect(result.ok).toBe(true);
    // Recompute with an explicitly stable reference.
    const reference = keyed.map((key, index) => ({ key, index })).sort((a, b) => {
      const x = a.key.toLowerCase();
      const y = b.key.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.index - b.index;
    }).map(k => k.key);
    expect(result.ok && result.output.split(LF)).toEqual(reference);
  });

  it('adds a prefix, a suffix or both to every line, empty ones included', () => {
    expect(out(L('a', '', 'b'), { prefix: '- ' })).toBe(L('- a', '- ', '- b'));
    expect(out(L('a', '', 'b'), { suffix: ',' })).toBe(L('a,', ',', 'b,'));
    expect(out(L('a', 'b'), { prefix: '"', suffix: '",' })).toBe(L('"a",', '"b",'));
    expect(out('', { prefix: 'x' })).toBe('');
  });

  it('numbers lines from the chosen start with the chosen separator', () => {
    expect(out(L('a', 'b', 'c'), { number: true })).toBe(L('1. a', '2. b', '3. c'));
    expect(out(L('a', 'b'), { number: true, numberStart: 0, numberSeparator: TAB })).toBe(L(`0${TAB}a`, `1${TAB}b`));
    expect(out(L('a', 'b'), { number: true, numberStart: 99, numberSeparator: ') ' })).toBe(L('99) a', '100) b'));
    expect(out(L('a', 'b'), { number: true, numberSeparator: '' })).toBe(L('1a', '2b'));
  });

  it('pads numbers to the width of the widest', () => {
    expect(out(L('a', 'b', 'c'), { number: true, numberStart: 8, numberPad: true })).toBe(L('08. a', '09. b', '10. c'));
    expect(out(L('a', 'b'), { number: true, numberStart: 1, numberPad: true })).toBe(L('1. a', '2. b'));
    expect(out(L('a', 'b', 'c'), { number: true, numberStart: 8, numberPad: false })).toBe(L('8. a', '9. b', '10. c'));
    const twelve = out(new Array(12).fill('x').join(LF), { number: true, numberPad: true }).split(LF);
    expect([twelve[0], twelve[8], twelve[9], twelve[11]]).toEqual(['01. x', '09. x', '10. x', '12. x']);
  });

  it('numbers from a negative start, padding the digits after the sign', () => {
    expect(out(L('a', 'b', 'c', 'd', 'e'), { number: true, numberStart: -2 })).toBe(L('-2. a', '-1. b', '0. c', '1. d', '2. e'));
    expect(out(L('a', 'b', 'c'), { number: true, numberStart: -10, numberPad: true })).toBe(L('-10. a', '-09. b', '-08. c'));
  });

  it('refuses a first line number that is not a whole number, only when numbering', () => {
    expect(failCode('a', { number: true, numberStart: 1.5 })).toBe('number-start');
    expect(failCode('a', { number: true, numberStart: Number.NaN })).toBe('number-start');
    expect(failCode('a', { number: true, numberStart: 2 ** 60 })).toBe('number-start');
    expect(failCode('a', { number: false, numberStart: 1.5 })).toBe('ok');
  });
});

describe('operations together', () => {
  it('runs in the fixed order: trim, remove empty, case, duplicates, sort, prefix and suffix, number', () => {
    const result = run(L(' b ', '', 'A', 'a', ' B', '  ') + LF, {
      trim: 'both', removeEmpty: true, changeCase: 'lower', dedupe: true, sort: 'text', prefix: '<', suffix: '>', number: true,
    });
    expect(result.output).toBe(L('1. <a>', '2. <b>') + LF);
    expect(result.steps).toHaveLength(7);
    expect([result.linesIn, result.linesOut, result.emptyRemoved, result.duplicatesRemoved]).toEqual([6, 2, 2, 2]);
  });

  it('trims before looking for duplicates, and changes case before both', () => {
    expect(out(L('x ', 'x', 'X'), { trim: 'end', dedupe: true })).toBe(L('x', 'X'));
    expect(out(L('x ', 'x', 'X'), { trim: 'end', dedupe: true, changeCase: 'upper' })).toBe('X');
  });

  it('adds the prefix after sorting, and numbers last', () => {
    // If the prefix were added first, the numbers would sort differently.
    expect(out(L('b', 'a'), { sort: 'text', prefix: 'z-', number: true })).toBe(L('1. z-a', '2. z-b'));
    expect(out(L('2', '10'), { sort: 'natural', suffix: '!' })).toBe(L('2!', '10!'));
  });

  it('removes empty lines before numbering', () => {
    expect(out(L('a', '', 'b'), { removeEmpty: true, number: true })).toBe(L('1. a', '2. b'));
    expect(out(L('a', '', 'b'), { number: true })).toBe(L('1. a', '2. ', '3. b'));
  });

  it('keeps the line ending style and the final line ending', () => {
    expect(out(`b${CRLF}a${CRLF}`, { sort: 'text' })).toBe(`a${CRLF}b${CRLF}`);
    expect(out(`b${CRLF}a`, { sort: 'text' })).toBe(`a${CRLF}b`);
    expect(out(`b${CR}a${CR}`, { sort: 'text' })).toBe(`a${CR}b${CR}`);
    expect(out(L('b', 'a') + LF, { sort: 'text' })).toBe(L('a', 'b') + LF);
  });

  it('uses the first line ending throughout when the text mixes them, and says so', () => {
    const result = run(`c${CRLF}b${LF}a${CR}`, { sort: 'text' });
    expect(result.output).toBe(`a${CRLF}b${CRLF}c${CRLF}`);
    expect(result.mixedEol).toBe(true);
    expect(run(`c${LF}b${LF}`, { sort: 'text' }).mixedEol).toBe(false);
  });
});

describe('limits', () => {
  it('states them', () => {
    expect(TEXT_LIMITS).toEqual({ chars: 5_000_000, lines: 200_000 });
  });

  it('refuses text over the character limit, even with nothing selected', () => {
    const atLimit = 'x'.repeat(TEXT_LIMITS.chars);
    expect(failCode(atLimit)).toBe('ok');
    expect(failCode(`${atLimit}x`)).toBe('too-large');
    expect(failCode(`${atLimit}x`, { sort: 'text' })).toBe('too-large');
  });

  it('refuses text over the line limit', () => {
    const atLimit = `a${LF}`.repeat(TEXT_LIMITS.lines);
    expect(failCode(atLimit, { dedupe: true })).toBe('ok');
    expect(failCode(`${atLimit}a`, { dedupe: true })).toBe('too-many-lines');
    expect(failCode(`${atLimit}a`)).toBe('too-many-lines');
  });

  it('refuses a result that a prefix or suffix would make too large', () => {
    const text = `a${LF}`.repeat(TEXT_LIMITS.lines);
    expect(failCode(text, { prefix: 'p'.repeat(40) })).toBe('ok');
    expect(failCode(text, { prefix: 'p'.repeat(60) })).toBe('too-large');
    expect(failCode(text, { suffix: 's'.repeat(60) })).toBe('too-large');
  });

  it('applies the same limits to list comparison', () => {
    const big = 'x'.repeat(TEXT_LIMITS.chars + 1);
    const options = { ignoreCase: false, trim: false, ignoreEmpty: false };
    const a = compareLists(big, 'a', options);
    const b = compareLists('a', big, options);
    const lines = compareLists('a', `a${LF}`.repeat(TEXT_LIMITS.lines + 1), options);
    expect([a.ok ? 'ok' : a.code, b.ok ? 'ok' : b.code, lines.ok ? 'ok' : lines.code]).toEqual(['too-large', 'too-large', 'too-many-lines']);
  });

  it('sorts and removes duplicates in 200,000 lines quickly', () => {
    const random = rng(77);
    const text = Array.from({ length: TEXT_LIMITS.lines }, () => `host-${Math.floor(random() * 150_000)}.example`).join(LF);
    const start = performance.now();
    const result = run(text, { dedupe: true, sort: 'natural', ignoreCase: true });
    const elapsed = performance.now() - start;
    expect(result.linesIn).toBe(200_000);
    expect(result.linesOut + result.duplicatesRemoved).toBe(200_000);
    expect(result.duplicatesRemoved).toBeGreaterThan(10_000);
    const lines = result.output.split(LF);
    expect(lines[0]).toBe('host-0.example');
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe('compareCodePoints and compareNatural', () => {
  const sign = (n: number) => Math.sign(n);

  it('orders by code point', () => {
    expect(sign(compareCodePoints('a', 'b'))).toBe(-1);
    expect(sign(compareCodePoints('b', 'a'))).toBe(1);
    expect(compareCodePoints('same', 'same')).toBe(0);
    expect(sign(compareCodePoints('a', 'ab'))).toBe(-1);
    expect(sign(compareCodePoints('', 'a'))).toBe(-1);
    expect(sign(compareCodePoints('Z', 'a'))).toBe(-1);
    expect(sign(compareCodePoints(cp(0xffff), cp(0x10000)))).toBe(-1);
    expect(sign(compareCodePoints(cp(0xe000), cp(0x10ffff)))).toBe(-1);
    expect(sign(compareCodePoints(cp(0xd7ff), cp(0xe000)))).toBe(-1);
    expect(sign(compareCodePoints(cp(0x10000), cp(0x10001)))).toBe(-1);
    expect(sign(compareCodePoints(cp(0x1f600), cp(0x2f800)))).toBe(-1);
  });

  it('agrees with a code point array comparison on random strings', () => {
    const random = rng(5);
    const pool = [0x41, 0x61, 0x7a, 0xe9, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x1f600, 0x10ffff];
    const make = () => Array.from({ length: Math.floor(random() * 4) }, () => pool[Math.floor(random() * pool.length)]);
    for (let i = 0; i < 4000; i++) {
      const a = make();
      const b = make();
      let want = 0;
      for (let k = 0; k < Math.min(a.length, b.length) && want === 0; k++) want = Math.sign(a[k] - b[k]);
      if (want === 0) want = Math.sign(a.length - b.length);
      if (sign(compareCodePoints(cp(...a), cp(...b))) !== want) throw new Error(`${a.join(',')} vs ${b.join(',')}`);
    }
    expect(pool).toHaveLength(10);
  });

  it('compares digit runs by value', () => {
    expect(sign(compareNatural('item9', 'item10'))).toBe(-1);
    expect(sign(compareNatural('item10', 'item9'))).toBe(1);
    expect(sign(compareNatural('a1b2', 'a1b10'))).toBe(-1);
    expect(sign(compareNatural('2', '10'))).toBe(-1);
    expect(sign(compareNatural('a', 'a1'))).toBe(-1);
    expect(sign(compareNatural('a1', 'a'))).toBe(1);
    expect(compareNatural('abc12', 'abc12')).toBe(0);
    expect(compareNatural('', '')).toBe(0);
    expect(sign(compareNatural('a2', 'b1'))).toBe(-1);
  });

  it('orders numbers of equal value by length, and handles numbers too large for a double', () => {
    expect(sign(compareNatural('7', '007'))).toBe(-1);
    expect(sign(compareNatural('007', '7'))).toBe(1);
    expect(sign(compareNatural('007', '8'))).toBe(-1);
    expect(sign(compareNatural('0', '00'))).toBe(-1);
    expect(sign(compareNatural('00', '1'))).toBe(-1);
    expect(sign(compareNatural('x9007199254740993', 'x9007199254740992'))).toBe(1);
    expect(sign(compareNatural('x123456789012345678901234567890', 'x123456789012345678901234567891'))).toBe(-1);
    expect(sign(compareNatural('x99999999999999999999', 'x100000000000000000000'))).toBe(-1);
  });

  it('is a consistent ordering: antisymmetric and transitive on random strings', () => {
    const random = rng(9);
    const pieces = ['a', 'b', '0', '1', '9', '10', '007', '-', '.'];
    const make = () => Array.from({ length: Math.floor(random() * 5) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const items = Array.from({ length: 120 }, make);
    for (const a of items) {
      for (const b of items) {
        if (sign(compareNatural(a, b)) !== -sign(compareNatural(b, a))) throw new Error(`antisymmetry: ${a} ${b}`);
        if (compareNatural(a, b) === 0 && a !== b) throw new Error(`distinct strings compare equal: ${a} ${b}`);
      }
    }
    const sorted = [...items].sort(compareNatural);
    for (let i = 0; i < sorted.length; i++) for (let j = i; j < sorted.length; j++) if (compareNatural(sorted[i], sorted[j]) > 0) throw new Error(`transitivity: ${sorted[i]} ${sorted[j]}`);
    expect(sorted).toHaveLength(120);
  });
});

describe('compareLists', () => {
  const plain = { ignoreCase: false, trim: false, ignoreEmpty: false };
  const compare = (a: string, b: string, options = plain) => {
    const result = compareLists(a, b, options);
    if (!result.ok) throw new Error(result.code);
    return result;
  };

  it('finds the intersection, both differences and the union, in list order', () => {
    const r = compare(L('d', 'a', 'b', 'c'), L('c', 'e', 'a', 'f'));
    expect(r.both).toEqual(['a', 'c']);
    expect(r.onlyA).toEqual(['d', 'b']);
    expect(r.onlyB).toEqual(['e', 'f']);
    expect(r.union).toEqual(['d', 'a', 'b', 'c', 'e', 'f']);
    expect([r.uniqueA, r.uniqueB, r.repeatsA, r.repeatsB]).toEqual([4, 4, 0, 0]);
  });

  it('counts a repeated line once and reports the repeats', () => {
    const r = compare(L('a', 'b', 'a', 'a'), L('b', 'b', 'c'));
    expect([r.both, r.onlyA, r.onlyB, r.union]).toEqual([['b'], ['a'], ['c'], ['a', 'b', 'c']]);
    expect([r.uniqueA, r.uniqueB, r.repeatsA, r.repeatsB]).toEqual([2, 2, 2, 1]);
  });

  it('is case-sensitive unless told otherwise, and keeps the first spelling', () => {
    expect(compare(L('Alpha', 'beta'), L('alpha', 'BETA')).both).toEqual([]);
    const r = compare(L('Alpha', 'beta', 'ALPHA'), L('alpha', 'BETA', 'Gamma'), { ...plain, ignoreCase: true });
    expect([r.both, r.onlyA, r.onlyB, r.union]).toEqual([['Alpha', 'beta'], [], ['Gamma'], ['Alpha', 'beta', 'Gamma']]);
    expect(r.repeatsA).toBe(1);
  });

  it('compares with or without surrounding whitespace', () => {
    expect(compare(L('a ', ' b'), L('a', 'b')).both).toEqual([]);
    const r = compare(L('a ', ' b'), L('a', 'b', ' c '), { ...plain, trim: true });
    expect([r.both, r.onlyB]).toEqual([['a', 'b'], ['c']]);
  });

  it('counts empty lines as an item unless told to ignore them', () => {
    const kept = compare(L('', '', 'a'), L('', 'b'));
    expect([kept.both, kept.onlyA, kept.onlyB, kept.uniqueA, kept.repeatsA]).toEqual([[''], ['a'], ['b'], 2, 1]);
    const ignored = compare(L('a', '', '  '), L('', 'b', TAB), { ...plain, ignoreEmpty: true });
    expect([ignored.both, ignored.onlyA, ignored.onlyB, ignored.uniqueA, ignored.repeatsA]).toEqual([[], ['a'], ['b'], 1, 0]);
  });

  it('handles empty lists, identical lists and either line ending', () => {
    expect(compare('', '')).toMatchObject({ both: [], onlyA: [], onlyB: [], union: [], uniqueA: 0, uniqueB: 0 });
    expect(compare(L('a', 'b'), '').onlyA).toEqual(['a', 'b']);
    expect(compare('', L('a', 'b')).onlyB).toEqual(['a', 'b']);
    const same = compare(`a${CRLF}b${CRLF}`, `b${LF}a`);
    expect([same.both, same.onlyA, same.onlyB]).toEqual([['a', 'b'], [], []]);
  });

  it('is not confused by names that exist on every object', () => {
    const r = compare(L('__proto__', 'constructor'), L('toString', '__proto__'));
    expect([r.both, r.onlyA, r.onlyB]).toEqual([['__proto__'], ['constructor'], ['toString']]);
  });

  it('matches set arithmetic on random lists', () => {
    const random = rng(21);
    for (let round = 0; round < 200; round++) {
      const make = () => Array.from({ length: Math.floor(random() * 12) }, () => `n${Math.floor(random() * 10)}`);
      const a = make();
      const b = make();
      if (a.length === 0 || b.length === 0) continue;
      const r = compare(a.join(LF), b.join(LF));
      const setA = new Set(a);
      const setB = new Set(b);
      expect(r.both).toEqual([...setA].filter(x => setB.has(x)));
      expect(r.onlyA).toEqual([...setA].filter(x => !setB.has(x)));
      expect(r.onlyB).toEqual([...setB].filter(x => !setA.has(x)));
      expect(new Set(r.union)).toEqual(new Set([...a, ...b]));
      expect(r.union).toHaveLength(new Set([...a, ...b]).size);
      expect([r.repeatsA, r.repeatsB]).toEqual([a.length - setA.size, b.length - setB.size]);
    }
  });
});

describe('textStats', () => {
  it('counts nothing in empty text', () => {
    expect(textStats('')).toEqual({ characters: 0, nonWhitespace: 0, utf8Bytes: 0, utf16Units: 0, lines: 0, emptyLines: 0, uniqueLines: 0, words: 0, longestLine: 0 });
  });

  it('counts characters, bytes, lines and words', () => {
    expect(textStats(L('one two', '', 'three'))).toEqual({ characters: 14, nonWhitespace: 11, utf8Bytes: 14, utf16Units: 14, lines: 3, emptyLines: 1, uniqueLines: 3, words: 3, longestLine: 7 });
  });

  it('counts code points, not UTF-16 units, and UTF-8 bytes exactly', () => {
    const s = textStats(`${GRIN}${cp(0xe9)}${cp(0x20ac)}a`);
    expect([s.characters, s.utf16Units, s.utf8Bytes, s.longestLine, s.words, s.nonWhitespace]).toEqual([4, 5, 10, 4, 1, 4]);
  });

  it('counts line endings as characters but not as part of any line', () => {
    const s = textStats(`ab${CRLF}cde${CRLF}`);
    expect([s.characters, s.lines, s.longestLine, s.emptyLines, s.nonWhitespace]).toEqual([9, 2, 3, 0, 5]);
  });

  it('counts whitespace-only lines as empty and repeated lines once in the unique count', () => {
    const s = textStats(L('a', '  ', 'a', '', TAB, 'b'));
    expect([s.lines, s.emptyLines, s.uniqueLines, s.words]).toEqual([6, 3, 5, 3]);
  });

  it('separates words on any whitespace', () => {
    expect(textStats(`a${TAB}b  c${cp(0xa0)}d${LF}e`).words).toBe(5);
    expect(textStats('   ').words).toBe(0);
    expect(textStats('one').words).toBe(1);
    expect(textStats(' lead and trail ').words).toBe(3);
  });
});
