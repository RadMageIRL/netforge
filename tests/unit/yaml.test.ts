/**
 * YAML validation, formatting and conversion. Expected values are worked out by hand from the
 * YAML 1.2 core schema; the PyYAML comparison lives in data-oracle.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { DataResult } from '../../src/core/data/data-result';
import { formatYaml, jsonToYaml, validateYaml, YAML_LIMITS, yamlToJson } from '../../src/core/data/yaml';
import { pick, rng } from '../helpers';

type Ok = Extract<DataResult, { ok: true }>;
type Fail = Extract<DataResult, { ok: false }>;

function good(r: DataResult): Ok {
  if (!r.ok) throw new Error(`expected success, got: ${r.errors.map(e => `${e.line}:${e.column} ${e.message}`).join('; ')}`);
  return r;
}
function bad(r: DataResult): Fail {
  if (r.ok) throw new Error(`expected failure, got: ${r.output}`);
  return r;
}
const at = (r: DataResult) => { const f = bad(r); return [f.errors[0].line, f.errors[0].column]; };
const lines = (...l: string[]) => `${l.join('\n')}\n`;
const json = (text: string, indent?: string) => good(yamlToJson(text, indent)).output;
const value = (text: string) => JSON.parse(json(text)) as unknown;
const noteAbout = (r: DataResult, word: string) => good(r).notes.some(n => n.includes(word));

describe('YAML validation', () => {
  it('accepts valid YAML and counts documents', () => {
    expect(good(validateYaml('a: 1\n')).summary).toBe('Valid YAML: 1 document');
    expect(good(validateYaml(lines('---', 'a: 1', '---', '- x', '...'))).summary).toBe('Valid YAML: 2 documents');
    expect(good(validateYaml('a: 1\n')).output).toBe('');
  });

  it('treats empty and comment-only text as no document, not as an error', () => {
    for (const text of ['', '\n\n', '# only a comment\n\n']) {
      expect(good(validateYaml(text)).summary).toContain('No YAML document');
      const formatted = good(formatYaml(text));
      expect(formatted.output).toBe(text);
      expect(formatted.summary).toContain('No YAML document');
      // There is nothing to convert, and saying so is better than writing "null".
      expect(yamlToJson(text).ok).toBe(false);
    }
  });

  it('reports syntax errors with line and column, in every operation', () => {
    const cases: [string, number, number][] = [
      [lines('a: 1', ' b: 2'), 1, 4],
      [lines('a: [1, 2'), 2, 1],
      [`a:\n${String.fromCharCode(9)}b: 1\n`, 2, 1],
      [lines('ok: 1', 'key: "unclosed'), 3, 1],
    ];
    for (const [text, line, column] of cases) {
      for (const op of [validateYaml, formatYaml, yamlToJson]) expect(at(op(text)), text).toEqual([line, column]);
    }
  });

  it('refuses duplicate keys, pointing at the second one', () => {
    const text = lines('a: 1', 'b: 2', 'a: 3');
    for (const op of [validateYaml, formatYaml, yamlToJson]) {
      const f = bad(op(text));
      expect([f.errors[0].line, f.errors[0].column]).toEqual([3, 1]);
      expect(f.errors[0].message).toContain('unique');
    }
    // Nested, and in flow style.
    expect(validateYaml(lines('x:', '  k: 1', '  k: 2')).ok).toBe(false);
    expect(validateYaml('{a: 1, a: 2}\n').ok).toBe(false);
    // The same key in different mappings is fine.
    expect(validateYaml(lines('x: {k: 1}', 'y: {k: 2}')).ok).toBe(true);
  });

  it('refuses an alias to an anchor that is not defined', () => {
    for (const op of [validateYaml, formatYaml, yamlToJson]) expect(at(op(lines('a: 1', 'b: *nope'))), op.name).toEqual([2, 4]);
    // An anchor defined later does not count.
    expect(validateYaml(lines('a: *later', 'b: &later 1')).ok).toBe(false);
    expect(validateYaml(lines('b: &now 1', 'a: *now')).ok).toBe(true);
  });

  it('lists a bounded number of errors and counts the rest', () => {
    const text = Array.from({ length: 200 }, (_, i) => `k${i}: "unclosed`).join('\n');
    const f = bad(validateYaml(text));
    expect(f.errors.length).toBeLessThanOrEqual(YAML_LIMITS.issues);
    expect(f.errors.length + f.omitted).toBeGreaterThanOrEqual(1);
  });

  it('refuses input over the size limit without processing any of it', () => {
    const big = `a: 1\n${'# pad\n'.repeat(Math.ceil(YAML_LIMITS.inputChars / 6))}`;
    expect(big.length).toBeGreaterThan(YAML_LIMITS.inputChars);
    for (const op of [validateYaml, formatYaml, yamlToJson, jsonToYaml]) {
      const f = bad(op(big));
      expect(f.errors[0].message).toContain('limit');
      expect(f.errors[0].message).toContain('Nothing was processed');
    }
  });
});

describe('YAML formatting', () => {
  const KEEP = lines(
    '# head', 'a: 1e3   # tail', 'b: 0x1F', 'c: 1.50', 'd: 1_000', 'e: 12345678901234567890', 'f: &anc [1, 2]', 'g: *anc',
    'i: "dq"', "j: 'sq'", 'k: |', '  block', '  text', 'm: !custom tagged', 'n: -0.0', 'o: +5', 'p: 0o17', 'q: 1E+5', 'r: .5',
  );

  it('keeps comments, anchors, aliases, tags, quoting styles and the spelling of numbers', () => {
    expect(good(formatYaml(KEEP)).output).toBe(lines(
      '# head', 'a: 1e3 # tail', 'b: 0x1F', 'c: 1.50', 'd: 1_000', 'e: 12345678901234567890', 'f: &anc [ 1, 2 ]', 'g: *anc',
      'i: "dq"', "j: 'sq'", 'k: |', '  block', '  text', 'm: !custom tagged', 'n: -0.0', 'o: +5', 'p: 0o17', 'q: 1E+5', 'r: .5',
    ));
  });

  it('reindents with 2 or 4 spaces', () => {
    const text = lines('a:', '   b:', '      c: 1', 'k: |', '   block');
    expect(good(formatYaml(text, 2)).output).toBe(lines('a:', '  b:', '    c: 1', 'k: |', '  block'));
    expect(good(formatYaml(text, 4)).output).toBe(lines('a:', '    b:', '        c: 1', 'k: |', '    block'));
    expect(good(formatYaml(text)).output).toBe(good(formatYaml(text, 2)).output);
  });

  it('keeps every document of a stream, separated', () => {
    expect(good(formatYaml(lines('a: 1', '---', 'b:   2 # c'))).output).toBe(lines('a: 1', '---', 'b: 2 # c'));
    expect(good(formatYaml(lines('---', 'a: 1', '---', '- x', '...'))).output).toBe(lines('---', 'a: 1', '---', '- x', '...'));
    expect(good(formatYaml(lines('a: 1', '---', 'b: 2', '---', 'c: 3'))).summary).toBe('Valid YAML: 3 documents');
  });

  it('does not change what the YAML means, and formatting twice changes nothing more', () => {
    const samples = [
      KEEP,
      lines('- a', '- - b', '  - c', '- {d: [e]}'),
      lines('a: {}', 'b: []', 'c:', 'd: ""'),
      lines('base: &b {x: 1}', 'd:', '  <<: *b', '  y: 2'),
      lines('a: yes', 'b: no', 'e: 2001-12-14', 'j: 0123', 'k: 1:30', 'h: true', 'i: ~'),
      lines('long: >-', '  folded', '  text', 'keep: |+', '  trailing', '', 'end: 1'),
      lines('"quoted key": 1', "'single': 2", '? complex', ': 3'),
      lines('- &a 1', '- *a', '- !!str 5', '- !!binary aGVsbG8='),
    ];
    for (const text of samples) {
      const once = good(formatYaml(text)).output;
      expect(good(formatYaml(once)).output, text).toBe(once);
      expect(json(once), text).toBe(json(text));
    }
  });

  it('keeps the value of numbers written with an explicit tag', () => {
    // The tag decides how these are written; the value must survive (it once came out as .nan).
    const text = lines('a: !!int "7"', 'b: !!float "1.5"', 'c: !!float 3.0', 'd: !!str 123', 'e: !!int 0x1F');
    const out = good(formatYaml(text)).output;
    expect(out.includes('.nan')).toBe(false);
    expect(value(out)).toEqual({ a: 7, b: 1.5, c: 3, d: '123', e: 31 });
    expect(json(out)).toBe(json(text));
    // A tag the value does not fit (an integer written under !!float) is not applied, and says so.
    const misfit = good(yamlToJson(lines('c: !!float 3')));
    expect(JSON.parse(misfit.output)).toEqual({ c: '3' });
    expect(misfit.warnings).toHaveLength(1);
  });

  it('keeps block text that starts with spaces, at either indentation and at the root', () => {
    const nested = lines('code: |2', '    indented', '  base', 'x: 1');
    const expected = { code: '  indented\nbase\n', x: 1 };
    for (const indent of [2, 4] as const) {
      const out = good(formatYaml(nested, indent)).output;
      expect(value(out), `indent ${indent}`).toEqual(expected);
      expect(good(formatYaml(out, indent)).output).toBe(out);
    }
    // At two spaces the block style itself is kept.
    expect(good(formatYaml(nested, 2)).output).toBe(nested);
    const root = lines('|1', '  lead', ' next');
    expect(value(root)).toBe(' lead\nnext\n');
    expect(value(good(formatYaml(root)).output)).toBe(' lead\nnext\n');
    const list = lines('- |2', '    a', '  b', '- >2', '    folded', '  text');
    for (const indent of [2, 4] as const) expect(json(good(formatYaml(list, indent)).output)).toBe(json(list));
  });

  it('writes an empty document the same way every time', () => {
    const text = lines('a: 1', '---', '---', 'c: 3');
    expect(good(formatYaml(text)).output).toBe(text);
    expect(value(text)).toEqual([{ a: 1 }, null, { c: 3 }]);
  });

  it('reports unknown tags as warnings, with their position', () => {
    const r = good(formatYaml(lines('a: 1', 'b: !custom v')));
    expect(r.warnings).toHaveLength(1);
    expect([r.warnings[0].line, r.warnings[0].column]).toEqual([2, 4]);
    expect(r.output).toBe(lines('a: 1', 'b: !custom v'));
  });
});

describe('YAML to JSON', () => {
  it('follows YAML 1.2: only true and false are booleans, dates are strings', () => {
    expect(value(lines('a: yes', 'b: no', 'c: on', 'd: off', 'e: 2001-12-14', 'f: 0o17', 'g: 0x1F', 'h: true', 'i: ~', 'j: False', 'k: 1:30', 'l: Null', 'm: 1_000', 'n: y')))
      .toEqual({ a: 'yes', b: 'no', c: 'on', d: 'off', e: '2001-12-14', f: 15, g: 31, h: true, i: null, j: false, k: '1:30', l: null, m: '1_000', n: 'y' });
  });

  it('writes integers beyond 2^53 exactly', () => {
    expect(json(lines('big: 12345678901234567890', 'neg: -98765432109876543210'))).toBe('{\n  "big": 12345678901234567890,\n  "neg": -98765432109876543210\n}\n');
    expect(json('- 9007199254740993\n', '')).toBe('[9007199254740993]\n');
    expect(json('- 0xFFFFFFFFFFFFFFFFFF\n', '')).toBe('[4722366482869645213695]\n');
  });

  it('keeps the spelling of numbers that JSON can hold as written', () => {
    expect(json(lines('- 1.50', '- 1e3', '- 1E+5', '- -0.0', '- 0.1e-7', '- 100', '- -0', '- 1e400'), '')).toBe('[1.50,1e3,1E+5,-0.0,0.1e-7,100,-0,1e400]\n');
    expect(noteAbout(yamlToJson('- 1.50\n- 1e400\n'), 'different form')).toBe(false);
  });

  it('respells numbers JSON cannot hold as written, and says how many', () => {
    const r = good(yamlToJson(lines('- 0x1F', '- 0o17', '- +5', '- .5', '- 5.', '- 0123', '- +1.5'), ''));
    expect(r.output).toBe('[31,15,5,0.5,5,123,1.5]\n');
    expect(r.notes.some(n => n.startsWith('7 numbers written in a different form'))).toBe(true);
  });

  it('refuses infinity and not-a-number, with the position', () => {
    expect(at(yamlToJson(lines('ok: 1', 'a: .inf')))).toEqual([2, 4]);
    expect(at(yamlToJson('a: -.inf\n'))).toEqual([1, 4]);
    expect(at(yamlToJson('- 1\n- .nan\n'))).toEqual([2, 3]);
    expect(at(yamlToJson('a: .NaN\n'))).toEqual([1, 4]);
    // Quoted, they are strings and convert.
    expect(value('a: ".inf"\n')).toEqual({ a: '.inf' });
  });

  it('writes keys that are not strings as strings, and says how many', () => {
    const r = good(yamlToJson(lines('1: a', 'true: b', 'null: c', '2.5: d', 'plain: e')));
    expect(JSON.parse(r.output)).toEqual({ 1: 'a', true: 'b', null: 'c', 2.5: 'd', plain: 'e' });
    expect(r.notes.some(n => n.startsWith('4 keys that were not a string'))).toBe(true);
    expect(noteAbout(yamlToJson('plain: e\n"1": x\n'), 'not a string')).toBe(false);
  });

  it('refuses a list or mapping used as a key', () => {
    expect(at(yamlToJson(lines('? [1, 2]', ': v')))).toEqual([1, 3]);
    expect(at(yamlToJson(lines('ok: 1', '? {a: b}', ': v')))).toEqual([2, 3]);
    expect(at(yamlToJson(lines('k: &c [1]', '? *c', ': v')))).toEqual([2, 3]);
  });

  it('refuses two keys that become the same JSON name', () => {
    const f = bad(yamlToJson(lines('1: a', '"1": b')));
    expect([f.errors[0].line, f.errors[0].column]).toEqual([2, 1]);
    expect(bad(yamlToJson(lines('true: a', '"true": b'))).errors[0].line).toBe(2);
    expect(bad(yamlToJson(lines('~: a', '"~": b'))).errors[0].line).toBe(2);
  });

  it('writes aliases out in full and says how many', () => {
    const r = good(yamlToJson(lines('a: &x {k: v}', 'b: *x', 'c: *x')));
    expect(JSON.parse(r.output)).toEqual({ a: { k: 'v' }, b: { k: 'v' }, c: { k: 'v' } });
    expect(r.notes.some(n => n.startsWith('2 aliases written out in full'))).toBe(true);
    expect(good(yamlToJson(lines('a: &x 1', 'b: *x'))).notes.some(n => n.startsWith('1 alias written out in full'))).toBe(true);
    expect(noteAbout(yamlToJson('a: &x 1\n'), 'alias')).toBe(false);
  });

  it('refuses an alias to the collection that contains it', () => {
    expect(at(yamlToJson(lines('a: &x', '  self: *x')))).toEqual([2, 9]);
    expect(at(yamlToJson(lines('&l', '- 1', '- *l')))).toEqual([3, 3]);
    // The same anchor used twice side by side is not recursion.
    expect(value(lines('a: &x [1]', 'b: [*x, *x]'))).toEqual({ a: [1], b: [[1], [1]] });
  });

  it('stops an alias bomb at the output limit, quickly and without building it', () => {
    // Nine levels of nine aliases each: 9^9 leaves, about 387 million values if written out.
    const rows = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    const names = 'abcdefghij';
    for (let i = 1; i < 10; i++) rows.push(`${names[i]}: &${names[i]} [${Array.from({ length: 9 }, () => `*${names[i - 1]}`).join(',')}]`);
    const text = lines(...rows);
    const started = Date.now();
    const f = bad(yamlToJson(text));
    const elapsed = Date.now() - started;
    expect(f.errors[0].message).toContain('larger than');
    expect(f.errors[0].message).toContain('aliases');
    expect(f.errors[0].message).toContain('Nothing was converted');
    expect(elapsed).toBeLessThan(10_000);
    // The same text is valid YAML, and formatting it does not expand anything.
    expect(good(formatYaml(text)).output.length).toBeLessThan(text.length * 2);
  });

  it('refuses output just over the limit, and allows output just under it', () => {
    // One 5,000-character string behind an anchor, repeated by alias.
    const make = (aliases: number) => lines(`- &big "${'x'.repeat(5000)}"`, ...Array.from({ length: aliases }, () => '- *big'));
    const under = yamlToJson(make(3900), '');
    expect(under.ok).toBe(true);
    expect(good(under).output.length).toBeGreaterThan(19_000_000);
    expect(good(under).output.length).toBeLessThanOrEqual(YAML_LIMITS.outputChars + 1);
    const over = bad(yamlToJson(make(4100), ''));
    expect(over.errors[0].message).toContain('larger than');
  });

  it('writes !!binary as Base64 text and says so', () => {
    const r = good(yamlToJson('a: !!binary aGVsbG8=\n'));
    expect(JSON.parse(r.output)).toEqual({ a: 'aGVsbG8=' });
    expect(noteAbout(r, '!!binary')).toBe(true);
  });

  it('warns about tags outside the core schema and converts the plain value', () => {
    const r = good(yamlToJson(lines('a: !custom v', 'b: 1')));
    expect(JSON.parse(r.output)).toEqual({ a: 'v', b: 1 });
    expect(r.warnings).toHaveLength(1);
    expect(noteAbout(r, 'Tags')).toBe(true);
    expect(noteAbout(yamlToJson('b: 1\n'), 'Tags')).toBe(false);
  });

  it('keeps a merge key as an ordinary key and says so', () => {
    const r = good(yamlToJson(lines('base: &b {x: 1}', 'd:', '  <<: *b', '  y: 2')));
    expect(JSON.parse(r.output)).toEqual({ base: { x: 1 }, d: { '<<': { x: 1 }, y: 2 } });
    expect(noteAbout(r, 'Merge keys')).toBe(true);
    expect(noteAbout(yamlToJson('a: 1\n'), 'Merge keys')).toBe(false);
  });

  it('counts the comments it cannot carry over', () => {
    const r = good(yamlToJson(lines('# head', 'a: 1 # tail', '# before b', 'b: 2')));
    expect(r.notes.some(n => n.startsWith('3 comments not carried over'))).toBe(true);
    expect(good(yamlToJson('a: 1 # one\n')).notes.some(n => n.startsWith('1 comment not carried over'))).toBe(true);
    expect(noteAbout(yamlToJson('a: 1\n'), 'comment')).toBe(false);
  });

  it('writes several documents as an array and says so', () => {
    const r = good(yamlToJson(lines('a: 1', '---', '- x', '---', 'plain')));
    expect(r.output).toBe('[\n  {\n    "a": 1\n  },\n  [\n    "x"\n  ],\n  "plain"\n]\n');
    expect(r.summary).toBe('Converted 3 YAML documents to JSON');
    expect(noteAbout(r, '3 YAML documents')).toBe(true);
    expect(json(lines('a: 1', '---', '- x'), '')).toBe('[{"a":1},["x"]]\n');
    // One document is the value itself, not a one-item array.
    expect(json('- x\n', '')).toBe('["x"]\n');
    expect(good(yamlToJson('a: 1\n')).summary).toBe('Converted 1 YAML document to JSON');
  });

  it('indents as asked', () => {
    expect(json('a: [1, {b: 2}]\n')).toBe('{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}\n');
    expect(json('a: [1, {b: 2}]\n', '    ')).toBe('{\n    "a": [\n        1,\n        {\n            "b": 2\n        }\n    ]\n}\n');
    expect(json('a: [1, {b: 2}]\n', '')).toBe('{"a":[1,{"b":2}]}\n');
    expect(json(lines('a: {}', 'b: []', 'c:', 'd: ""'), '')).toBe('{"a":{},"b":[],"c":null,"d":""}\n');
  });

  it('handles scalars, block text and special strings', () => {
    expect(value(lines('k: |', '  block', '  text', 'f: >-', '  folded', '  text', 'q: "tab\\there"', "s: 'it''s'"))).toEqual({ k: 'block\ntext\n', f: 'folded text', q: 'tab\there', s: "it's" });
    expect(value('just text\n')).toBe('just text');
    expect(value('42\n')).toBe(42);
    expect(value('__proto__: 1\nconstructor: 2\n')).toEqual(JSON.parse('{"__proto__":1,"constructor":2}'));
    expect(json('__proto__: 1\n', '')).toBe('{"__proto__":1}\n');
  });

  it('refuses nesting deeper than the limit, and accepts the limit itself', () => {
    const nest = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}\n`;
    expect(yamlToJson(nest(YAML_LIMITS.depth)).ok).toBe(true);
    const f = bad(yamlToJson(nest(YAML_LIMITS.depth + 1)));
    expect(f.errors[0].message).toContain('deeper');
  });
});

describe('JSON to YAML', () => {
  const yaml = (text: string, indent?: 2 | 4) => good(jsonToYaml(text, indent)).output;

  it('reports invalid JSON with its location', () => {
    expect(at(jsonToYaml('{"a": 1,}'))).toEqual([1, 8]);
    expect(at(jsonToYaml('{\n  "a": tru\n}'))).toEqual([2, 8]);
    expect(jsonToYaml('').ok).toBe(false);
    expect(jsonToYaml("{'a': 1}").ok).toBe(false);
  });

  it('refuses duplicate names rather than dropping a value', () => {
    const f = bad(jsonToYaml('{"a":1,"b":2,"a":3}'));
    expect([f.errors[0].line, f.errors[0].column]).toEqual([1, 14]);
    expect(f.errors[0].message).toContain('unique');
    expect(jsonToYaml('{"x":{"a":1},"y":{"a":2}}').ok).toBe(true);
  });

  it('writes numbers exactly as the JSON has them', () => {
    expect(yaml('{"a":1e3,"b":1.50,"c":12345678901234567890,"d":-0,"e":1E+5,"f":0.1e-7,"g":1.0e3,"h":1e400}'))
      .toBe(lines('a: 1e3', 'b: 1.50', 'c: 12345678901234567890', 'd: -0', 'e: 1E+5', 'f: 0.1e-7', 'g: 1.0e3', 'h: 1e400'));
  });

  it('notes exponent forms that YAML 1.1 parsers read as strings', () => {
    expect(good(jsonToYaml('[1e3, 1E+5, 1.0e3, 0.1e-7, 1.5, 7]')).notes.some(n => n.startsWith('3 numbers use an exponent'))).toBe(true);
    expect(good(jsonToYaml('[1e3]')).notes.some(n => n.startsWith('1 number uses an exponent'))).toBe(true);
    expect(good(jsonToYaml('[1.0e+3, 2.5, 1]')).notes.some(n => n.includes('exponent'))).toBe(false);
  });

  it('quotes strings that YAML 1.1 or 1.2 would read as something else', () => {
    const strings = ['yes', 'no', 'on', 'off', 'y', 'n', '~', '0123', '1:30', '2001-12-14', '0o17', '0x1F', 'null', 'true', 'False', '', '1e3', '1.5', '42', ' x', 'x ', 'a: b', '#c', '- x', '.inf', '<<', '*a', '&a', '!t', '[x', '{x', '@x', '`x', '%x', 'x #y', '"q"', "'s'", '?', '-', ':'];
    const out = yaml(JSON.stringify(strings));
    const rows = out.trimEnd().split('\n');
    expect(rows).toHaveLength(strings.length);
    for (const row of rows) expect(/^- (".*"|'.*')$/.test(row), row).toBe(true);
    // Ordinary text is left plain.
    expect(yaml('["plain", "two words", "a-b_c.d", "x:y", "it\'s"]')).toBe(lines('- plain', '- two words', '- a-b_c.d', '- x:y', "- it's"));
    // And both versions of YAML read every one back as the same string.
    expect(value(out)).toEqual(strings);
  });

  it('keeps a "__proto__" key as data', () => {
    expect(yaml('{"__proto__": {"x": 1}, "constructor": "c", "toString": null}')).toBe(lines('__proto__:', '  x: 1', 'constructor: c', 'toString: null'));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('writes empty containers, scalars and nesting', () => {
    expect(yaml('{"a":{},"b":[],"c":"","d":null,"e":[[]],"f":[{}],"g":true,"h":false}')).toBe(lines('a: {}', 'b: []', 'c: ""', 'd: null', 'e:', '  - []', 'f:', '  - {}', 'g: true', 'h: false'));
    expect(yaml('"just a string"')).toBe('just a string\n');
    expect(yaml('42')).toBe('42\n');
    expect(yaml('null')).toBe('null\n');
    expect(yaml('{}')).toBe('{}\n');
    expect(yaml('[]')).toBe('[]\n');
    expect(yaml('{"a":{"b":{"c":[1,{"d":2}]}}}')).toBe(lines('a:', '  b:', '    c:', '      - 1', '      - d: 2'));
    expect(yaml('{"a":{"b":{"c":1}}}', 4)).toBe(lines('a:', '    b:', '        c: 1'));
  });

  it('skips a byte order mark', () => {
    expect(yaml(`${String.fromCharCode(0xfeff)}{"a":1}`)).toBe('a: 1\n');
  });

  it('keeps object order and long strings on one line', () => {
    expect(yaml('{"z":1,"a":2,"m":3}')).toBe(lines('z: 1', 'a: 2', 'm: 3'));
    const long = 'word '.repeat(60).trim();
    expect(yaml(JSON.stringify({ long }))).toBe(`long: ${long}\n`);
  });

  it('refuses nesting deeper than the limit', () => {
    const nest = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expect(jsonToYaml(nest(YAML_LIMITS.depth)).ok).toBe(true);
    expect(bad(jsonToYaml(nest(YAML_LIMITS.depth + 1))).errors[0].message).toContain('limit');
  });

  it('round-trips seeded random JSON through YAML and back', () => {
    const random = rng(4403);
    const ch = (...codes: number[]) => String.fromCodePoint(...codes);
    const pieces = [
      'a', 'B', ' ', '  ', ':', ': ', '#', ' #', '-', '- ', '"', "'", '\n', '\n\n', '\t', '\r', '\\', '{', '}', '[', ']', ',', '&', '*', '!', '|', '>', '%', '@', '`', '?', '=', '~',
      'yes', 'null', 'true', '0', '1.5', '0x1', '<<', '---', '...', ch(0xe9), ch(0x4e2d, 0x6587), ch(0x1f600), ch(0xa0), ch(0x2028), ch(0x85), ch(0xfeff), ch(0x7f), ch(0x1b), ch(0),
    ];
    const text = () => Array.from({ length: Math.floor(random() * 6) }, () => pick(random, pieces)).join('');
    const make = (depth: number): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.35) return text();
      if (roll < 0.45) return Math.floor(random() * 2000) - 1000;
      if (roll < 0.5) return Math.round(random() * 1e6) / 1000;
      if (roll < 0.55) return pick(random, [true, false, null]);
      if (roll < 0.78) return Array.from({ length: Math.floor(random() * 4) }, () => make(depth + 1));
      const entries: [string, unknown][] = [];
      const used = new Set<string>();
      for (let i = Math.floor(random() * 4); i > 0; i--) {
        const key = text();
        if (used.has(key)) continue;
        used.add(key);
        entries.push([key, make(depth + 1)]);
      }
      return new Map(entries);
    };
    // A Map keeps "__proto__" and number-like names in insertion order when written by hand.
    const write = (v: unknown): string => {
      if (v instanceof Map) return `{${[...v].map(([k, x]) => `${JSON.stringify(k)}:${write(x)}`).join(',')}}`;
      if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
      return JSON.stringify(v);
    };
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const source = write(make(0));
      const asYaml = jsonToYaml(source);
      expect(asYaml.ok, source).toBe(true);
      const back = yamlToJson(good(asYaml).output, '');
      expect(back.ok, `${source}\n${good(asYaml).output}`).toBe(true);
      expect(good(back).output, source).toBe(`${source}\n`);
      for (const indent of [4] as const) expect(good(yamlToJson(good(jsonToYaml(source, indent)).output, '')).output).toBe(`${source}\n`);
      checked++;
    }
    expect(checked).toBe(3000);
  });
});

describe('YAML performance at practical sizes', () => {
  const build = (chars: number) => {
    const rows: string[] = [];
    let size = 0;
    for (let i = 0; size < chars; i++) {
      const row = `- id: ${i}\n  name: "host-${i}.example.internal"\n  tags: [web, prod, "zone ${i % 7}"]\n  weight: ${(i % 100) / 10}\n  enabled: ${i % 2 === 0}\n`;
      rows.push(row);
      size += row.length;
    }
    return rows.join('');
  };

  it('formats and converts 1 MB within loose bounds', () => {
    const text = build(1_000_000);
    let started = Date.now();
    expect(yamlToJson(text).ok).toBe(true);
    const toJson = Date.now() - started;
    started = Date.now();
    expect(formatYaml(text).ok).toBe(true);
    const format = Date.now() - started;
    started = Date.now();
    const jsonText = good(yamlToJson(text, '')).output;
    expect(jsonToYaml(jsonText).ok).toBe(true);
    expect(toJson).toBeLessThan(15_000);
    expect(format).toBeLessThan(15_000);
  });
});
