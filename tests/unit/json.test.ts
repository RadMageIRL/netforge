/** JSON validation and formatting: hand-written expectations. '~' stands for a backslash (see bs()). */
import { describe, expect, it } from 'vitest';
import { analyzeJson, INDENTS, type JsonAnalysis, type JsonFormat } from '../../src/core/data/json';
import { bs } from '../helpers';

const PRETTY: JsonFormat = { kind: 'pretty', indent: '  ' };
const MINIFY: JsonFormat = { kind: 'minify' };

function okOutput(r: JsonAnalysis): string {
  if (!r.ok) throw new Error(`expected valid JSON, got ${r.error.code}: ${r.error.message}`);
  if (r.output === null) throw new Error('expected output');
  return r.output;
}

function errorOf(text: string) {
  const r = analyzeJson(text);
  if (r.ok) throw new Error(`expected ${JSON.stringify(text)} to be invalid`);
  return r.error;
}

describe('formatting', () => {
  it('pretty-prints with two spaces, keeping empty containers on one line', () => {
    expect(okOutput(analyzeJson('{"a":1,"b":[1,2],"c":{},"d":[],"e":{"f":null}}', PRETTY))).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {},\n  "d": [],\n  "e": {\n    "f": null\n  }\n}');
  });

  it('minifies by removing all whitespace between tokens', () => {
    expect(okOutput(analyzeJson(' {\n\t"a" : [ 1 , true ,null ] ,\r\n "b":"x y" }\n', MINIFY))).toBe('{"a":[1,true,null],"b":"x y"}');
  });

  it('indents with four spaces or a tab when asked', () => {
    expect(okOutput(analyzeJson('[1,[2]]', { kind: 'pretty', indent: INDENTS['4'] }))).toBe('[\n    1,\n    [\n        2\n    ]\n]');
    const tab = String.fromCharCode(9);
    expect(okOutput(analyzeJson('{"a":[2]}', { kind: 'pretty', indent: INDENTS.tab }))).toBe(`{\n${tab}"a": [\n${tab}${tab}2\n${tab}]\n}`);
  });

  it('formats scalar documents as themselves', () => {
    for (const text of ['0', '-1.5e-7', '"text"', 'true', 'false', 'null']) expect(okOutput(analyzeJson(` ${text} `, PRETTY))).toBe(text);
  });

  it('returns no output when only validating', () => {
    const r = analyzeJson('{"a":1}');
    expect(r.ok && r.output).toBeNull();
  });
});

describe('values are never altered', () => {
  it('keeps every number exactly as written, including ones a double cannot hold', () => {
    const text = '[1.0,1e2,1E+2,-0,0.10,12345678901234567890,0.1000000000000000055511151231257827,-9007199254740993,1e400]';
    expect(okOutput(analyzeJson(text, MINIFY))).toBe(text);
    expect(okOutput(analyzeJson(text, PRETTY)).replace(/[ \n]/g, '')).toBe(text);
  });

  it('keeps string escapes and raw characters exactly as written', () => {
    const items = [bs('"~u00e9"'), `"${String.fromCharCode(0xe9)}"`, bs('"~/"'), bs('"a~"b"'), bs('"~ud83d~ude00"'), bs('"tab~there"'), bs('"~u0000"')];
    const text = `[${items.join(',')}]`;
    expect(okOutput(analyzeJson(text, MINIFY))).toBe(text);
    expect(okOutput(analyzeJson(text, PRETTY))).toBe(`[\n  ${items.join(',\n  ')}\n]`);
  });

  it('keeps duplicate property names and warns about each repeat', () => {
    const text = '{"a":1,"a":2,"b":3,"a":4}';
    const r = analyzeJson(text, MINIFY);
    expect(okOutput(r)).toBe(text);
    expect(r.warnings.map(w => [w.code, w.location.offset])).toEqual([['duplicate-key', 7], ['duplicate-key', 19]]);
  });

  it('treats differently escaped spellings of a name as the same name', () => {
    const r = analyzeJson(bs('{"a":1,"~u0061":2}'));
    expect(r.warnings.map(w => w.code)).toEqual(['duplicate-key']);
  });

  it('does not warn about the same name in different objects', () => {
    expect(analyzeJson('{"a":{"a":1},"b":[{"a":1},{"a":2}]}').warnings).toEqual([]);
  });

  it('gives the path of the object holding a duplicate', () => {
    const r = analyzeJson('{"x":[{"k":1},{"k":1,"k":2}],"odd key":{"z":0,"z":1}}');
    expect(r.warnings.map(w => w.message.match(/ in (.+?)\. Most/)?.[1])).toEqual(['$.x[1]', '$["odd key"]']);
  });

  it('warns about integers beyond 2^53 - 1 and stays quiet at the limit', () => {
    const codes = (text: string) => analyzeJson(text).warnings.map(w => w.code);
    expect(codes('9007199254740991')).toEqual([]);
    expect(codes('-9007199254740991')).toEqual([]);
    expect(codes('9007199254740992')).toEqual(['unsafe-integer']);
    expect(codes('[-12345678901234567890]')).toEqual(['unsafe-integer']);
    expect(codes('[1.2345678901234567890, 1e30]')).toEqual([]);
  });

  it('accepts a leading byte order mark with a warning and leaves it out of the output', () => {
    const r = analyzeJson(`${String.fromCharCode(0xfeff)}{"a":1}`, MINIFY);
    expect(okOutput(r)).toBe('{"a":1}');
    expect(r.warnings.map(w => w.code)).toEqual(['bom']);
  });

  it('caps the warning list and counts the rest', () => {
    const r = analyzeJson('{"a":1,"a":2,"a":3,"a":4,"a":5}', { kind: 'validate' }, { maxWarnings: 2 });
    expect(r.warnings).toHaveLength(2);
    expect(r.omittedWarnings).toBe(2);
  });
});

describe('statistics', () => {
  it('counts values and depth', () => {
    const r = analyzeJson('{"a":[1,2,{"b":null}],"c":"x"}');
    expect(r.ok && r.stats).toEqual({ rootType: 'object', values: 7, maxDepth: 3 });
  });

  it('reports scalar roots', () => {
    const r = analyzeJson('42');
    expect(r.ok && r.stats).toEqual({ rootType: 'number', values: 1, maxDepth: 0 });
  });
});

describe('errors', () => {
  it.each([
    ['', 'empty', 0],
    ['  \n ', 'empty', 4],
    ['{"a":1,}', 'trailing-comma', 6],
    ['[1,2,]', 'trailing-comma', 4],
    ['{"a":1 "b":2}', 'expected-comma-or-close', 7],
    ["{'a':1}", 'single-quote', 1],
    ["['a']", 'single-quote', 1],
    ['{a:1}', 'unquoted-key', 1],
    ['{1:1}', 'unquoted-key', 1],
    ['{,}', 'expected-key', 1],
    ['[,1]', 'unexpected-char', 1],
    ['{"a":}', 'expected-value', 5],
    ['{"a" 1}', 'expected-colon', 5],
    ['[1}', 'mismatched-close', 2],
    ['{"a":1]', 'mismatched-close', 6],
    ['[1] [2]', 'trailing-content', 4],
    ['{"a":1}}', 'trailing-content', 7],
    ['[1 // note\n]', 'comment', 3],
    ['/* c */ 1', 'comment', 0],
    ['[01]', 'leading-zero', 1],
    ['[-01]', 'leading-zero', 1],
    ['[0x1F]', 'hex-number', 1],
    ['[.5]', 'invalid-number', 1],
    ['[+1]', 'invalid-number', 1],
    ['[1.]', 'invalid-number', 2],
    ['[1e]', 'invalid-number', 3],
    ['[1e+]', 'invalid-number', 4],
    ['[-]', 'invalid-number', 1],
    ['[NaN]', 'invalid-literal', 1],
    ['[Infinity]', 'invalid-literal', 1],
    ['[-Infinity]', 'invalid-literal', 1],
    ['[undefined]', 'invalid-literal', 1],
    ['[True]', 'invalid-literal', 1],
    ['[None]', 'invalid-literal', 1],
    ['[tru]', 'invalid-literal', 1],
    ['{"a":hello}', 'unquoted-string', 5],
    ['"abc', 'unterminated-string', 0],
    ['["ok", "abc]', 'unterminated-string', 7],
    ['"a\nb"', 'control-char', 2],
    [`"a${String.fromCharCode(9)}b"`, 'control-char', 2],
    [bs('"~x"'), 'invalid-escape', 1],
    [bs('"~u12G4"'), 'invalid-escape', 1],
    [bs('"~u12"'), 'invalid-escape', 1],
    [bs('"abc~'), 'unterminated-string', 0],
    [`[1,${String.fromCharCode(0xa0)}2]`, 'unusual-space', 3],
    [`${String.fromCharCode(0x200b)}[]`, 'unusual-space', 0],
    [`[1]${String.fromCharCode(0xfeff)}`, 'unusual-space', 3],
    [`{${String.fromCharCode(0x201c)}a${String.fromCharCode(0x201d)}:1}`, 'curly-quote', 1],
    ['[#]', 'unexpected-char', 1],
  ])('rejects %j with %s at offset %i', (text, code, offset) => {
    const e = errorOf(text);
    expect(e.code).toBe(code);
    expect(e.location.offset).toBe(offset);
    expect(e.message.length).toBeGreaterThan(10);
  });

  it('reports unclosed containers at the end of input and names where they opened', () => {
    const e = errorOf('{"a": [1, 2');
    expect(e.code).toBe('unexpected-end');
    expect(e.location.offset).toBe(11);
    expect(e.message).toContain('line 1, column 7');
    expect(e.message).toContain("',' or ']'");
  });

  it('gives 1-based line and column numbers across LF, CRLF and CR line breaks', () => {
    expect(errorOf('{\n  "a": 1\n  "b": 2\n}').location).toMatchObject({ line: 3, column: 3 });
    expect(errorOf('[\r\n1,\r\nx]').location).toMatchObject({ line: 3, column: 1 });
    expect(errorOf('[\r1,\rx]').location).toMatchObject({ line: 3, column: 1 });
  });

  it('counts columns in characters, so an emoji is one column', () => {
    const e = errorOf(`["${String.fromCodePoint(0x1f600)}", x]`);
    expect(e.location).toMatchObject({ line: 1, column: 7, offset: 7 });
  });

  it('names invisible characters by code point', () => {
    expect(errorOf(`[1,${String.fromCharCode(0xa0)}2]`).message).toContain('U+00A0 (no-break space)');
    expect(errorOf(`{"a" ${String.fromCharCode(1)}}`).message).toContain('U+0001 (control character)');
  });
});

describe('limits', () => {
  it('handles 100,000 levels of nesting without overflowing the stack', () => {
    const depth = 100_000;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    const r = analyzeJson(text, MINIFY);
    expect(okOutput(r)).toBe(text);
    expect(r.ok && r.stats.maxDepth).toBe(depth);
  });

  it('stops producing output past the size limit but still validates', () => {
    const r = analyzeJson('[[[[[1]]]]]', PRETTY, { maxOutputChars: 20 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.output).toBeNull();
    expect(r.ok && r.outputTooLarge).toBe(true);
  });

  it('produces output when it fits exactly under the limit', () => {
    const r = analyzeJson('[1,2]', MINIFY, { maxOutputChars: 5 });
    expect(r.ok && r.output).toBe('[1,2]');
    expect(r.ok && r.outputTooLarge).toBe(false);
  });
});
