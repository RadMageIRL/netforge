/**
 * The regex engine wrapper: matches, groups, zero-length handling, the replacement preview checked
 * against the engine's own String.prototype.replace, and every limit. No pattern here can run
 * away: catastrophic patterns are only ever run on a worker thread (see task-runner.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseReplacement, REGEX_FLAGS, REGEX_LIMITS, runRegex, scanGroupNames, type RegexResponse } from '../../src/core/regex/run';
import { pick, rng } from '../helpers';

type Ok = Extract<RegexResponse, { ok: true }>;

function run(pattern: string, flags: string, text: string, replacement: string | null = null): Ok {
  const r = runRegex({ pattern, flags, text, replacement });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

function code(pattern: string, flags: string, text = '', replacement: string | null = null): string {
  const r = runRegex({ pattern, flags, text, replacement });
  return r.ok ? 'ok' : r.code;
}

const pairs = (r: Ok): [number, number][] => r.matches.map(m => [m.start, m.end]);
const values = (r: Ok): string[] => r.matches.map(m => m.value.text);

/** U+1F600, a character outside the Basic Multilingual Plane (two UTF-16 units). */
const ASTRAL = String.fromCodePoint(0x1f600);
const LF = String.fromCharCode(10);

describe('matches and flags', () => {
  it('reports every match with UTF-16 offsets when global', () => {
    const r = run('\\d+', 'g', 'a12b345');
    expect(pairs(r)).toEqual([[1, 3], [4, 7]]);
    expect(values(r)).toEqual(['12', '345']);
    expect(r.spans).toEqual([1, 3, 4, 7]);
    expect(r.total).toBe(2);
    expect(r.zeroLength).toBe(0);
    expect(r.detailLimit).toBeNull();
    expect(r.replaced).toBeNull();
    expect(r.replacedNote).toBeNull();
  });

  it('reports only the first match without the g flag', () => {
    const r = run('\\d+', '', 'a12b345');
    expect(pairs(r)).toEqual([[1, 3]]);
    expect(r.total).toBe(1);
    expect(run('\\d+', '', 'a12b345', '#').replaced).toBe('a#b345');
    // Even a zero-length first match ends the run.
    expect(run('x*', '', 'abc').total).toBe(1);
  });

  it('reports no match as zero matches, with the group structure still known', () => {
    const r = run('(?<n>z)(q)', 'g', 'abc', '-');
    expect(r.total).toBe(0);
    expect(r.matches).toEqual([]);
    expect(r.groupCount).toBe(2);
    expect(r.groupNames).toEqual(['n']);
    expect(r.replaced).toBe('abc');
  });

  it('i ignores case', () => {
    expect(values(run('ab', 'gi', 'AB ab aB'))).toEqual(['AB', 'ab', 'aB']);
    expect(run('ab', 'g', 'AB ab aB').total).toBe(1);
  });

  it('m makes ^ and $ match at line breaks', () => {
    expect(pairs(run('^\\w+$', 'gm', `one${LF}two`))).toEqual([[0, 3], [4, 7]]);
    expect(run('^\\w+$', 'g', `one${LF}two`).total).toBe(0);
  });

  it('s makes the dot match line breaks', () => {
    expect(pairs(run('a.b', 's', `a${LF}b`))).toEqual([[0, 3]]);
    expect(run('a.b', '', `a${LF}b`).total).toBe(0);
  });

  it('u and v match whole code points', () => {
    expect(pairs(run('.', 'gu', `a${ASTRAL}b`))).toEqual([[0, 1], [1, 3], [3, 4]]);
    expect(pairs(run('.', 'gv', `a${ASTRAL}b`))).toEqual([[0, 1], [1, 3], [3, 4]]);
    expect(pairs(run('.', 'g', `a${ASTRAL}b`))).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
    expect(values(run('\\p{Lu}', 'gu', 'aBcD'))).toEqual(['B', 'D']);
  });

  it('v supports set operations in classes', () => {
    expect(values(run('[\\p{L}--[a-c]]+', 'gv', 'abcdef abz'))).toEqual(['def', 'z']);
  });

  it('y matches only at the current position', () => {
    expect(run('b', 'y', 'ab').total).toBe(0);
    expect(pairs(run('a', 'y', 'aab'))).toEqual([[0, 1]]);
    // Sticky and global: consecutive matches from the start, stopping at the first gap.
    expect(pairs(run('a', 'gy', 'aabaa'))).toEqual([[0, 1], [1, 2]]);
    expect(run('a', 'gy', 'aabaa', '-').replaced).toBe('--baa');
  });

  it('d is accepted and changes nothing', () => {
    expect(pairs(run('(b)', 'gd', 'abab'))).toEqual(pairs(run('(b)', 'g', 'abab')));
    expect(run('(b)', 'd', 'ab').matches[0].groups[0]).toMatchObject({ start: 1, end: 2 });
  });

  it('lists the JavaScript flags', () => {
    expect([...REGEX_FLAGS].sort()).toEqual(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
    expect(code('a', 'dgimsuy', 'a')).toBe('ok');
    expect(code('a', 'dgimsvy', 'a')).toBe('ok');
  });
});

describe('errors', () => {
  it('rejects unknown, repeated and conflicting flags', () => {
    expect(code('a', 'x')).toBe('flags');
    expect(code('a', 'G')).toBe('flags');
    expect(code('a', 'gg')).toBe('flags');
    expect(code('a', 'gig')).toBe('flags');
    expect(code('a', 'uv')).toBe('flags');
    expect(code('a', 'vu')).toBe('flags');
  });

  it('reports pattern syntax errors without throwing', () => {
    for (const bad of ['(', '[a', 'a**', '(?<n>a)(?<n>b)', '\\', '(?<=a)+']) expect(code(bad, 'u')).toBe('pattern-syntax');
    expect(code('\\p{Nope}', 'u')).toBe('pattern-syntax');
    expect(code('a{2,1}', '')).toBe('pattern-syntax');
    const r = runRegex({ pattern: '(', flags: '', text: '', replacement: null });
    expect(r.ok === false && r.message.includes('not a valid JavaScript regular expression')).toBe(true);
  });

  it('asks for a pattern', () => {
    expect(code('', 'g', 'abc')).toBe('pattern-empty');
  });

  it('refuses oversized input instead of cutting it', () => {
    expect(code('a'.repeat(REGEX_LIMITS.patternChars), '', 'a')).toBe('ok');
    expect(code('a'.repeat(REGEX_LIMITS.patternChars + 1), '', 'a')).toBe('too-large');
    expect(code('a', '', 'b'.repeat(REGEX_LIMITS.textChars))).toBe('ok');
    expect(code('a', '', 'b'.repeat(REGEX_LIMITS.textChars + 1))).toBe('too-large');
    expect(code('a', '', 'b', 'r'.repeat(REGEX_LIMITS.replacementChars))).toBe('ok');
    expect(code('a', '', 'b', 'r'.repeat(REGEX_LIMITS.replacementChars + 1))).toBe('too-large');
    // Size is checked before the pattern is even looked at.
    expect(code('(', '', 'b'.repeat(REGEX_LIMITS.textChars + 1))).toBe('too-large');
  });
});

describe('capture groups', () => {
  it('reports numbered groups with their positions', () => {
    const r = run('(\\d+)-(\\d+)', 'g', 'x 10-20 y 3-4');
    expect(r.groupCount).toBe(2);
    expect(r.matches[0].groups).toEqual([
      { number: 1, name: null, value: { text: '10', length: 2 }, start: 2, end: 4 },
      { number: 2, name: null, value: { text: '20', length: 2 }, start: 5, end: 7 },
    ]);
    expect(r.matches[1].groups.map(g => [g.value?.text, g.start, g.end])).toEqual([['3', 10, 11], ['4', 12, 13]]);
  });

  it('marks a group that took no part as null, which is not the same as empty', () => {
    const r = run('(a)|(b)|(c*)', 'g', 'bax');
    expect(r.matches[0].groups.map(g => g.value)).toEqual([null, { text: 'b', length: 1 }, null]);
    expect(r.matches[0].groups[0]).toMatchObject({ start: -1, end: -1 });
    expect(r.matches[1].groups.map(g => g.value)).toEqual([{ text: 'a', length: 1 }, null, null]);
    // The third alternative matched the empty string: a real, empty capture.
    expect(r.matches[2].groups[2]).toEqual({ number: 3, name: null, value: { text: '', length: 0 }, start: 2, end: 2 });
  });

  it('names named groups, by number', () => {
    const r = run('(?<year>\\d{4})-(\\d\\d)-(?<day>\\d\\d)', '', 'on 2026-11-14');
    expect(r.groupNames).toEqual(['year', 'day']);
    expect(r.matches[0].groups.map(g => [g.number, g.name, g.value?.text])).toEqual([[1, 'year', '2026'], [2, null, '11'], [3, 'day', '14']]);
  });

  it('names groups even when the first match does not use them', () => {
    const r = run('(?<a>x)|(?<b>y)', 'g', 'yx');
    expect(r.matches[0].groups).toEqual([
      { number: 1, name: 'a', value: null, start: -1, end: -1 },
      { number: 2, name: 'b', value: { text: 'y', length: 1 }, start: 0, end: 1 },
    ]);
    expect(r.matches[1].groups.map(g => [g.name, g.value?.text ?? null])).toEqual([['a', 'x'], ['b', null]]);
  });

  it('handles the same name in different alternatives', () => {
    const r = run('(?<y>\\d{4})-\\d\\d|\\d\\d-(?<y>\\d{4})', 'g', '2026-11 12-2027', '$<y>');
    expect(r.groupCount).toBe(2);
    expect(r.groupNames).toEqual(['y']);
    expect(r.matches[0].groups.map(g => [g.name, g.value?.text ?? null])).toEqual([['y', '2026'], ['y', null]]);
    expect(r.matches[1].groups.map(g => [g.name, g.value?.text ?? null])).toEqual([['y', null], ['y', '2027']]);
    expect(r.replaced).toBe('2026 2027');
  });

  it('does not count parentheses in classes, escapes, lookarounds or non-capturing groups', () => {
    expect(scanGroupNames('[(](a)\\((?:b)(?<n>c)(?=d)(?<=e)(?<!f)(?!g)', false)).toEqual([null, null, 'n']);
    expect(scanGroupNames('[\\]()](x)', false)).toEqual([null, null]);
    // Without v, "[" inside a class is a literal and the first "]" closes the class.
    expect(scanGroupNames('[[(](x)', false)).toEqual([null, null]);
    // With v, classes nest (and a parenthesis inside one must be escaped).
    expect(scanGroupNames('[[a-z]--[b]](x)(?<k>y)', true)).toEqual([null, null, 'k']);
    expect(scanGroupNames('abc', false)).toEqual([null]);
    expect(scanGroupNames('(?<a>(?<b>x))', false)).toEqual([null, 'a', 'b']);

    const r = run('[(](a)\\((?:b)(?<n>c)', '', '(a(bc');
    expect(r.matches[0].groups.map(g => [g.number, g.name, g.value?.text])).toEqual([[1, null, 'a'], [2, 'n', 'c']]);
    const v = run('[[a-z]--[b]](x)(?<k>y)', 'v', 'cxy');
    expect(v.matches[0].groups.map(g => [g.number, g.name, g.value?.text])).toEqual([[1, null, 'x'], [2, 'k', 'y']]);
  });

  it('agrees with the engine about group names for many patterns', () => {
    const patterns = [
      '(a)(?<b>b)', '(?<x>a)|(?<y>b)|(c)', '(?:a)(b)[(](?<z>c)', '\\((?<q>a)\\)', '(?<=a)(?<n>b)', '(?<!a)(b)(?<m>c)?',
      '((?<in>a)b)+', '[\\[(](?<k>a)', '(?<a1>a)(?<a2>(?<a3>b))', '(a)\\1(?<r>b)\\k<r>',
    ];
    for (const pattern of patterns) {
      const probe = new RegExp(`${pattern}|`).exec('')!;
      const names = scanGroupNames(pattern, false);
      expect(names.length, pattern).toBe(probe.length);
      expect(names.filter(n => n !== null).sort(), pattern).toEqual(Object.keys(probe.groups ?? {}).sort());
    }
  });
});

describe('zero-length matches', () => {
  const starts = (r: Ok) => r.matches.map(m => m.start);

  it('finds one empty match at every position and stops', () => {
    const r = run('x*', 'g', 'abc');
    expect(pairs(r)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    expect(r.zeroLength).toBe(4);
    expect(r.total).toBe(4);
  });

  it('mixes empty and non-empty matches without skipping or repeating a position', () => {
    expect(pairs(run('\\d*', 'g', '1a22'))).toEqual([[0, 1], [1, 1], [2, 4], [4, 4]]);
    expect(run('\\d*', 'g', '1a22').zeroLength).toBe(2);
    expect(pairs(run('a|', 'g', 'bab'))).toEqual([[0, 0], [1, 2], [2, 2], [3, 3]]);
  });

  it('handles lookaheads, anchors and word boundaries', () => {
    expect(starts(run('(?=b)', 'g', 'abcb'))).toEqual([1, 3]);
    expect(starts(run('^', 'gm', `a${LF}b${LF}`))).toEqual([0, 2, 4]);
    expect(starts(run('$', 'gm', `a${LF}b${LF}`))).toEqual([1, 3, 4]);
    expect(starts(run('\\b', 'g', 'ab cd'))).toEqual([0, 2, 3, 5]);
    expect(starts(run('^', 'g', 'abc'))).toEqual([0]);
    expect(starts(run('$', 'g', 'abc'))).toEqual([3]);
  });

  it('matches the empty text once', () => {
    expect(pairs(run('x*', 'g', ''))).toEqual([[0, 0]]);
    expect(run('x*', 'g', '', '-').replaced).toBe('-');
  });

  it('steps by code point with u or v, by UTF-16 unit without', () => {
    const text = `a${ASTRAL}b`;
    expect(starts(run('(?:)', 'g', text))).toEqual([0, 1, 2, 3, 4]);
    expect(starts(run('(?:)', 'gu', text))).toEqual([0, 1, 3, 4]);
    expect(starts(run('(?:)', 'gv', text))).toEqual([0, 1, 3, 4]);
    // A lone high surrogate is one step, even with u.
    const lone = `a${ASTRAL[0]}b`;
    expect(starts(run('(?:)', 'gu', lone))).toEqual([0, 1, 2, 3]);
    expect(starts(run('(?:)', 'gu', `${ASTRAL}`))).toEqual([0, 2]);
  });

  it('agrees with matchAll for seeded random patterns, flags and texts', () => {
    const random = rng(4401);
    const patterns = ['x*', 'a*', '(?:)', '\\b', '^', '$', 'a|', '(?=a)', '(?<=a)', '(a)?', 'a*?', '\\B', '[ab]*', '(?!a)', '.*', '.*?', '\\s*', `${ASTRAL}?`];
    const flagSets = ['g', 'gm', 'gu', 'gv', 'gi', 'gs', 'gy', 'gmu'];
    const alphabet = ['a', 'b', ' ', LF, ASTRAL, ASTRAL[0], ASTRAL[1], 'x'];
    let compared = 0;
    for (let n = 0; n < 1500; n++) {
      const pattern = pick(random, patterns);
      const flags = pick(random, flagSets);
      const text = Array.from({ length: Math.floor(random() * 9) }, () => pick(random, alphabet)).join('');
      const expected = [...text.matchAll(new RegExp(pattern, flags))].map(m => [m.index, m.index + m[0].length]);
      const r = run(pattern, flags, text);
      expect(pairs(r), `${pattern} /${flags}`).toEqual(expected);
      expect(r.total).toBe(expected.length);
      compared++;
    }
    expect(compared).toBe(1500);
  });
});

describe('replacement preview', () => {
  it('parses replacement templates like String.prototype.replace', () => {
    expect(parseReplacement('a$$b', 0, false)).toEqual([{ kind: 'text', text: 'a$b' }]);
    expect(parseReplacement('$&$`$\'', 0, false)).toEqual([{ kind: 'match' }, { kind: 'before' }, { kind: 'after' }]);
    expect(parseReplacement('$1$2', 1, false)).toEqual([{ kind: 'group', number: 1 }, { kind: 'text', text: '$2' }]);
    // Two digits when that group exists, otherwise one digit and a literal digit.
    expect(parseReplacement('$10', 10, false)).toEqual([{ kind: 'group', number: 10 }]);
    expect(parseReplacement('$10', 9, false)).toEqual([{ kind: 'group', number: 1 }, { kind: 'text', text: '0' }]);
    expect(parseReplacement('$01', 3, false)).toEqual([{ kind: 'group', number: 1 }]);
    expect(parseReplacement('$0$00', 3, false)).toEqual([{ kind: 'text', text: '$0$00' }]);
    expect(parseReplacement('$<n>', 1, true)).toEqual([{ kind: 'named', name: 'n' }]);
    expect(parseReplacement('$<n>', 1, false)).toEqual([{ kind: 'text', text: '$<n>' }]);
    expect(parseReplacement('$<n', 1, true)).toEqual([{ kind: 'text', text: '$<n' }]);
    expect(parseReplacement('$', 1, true)).toEqual([{ kind: 'text', text: '$' }]);
    expect(parseReplacement('$x$', 1, true)).toEqual([{ kind: 'text', text: '$x$' }]);
    expect(parseReplacement('', 1, true)).toEqual([]);
  });

  it('replaces every match when global and the first otherwise', () => {
    expect(run('(\\w+)@(\\w+)', 'g', 'a@b c@d', '$2 at $1').replaced).toBe('b at a d at c');
    expect(run('(\\w+)@(\\w+)', '', 'a@b c@d', '$2 at $1').replaced).toBe('b at a c@d');
    expect(run('b', 'g', 'abc', '[$`|$&|$\']').replaced).toBe('a[a|b|c]c');
    expect(run('(?<w>b)', 'g', 'abc', '<$<w>$<nope>>').replaced).toBe('a<b>c');
    expect(run('(a)|(b)', 'g', 'ab', '[$1$2]').replaced).toBe('[a][b]');
    expect(run('x*', 'g', 'ab', '-').replaced).toBe('-a-b-');
    expect(run('a', 'g', 'aaa', '').replaced).toBe('');
    expect(run('a', 'g', 'aaa', '$$').replaced).toBe('$$$');
  });

  it('returns no preview unless one is asked for', () => {
    expect(run('a', 'g', 'aaa').replaced).toBeNull();
    expect(run('a', 'g', 'aaa', '').replaced).toBe('');
  });

  it('produces exactly what the engine produces, for seeded random cases', () => {
    const random = rng(4402);
    const patterns = [
      'a', '(a)(b)?', '(?<x>a)|(?<y>b)', 'x*', '(a|b)+', '(\\w)(\\d)?', '(?<n>\\d+)', '\\b', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)',
      '[ab]', '(?<first>.)(?<second>.)?', '(?=(a))', '(.)\\1', '\\s+', `(${ASTRAL})|(.)`, '^', '$', '(b*)',
    ];
    const flagSets = ['g', '', 'gi', 'gu', 'gm', 'gs', 'gy', 'y', 'gv', 'u'];
    const alphabet = ['a', 'b', 'c', '1', '2', ' ', LF, ASTRAL, '$', 'abcdefghijk'];
    const tokens = ['$$', '$&', '$`', "$'", '$1', '$2', '$3', '$9', '$0', '$00', '$01', '$10', '$11', '$12', '$99', '$<x>', '$<y>', '$<n>', '$<first>', '$<second>', '$<nope>', '$<', '$', 'z', '-', '<', '>', '0', ' '];
    let compared = 0;
    for (let n = 0; n < 4000; n++) {
      const pattern = pick(random, patterns);
      const flags = pick(random, flagSets);
      const text = Array.from({ length: Math.floor(random() * 8) }, () => pick(random, alphabet)).join('');
      const template = Array.from({ length: Math.floor(random() * 5) }, () => pick(random, tokens)).join('');
      const expected = text.replace(new RegExp(pattern, flags), template);
      const r = run(pattern, flags, text, template);
      expect(r.replaced, `/${pattern}/${flags} on ${JSON.stringify(text)} with ${JSON.stringify(template)}`).toBe(expected);
      compared++;
    }
    expect(compared).toBe(4000);
  });
});

describe('limits on what is kept', () => {
  it('counts every match but lists details for a bounded number', () => {
    const r = run('a', 'g', 'a'.repeat(5000), 'b');
    expect(r.total).toBe(5000);
    expect(r.matches).toHaveLength(REGEX_LIMITS.matches);
    expect(r.detailLimit).not.toBeNull();
    expect(r.spans).toHaveLength(10_000);
    // The preview still covers every match.
    expect(r.replaced).toBe('b'.repeat(5000));

    const exact = run('a', 'g', 'a'.repeat(REGEX_LIMITS.matches));
    expect(exact.matches).toHaveLength(REGEX_LIMITS.matches);
    expect(exact.detailLimit).toBeNull();
  });

  it('bounds the number of listed capture groups', () => {
    const groups = 60;
    const r = run('(a)'.repeat(groups), 'g', 'a'.repeat(groups * 1000));
    expect(r.total).toBe(1000);
    expect(r.groupCount).toBe(groups);
    expect(r.matches).toHaveLength(Math.floor(REGEX_LIMITS.captures / groups));
    expect(r.detailLimit).toContain('capture groups');
    expect(r.matches.reduce((n, m) => n + m.groups.length, 0)).toBeLessThanOrEqual(REGEX_LIMITS.captures);
  });

  it('cuts long values to an excerpt and keeps their full length', () => {
    const r = run('(x+)', '', 'x'.repeat(5000));
    expect(r.matches[0].value).toEqual({ text: 'x'.repeat(REGEX_LIMITS.valueChars), length: 5000 });
    expect(r.matches[0].groups[0].value).toEqual({ text: 'x'.repeat(REGEX_LIMITS.valueChars), length: 5000 });
    expect(r.matches[0].end).toBe(5000);
    const short = run('x+', '', 'x'.repeat(REGEX_LIMITS.valueChars));
    expect(short.matches[0].value.text).toHaveLength(REGEX_LIMITS.valueChars);
  });

  it('bounds the total text kept in details', () => {
    // Each match keeps three 1,000-character captures: the budget of 2,000,000 lasts 667 matches.
    const r = run('(?=(.{1000}))(?=(.{1000}))(?=(.{1000}))', 'g', 'y'.repeat(5000));
    expect(r.total).toBe(4001);
    expect(r.matches).toHaveLength(Math.ceil(REGEX_LIMITS.detailChars / 3000));
    expect(r.detailLimit).toContain('characters');
    const kept = r.matches.reduce((n, m) => n + m.value.text.length + m.groups.reduce((k, g) => k + (g.value?.text.length ?? 0), 0), 0);
    expect(kept).toBeLessThanOrEqual(REGEX_LIMITS.detailChars + 3 * REGEX_LIMITS.valueChars);
  });

  it('refuses a replacement result that is too large instead of cutting it, and caps spans', () => {
    const text = 'a'.repeat(REGEX_LIMITS.textChars);
    const started = Date.now();
    const r = run('a', 'g', text, 'aaaaa');
    expect(r.total).toBe(REGEX_LIMITS.textChars);
    expect(r.replaced).toBeNull();
    expect(r.replacedNote).toContain('not shown');
    expect(r.spans).toHaveLength(200_000);
    expect(r.matches).toHaveLength(REGEX_LIMITS.matches);
    expect(Date.now() - started).toBeLessThan(10_000);

    // Just under the limit, the whole result is returned.
    const under = run('a', 'g', text, 'aaaa');
    expect(under.replaced).toHaveLength(REGEX_LIMITS.replacedChars);
    expect(under.replacedNote).toBeNull();
  });

  it('refuses a result made large by $` and $\' as well', () => {
    const r = run('b', 'g', 'b'.repeat(5000), "$`$'");
    // 5,000 matches, each replaced by the other 4,999 characters: about 25,000,000.
    expect(r.replaced).toBeNull();
    expect(r.replacedNote).not.toBeNull();
    expect(r.total).toBe(5000);
  });

  it('counts the text after the last match toward the limit', () => {
    // One match near the start, replaced by text that fits on its own but not with the tail.
    const text = `b${'c'.repeat(REGEX_LIMITS.textChars - 1)}`;
    const big = run('(b)', '', text, '$`'.repeat(1) + 'x'.repeat(10) + "$'$'$'$'".slice(0, 6));
    expect(big.replaced).toBeNull();
    expect(big.replacedNote).not.toBeNull();
  });

  it('handles the largest text quickly for a simple global pattern', () => {
    const text = 'lorem ipsum 12345 '.repeat(Math.floor(REGEX_LIMITS.textChars / 18));
    const started = Date.now();
    const r = run('\\d+', 'g', text, '#');
    const elapsed = Date.now() - started;
    expect(r.total).toBe(Math.floor(REGEX_LIMITS.textChars / 18));
    expect(r.replaced).toHaveLength(text.length - 4 * r.total);
    expect(elapsed).toBeLessThan(5000);
  });
});
