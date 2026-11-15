/** The HCL writer: string escaping, identifiers and value layout. */
import { describe, expect, it } from 'vitest';
import { HclRaw, hasLoneSurrogate, hclString, hclValue, isHclIdentifier } from '../../src/core/infra/hcl';

const C = (...codes: number[]) => String.fromCharCode(...codes);
const BS = C(92);
const Q = '"';
const U = (code: number) => `${BS}u${code.toString(16).padStart(4, '0')}`;

/** Decodes an HCL quoted string the way the native syntax specification describes it. Test-local. */
function decode(text: string): string {
  expect(text.startsWith(Q) && text.endsWith(Q) && text.length >= 2).toBe(true);
  const body = text.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === BS) {
      const next = body[i + 1]!;
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === Q) out += Q;
      else if (next === BS) out += BS;
      else if (next === 'u') { out += C(parseInt(body.slice(i + 2, i + 6), 16)); i += 4; }
      else throw new Error(`unknown escape ${next}`);
      i++;
    } else if ((ch === '$' || ch === '%') && body[i + 1] === ch && body[i + 2] === '{') {
      out += `${ch}{`;
      i += 2;
    } else if ((ch === '$' || ch === '%') && body[i + 1] === '{') {
      throw new Error('a template sequence would be evaluated');
    } else if (ch === Q) {
      throw new Error('an unescaped quote ends the string early');
    } else if (ch === '\n' || ch === '\r') {
      throw new Error('a raw line break inside a quoted string');
    } else out += ch;
  }
  return out;
}

describe('hasLoneSurrogate', () => {
  it('accepts text without surrogates and well-formed pairs', () => {
    expect(hasLoneSurrogate('')).toBe(false);
    expect(hasLoneSurrogate('plain')).toBe(false);
    expect(hasLoneSurrogate(String.fromCodePoint(0x1f600))).toBe(false);
    expect(hasLoneSurrogate(`a${String.fromCodePoint(0x1f600, 0x10ffff)}b`)).toBe(false);
    expect(hasLoneSurrogate(C(0xd7ff, 0xe000))).toBe(false);
  });

  it('finds a lone high or low surrogate anywhere', () => {
    expect(hasLoneSurrogate(C(0xd800))).toBe(true);
    expect(hasLoneSurrogate(C(0xdbff))).toBe(true);
    expect(hasLoneSurrogate(C(0xdc00))).toBe(true);
    expect(hasLoneSurrogate(C(0xdfff))).toBe(true);
    expect(hasLoneSurrogate(`a${C(0xd800)}b`)).toBe(true);
    expect(hasLoneSurrogate(`a${C(0xdc00)}`)).toBe(true);
    expect(hasLoneSurrogate(C(0xdc00, 0xd800))).toBe(true);
    expect(hasLoneSurrogate(C(0xd800, 0xd800, 0xdc00))).toBe(true);
    expect(hasLoneSurrogate(C(0xd83d, 0xde00, 0xde00))).toBe(true);
    expect(hasLoneSurrogate(C(0xd800, 0x41))).toBe(true);
  });
});

describe('hclString', () => {
  it('quotes plain text unchanged', () => {
    expect(hclString('')).toBe('""');
    expect(hclString('Users')).toBe('"Users"');
    expect(hclString('10.10.0.0/16')).toBe('"10.10.0.0/16"');
    expect(hclString('a b # c // d /* e */')).toBe('"a b # c // d /* e */"');
  });

  it('escapes the backslash and the double quote', () => {
    expect(hclString(BS)).toBe(`${Q}${BS}${BS}${Q}`);
    expect(hclString(Q)).toBe(`${Q}${BS}${Q}${Q}`);
    expect(hclString(`a${BS}${Q}b`)).toBe(`${Q}a${BS}${BS}${BS}${Q}b${Q}`);
    expect(hclString(`${BS}n`)).toBe(`${Q}${BS}${BS}n${Q}`);
    expect(hclString(`end${BS}`)).toBe(`${Q}end${BS}${BS}${Q}`);
  });

  it('writes line breaks and tabs with their escapes', () => {
    expect(hclString('a\nb')).toBe(`${Q}a${BS}nb${Q}`);
    expect(hclString('a\rb')).toBe(`${Q}a${BS}rb${Q}`);
    expect(hclString('a\tb')).toBe(`${Q}a${BS}tb${Q}`);
    expect(hclString('\r\n')).toBe(`${Q}${BS}r${BS}n${Q}`);
  });

  it('doubles the opener of both template sequences, and only then', () => {
    expect(hclString('${x}')).toBe('"$${x}"');
    expect(hclString('%{if x}')).toBe('"%%{if x}"');
    expect(hclString('$${x}')).toBe('"$$${x}"');
    expect(hclString('%%{x}')).toBe('"%%%{x}"');
    expect(hclString('a${b}c${d}')).toBe('"a$${b}c$${d}"');
    expect(hclString('$')).toBe('"$"');
    expect(hclString('%')).toBe('"%"');
    expect(hclString('$$')).toBe('"$$"');
    expect(hclString('100% {x}')).toBe('"100% {x}"');
    expect(hclString('$ {x}')).toBe('"$ {x}"');
    expect(hclString('cost: $5')).toBe('"cost: $5"');
    expect(hclString('end$')).toBe('"end$"');
    expect(hclString('{$}')).toBe('"{$}"');
  });

  it('writes every other control and invisible formatting character as a four-digit escape', () => {
    const escaped = [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
    for (const code of escaped) expect(hclString(`a${C(code)}b`), code.toString(16)).toBe(`${Q}a${U(code)}b${Q}`);
  });

  it('escapes all of C0 (except tab and the line breaks), DEL and C1', () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code >= 0x20 && code < 0x7f) continue;
      const s = hclString(C(code))!;
      if (code === 9) expect(s).toBe(`${Q}${BS}t${Q}`);
      else if (code === 10) expect(s).toBe(`${Q}${BS}n${Q}`);
      else if (code === 13) expect(s).toBe(`${Q}${BS}r${Q}`);
      else expect(s, String(code)).toBe(`${Q}${U(code)}${Q}`);
    }
  });

  it('leaves printable ASCII and ordinary Unicode as it is', () => {
    for (let code = 0x20; code < 0x7f; code++) {
      if (code === 0x22 || code === 0x5c) continue;
      expect(hclString(C(code))).toBe(`${Q}${C(code)}${Q}`);
    }
    for (const code of [0xa0, 0xe9, 0x200d, 0x2027, 0x202f, 0x2065, 0x206a, 0x4e2d, 0xfefe, 0xff00, 0xfffd]) expect(hclString(C(code)), code.toString(16)).toBe(`${Q}${C(code)}${Q}`);
    const astral = String.fromCodePoint(0x1f600);
    expect(hclString(astral)).toBe(`${Q}${astral}${Q}`);
  });

  it('never leaves a raw line break, an unescaped quote or a live template in the output', () => {
    const samples = [
      `${Q}} resource ${Q}x${Q} ${Q}y${Q} {`, '<<EOT\nline\nEOT', '${file("/etc/passwd")}', '%{ for x in y }${x}%{ endfor }', `a${BS}${Q}`, `${BS}${BS}${Q}`,
      `$${BS}{x}`, '$${$${', `${C(0x2028)}resource${C(0x2029)}`, `tab\tcr\rlf\n`, `${BS}u0041`, `nul${C(0)}end`, '#!/bin/sh', '*/ }',
    ];
    for (const s of samples) {
      const written = hclString(s)!;
      expect(/[\r\n]/.test(written), s).toBe(false);
      expect(decode(written), s).toBe(s);
    }
  });

  it('round-trips every pair of troublesome characters', () => {
    const atoms = ['$', '%', '{', '}', BS, Q, '\n', 'u', 'n', C(0), C(0x2028), ' '];
    for (const a of atoms) for (const b of atoms) for (const c of atoms) {
      const s = a + b + c;
      expect(decode(hclString(s)!)).toBe(s);
    }
  });

  it('refuses a string with a lone surrogate', () => {
    expect(hclString(C(0xd800))).toBeNull();
    expect(hclString(`ok${C(0xdfff)}`)).toBeNull();
    expect(hclString(C(0xd83d, 0xde00))).not.toBeNull();
  });
});

describe('isHclIdentifier', () => {
  it('accepts letters, digits and underscores that do not start with a digit', () => {
    for (const ok of ['a', 'A', '_', '_a1', 'vlan_10_users', 'Name', 'x9']) expect(isHclIdentifier(ok), ok).toBe(true);
  });

  it('refuses everything else', () => {
    for (const bad of ['', '1a', 'netforge:site', 'a-b', 'a.b', 'a b', 'a"b', ' a', 'a ', `a${C(0xe9)}`, 'a\n', '${a}', 'a=b']) expect(isHclIdentifier(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe('hclValue', () => {
  it('writes scalars', () => {
    expect(hclValue(null)).toBe('null');
    expect(hclValue(true)).toBe('true');
    expect(hclValue(false)).toBe('false');
    expect(hclValue(0)).toBe('0');
    expect(hclValue(4094)).toBe('4094');
    expect(hclValue(-3)).toBe('-3');
    expect(hclValue('x')).toBe('"x"');
    expect(hclValue('${x}')).toBe('"$${x}"');
  });

  it('refuses numbers that are not whole and safe', () => {
    expect(() => hclValue(1.5)).toThrow();
    expect(() => hclValue(Number.NaN)).toThrow();
    expect(() => hclValue(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => hclValue(2 ** 53)).toThrow();
  });

  it('throws on a lone surrogate instead of writing a damaged string', () => {
    expect(() => hclValue(C(0xd800))).toThrow();
    expect(() => hclValue({ a: [C(0xdc00)] })).toThrow();
    expect(() => hclValue({ [C(0xd800)]: 'x' })).toThrow();
  });

  it('writes raw expressions untouched', () => {
    expect(hclValue(new HclRaw('aws_vpc.x.id'))).toBe('aws_vpc.x.id');
    expect(hclValue({ vpc_id: new HclRaw('aws_vpc.x.id') })).toBe('{\n  vpc_id = aws_vpc.x.id\n}');
  });

  it('writes lists: empty, scalars on one line, objects one per line with a trailing comma', () => {
    expect(hclValue([])).toBe('[]');
    expect(hclValue(['a', 'b'])).toBe('["a", "b"]');
    expect(hclValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(hclValue(['a', 1])).toBe('["a", 1]');
    expect(hclValue([{ a: 1 }])).toBe('[\n  {\n    a = 1\n  },\n]');
    expect(hclValue([null])).toBe('[\n  null,\n]');
    expect(hclValue([['a'], []])).toBe('[\n  ["a"],\n  [],\n]');
  });

  it('writes objects with bare identifier keys, quoted other keys and aligned equals signs', () => {
    expect(hclValue({})).toBe('{}');
    expect(hclValue({ a: 1 })).toBe('{\n  a = 1\n}');
    // The "terraform fmt" layout: a value that spans lines is not padded and ends the aligned run.
    expect(hclValue({ a: 1, long_name: 'x', tags: { k: 'v' }, b: 2, after: [], list: [{ z: 1 }], c: 3 })).toBe('{\n  a         = 1\n  long_name = "x"\n  tags = {\n    k = "v"\n  }\n  b     = 2\n  after = []\n  list = [\n    {\n      z = 1\n    },\n  ]\n  c = 3\n}');
    expect(hclValue({ first: { k: 'v' }, second_longer: { k: 'v' } })).toBe('{\n  first = {\n    k = "v"\n  }\n  second_longer = {\n    k = "v"\n  }\n}');
    expect(hclValue({ Name: 'x', 'netforge:site': 'y' })).toBe('{\n  Name            = "x"\n  "netforge:site" = "y"\n}');
    expect(hclValue({ '1a': 1, 'a b': 2, '': 3 })).toBe('{\n  "1a"  = 1\n  "a b" = 2\n  ""    = 3\n}');
    expect(hclValue({ '${x}': 1 })).toBe('{\n  "$${x}" = 1\n}');
    expect(hclValue({ [`k${Q}`]: 1 })).toBe(`{\n  ${Q}k${BS}${Q}${Q} = 1\n}`);
  });

  it('indents nested values by two spaces per level', () => {
    expect(hclValue({ a: { b: { c: [{ d: 'e' }] } } })).toBe('{\n  a = {\n    b = {\n      c = [\n        {\n          d = "e"\n        },\n      ]\n    }\n  }\n}');
    expect(hclValue({ a: 1 }, 2)).toBe('{\n      a = 1\n    }');
    expect(hclValue([{ a: 1 }], 1)).toBe('[\n    {\n      a = 1\n    },\n  ]');
  });

  it('keeps object entries in insertion order', () => {
    expect(hclValue({ z: 1, a: 2, m: 3 })).toBe('{\n  z = 1\n  a = 2\n  m = 3\n}');
  });
});
