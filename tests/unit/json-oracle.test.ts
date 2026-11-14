/**
 * The JSON engine against the JavaScript engine's own JSON implementation (an independent one):
 * - formatting random documents must match JSON.stringify byte for byte;
 * - accept/reject verdicts on thousands of mutated documents must match JSON.parse.
 */
import { describe, expect, it } from 'vitest';
import { analyzeJson } from '../../src/core/data/json';
import { pick, rng } from '../helpers';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const STRING_CHARS = ['a', 'Z', '0', ' ', '"', String.fromCharCode(0x5c), '/', String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(1),
  String.fromCharCode(0xe9), String.fromCharCode(0x4e2d), String.fromCodePoint(0x1f600), String.fromCharCode(0x2028), String.fromCharCode(0x7f)];

function randomString(random: () => number): string {
  let s = '';
  const n = Math.floor(random() * 8);
  for (let i = 0; i < n; i++) s += pick(random, STRING_CHARS);
  return s;
}

function randomValue(random: () => number, depth: number): Json {
  const roll = random();
  if (depth > 4 || roll < 0.45) {
    const kind = Math.floor(random() * 6);
    if (kind === 0) return null;
    if (kind === 1) return random() < 0.5;
    if (kind === 2) return Math.floor((random() - 0.5) * 2 ** 40);
    if (kind === 3) return (random() - 0.5) * 10 ** Math.floor(random() * 30 - 10);
    return randomString(random);
  }
  if (roll < 0.72) return Array.from({ length: Math.floor(random() * 5) }, () => randomValue(random, depth + 1));
  const obj: { [key: string]: Json } = {};
  const n = Math.floor(random() * 5);
  for (let i = 0; i < n; i++) obj[randomString(random) + i] = randomValue(random, depth + 1);
  return obj;
}

describe('formatting matches JSON.stringify', () => {
  const random = rng(8259);
  const docs = Array.from({ length: 600 }, () => randomValue(random, 0));

  it('generates varied documents (sanity check of the generator)', () => {
    const kinds = new Set(docs.map(d => (Array.isArray(d) ? 'array' : d === null ? 'null' : typeof d)));
    expect(kinds).toEqual(new Set(['array', 'object', 'string', 'number', 'boolean', 'null']));
    expect(docs.filter(d => JSON.stringify(d).length > 40).length).toBeGreaterThan(100);
  });

  it.each([
    ['minified', { kind: 'minify' } as const, undefined],
    ['2 spaces', { kind: 'pretty', indent: '  ' } as const, 2],
    ['4 spaces', { kind: 'pretty', indent: '    ' } as const, 4],
    ['tab', { kind: 'pretty', indent: String.fromCharCode(9) } as const, String.fromCharCode(9)],
  ])('%s', (_name, format, space) => {
    const mismatches: string[] = [];
    for (const doc of docs) {
      const source = JSON.stringify(doc, null, 3);
      const r = analyzeJson(source, format);
      const want = JSON.stringify(doc, null, space);
      if (!r.ok || r.output !== want) mismatches.push(source.slice(0, 80));
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips: minifying pretty output gives back the minified document', () => {
    for (const doc of docs.slice(0, 200)) {
      const text = JSON.stringify(doc);
      const pretty = analyzeJson(text, { kind: 'pretty', indent: '  ' });
      expect(pretty.ok).toBe(true);
      if (pretty.ok) expect(analyzeJson(pretty.output!, { kind: 'minify' })).toMatchObject({ ok: true, output: text });
    }
  });
});

describe('validity matches JSON.parse', () => {
  const ALPHABET = ['{', '}', '[', ']', ':', ',', '"', String.fromCharCode(0x5c), ' ', String.fromCharCode(10), String.fromCharCode(9),
    '0', '1', '9', '-', '+', '.', 'e', 'E', 't', 'r', 'u', 'f', 'a', 'l', 's', 'n', 'x', "'", '/', '*', String.fromCharCode(0xa0)];

  function mutate(random: () => number, text: string): string {
    const chars = [...text];
    const edits = 1 + Math.floor(random() * 3);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(random() * (chars.length + 1));
      const op = random();
      if (op < 0.35 && chars.length > 0) chars.splice(Math.min(at, chars.length - 1), 1);
      else if (op < 0.75) chars.splice(at, 0, pick(random, ALPHABET));
      else if (chars.length > 0) chars[Math.min(at, chars.length - 1)] = pick(random, ALPHABET);
    }
    return chars.join('');
  }

  function parses(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  it('agrees on 6,000 mutated documents, with both verdicts well represented', () => {
    const random = rng(4627);
    const disagreements: string[] = [];
    let valid = 0;
    for (let i = 0; i < 6000; i++) {
      const base = JSON.stringify(randomValue(random, 0), null, random() < 0.5 ? 1 : undefined);
      const text = mutate(random, base);
      const expected = parses(text);
      if (expected) valid++;
      if (analyzeJson(text).ok !== expected) disagreements.push(`${JSON.stringify(text)}: JSON.parse ${expected ? 'accepts' : 'rejects'}`);
    }
    expect(disagreements.slice(0, 20)).toEqual([]);
    // Guard against a generator that only ever produces one kind of case.
    expect(valid).toBeGreaterThan(600);
    expect(6000 - valid).toBeGreaterThan(2000);
  });

  it.each([
    ' ', '"', '[', '{', '-', '1.', '01', '[1,]', '{"a":1,}', 'tRue', '"\t"', '"\u001f"', '1 2', '{"a" 1}', '[1:2]',
    '{"a":1}', '[]', '{}', '-0', '1E+2', `"${String.fromCharCode(0x2028)}"`, '[[[]]]', '0.5e-3', '"\ud800"',
  ].map(s => [s]))('agrees on %j', text => {
    let expected = true;
    try {
      JSON.parse(text);
    } catch {
      expected = false;
    }
    expect(analyzeJson(text).ok).toBe(expected);
  });
});
