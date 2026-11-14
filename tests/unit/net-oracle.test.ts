/** The network engine against Python's ipaddress (scripts/oracles/net_oracle.py). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandAddress, formatAddress, formatPrefix, parseAddress, parsePrefixText, prefixToRange, rangeSize, type IpPrefix, type IpRange } from '../../src/core/net/address';
import { formatIPv6, expandIPv6, parseIPv6 } from '../../src/core/net/ipv6';
import { containsRange, rangeToPrefixes, rangesOverlap, splitPrefix, subtractRanges, summarizeRanges, supernet } from '../../src/core/net/ops';

interface Fixture {
  canonical: { value: string; compressed: string; exploded: string; inputs: string[] }[];
  validity: { text: string; valid: boolean }[];
  prefixes: { family: 4 | 6; network: string; first: string; last: string; size: string; split?: { length: number; count: string; first: string[] }; supernet?: { length: number; network: string } }[];
  ranges: { family: 4 | 6; first: string; last: string; cidrs: string[] }[];
  collapses: { family: 4 | 6; networks: string[]; collapsed: string[] }[];
  pairs: { family: 4 | 6; a: string; b: string; overlaps: boolean; aInB: boolean; bInA: boolean }[];
  gaps: { family: 4 | 6; parent: string; children: string[]; remaining: string[] }[];
}

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'net-oracle.json'), 'utf8')) as Fixture;

function prefix(text: string): IpPrefix {
  const r = parsePrefixText(text);
  if (!r.ok || r.value.hostBitsSet) throw new Error(`fixture network ${text} did not parse cleanly`);
  return r.value.prefix;
}
function address(text: string): bigint {
  const r = parseAddress(text);
  if (!r.ok) throw new Error(`fixture address ${text} did not parse`);
  return r.value.value;
}
const rangeOf = (text: string): IpRange => prefixToRange(prefix(text));

describe('IPv6 text against Python', () => {
  it('has varied cases (generator sanity)', () => {
    expect(oracle.canonical.length).toBeGreaterThan(1000);
    expect(oracle.canonical.some(c => c.compressed.includes('.'))).toBe(true);
    expect(oracle.canonical.filter(c => c.compressed.includes('::')).length).toBeGreaterThan(500);
    expect(oracle.validity.filter(v => v.valid).length).toBeGreaterThan(300);
    expect(oracle.validity.filter(v => !v.valid).length).toBeGreaterThan(2000);
  });

  it('writes every address exactly as Python does, compressed and expanded', () => {
    const bad: string[] = [];
    for (const c of oracle.canonical) {
      const value = BigInt(`0x${c.value}`);
      // Python writes IPv4-mapped addresses with a dotted tail even when expanded; NetForge's
      // expanded form is always eight hex groups, so compare that case group by group.
      const exploded = c.exploded.includes('.') ? expandIPv6(value) === c.exploded.replace(/ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a, b, cc, d) => `ffff:${((+a << 8) | +b).toString(16).padStart(4, '0')}:${((+cc << 8) | +d).toString(16).padStart(4, '0')}`) : expandIPv6(value) === c.exploded;
      if (formatIPv6(value) !== c.compressed || !exploded) bad.push(`${c.value}: ${formatIPv6(value)} / ${expandIPv6(value)} vs ${c.compressed} / ${c.exploded}`);
      for (const input of c.inputs) {
        const parsed = parseIPv6(input);
        if (!parsed.ok || parsed.value !== value) bad.push(`${input} did not parse to ${c.value}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('accepts and rejects exactly the strings Python does', () => {
    const disagreements = oracle.validity.filter(v => parseIPv6(v.text).ok !== v.valid).map(v => `${JSON.stringify(v.text)}: python ${v.valid ? 'accepts' : 'rejects'}`);
    expect(disagreements.slice(0, 20)).toEqual([]);
  });
});

describe('prefixes against Python', () => {
  it('matches boundaries, sizes, splits and supernets', () => {
    const bad: string[] = [];
    let splits = 0;
    let supernets = 0;
    for (const c of oracle.prefixes) {
      const p = prefix(c.network);
      const r = prefixToRange(p);
      if (formatPrefix(p) !== c.network || formatAddress(p.family, r.first) !== c.first || formatAddress(p.family, r.last) !== c.last || rangeSize(r).toString() !== c.size) {
        bad.push(`${c.network}: boundaries`);
      }
      if (c.split) {
        splits++;
        const s = splitPrefix(p, c.split.length, 0n, 4);
        if (s.total.toString() !== c.split.count || JSON.stringify(s.subnets.map(formatPrefix)) !== JSON.stringify(c.split.first)) bad.push(`${c.network} split /${c.split.length}`);
      }
      if (c.supernet) {
        supernets++;
        if (formatPrefix(supernet(p, c.supernet.length)) !== c.supernet.network) bad.push(`${c.network} supernet /${c.supernet.length}`);
      }
    }
    expect(bad).toEqual([]);
    expect(splits).toBeGreaterThan(400);
    expect(supernets).toBeGreaterThan(400);
  });
});

describe('aggregation against Python', () => {
  it('converts ranges to exactly the CIDR lists of summarize_address_range', () => {
    const bad = oracle.ranges.filter(c => {
      const got = rangeToPrefixes({ family: c.family, first: address(c.first), last: address(c.last) }).map(formatPrefix);
      return JSON.stringify(got) !== JSON.stringify(c.cidrs);
    }).map(c => `${c.first} - ${c.last}`);
    expect(bad).toEqual([]);
    expect(oracle.ranges.filter(c => c.cidrs.length > 5).length).toBeGreaterThan(100);
  });

  it('collapses network sets exactly as collapse_addresses does', () => {
    const bad = oracle.collapses.filter(c => JSON.stringify(summarizeRanges(c.networks.map(rangeOf)).map(formatPrefix)) !== JSON.stringify(c.collapsed)).map(c => c.networks.join(' '));
    expect(bad).toEqual([]);
    expect(oracle.collapses.filter(c => c.collapsed.length < c.networks.length).length).toBeGreaterThan(100);
  });

  it('finds the gaps address_exclude leaves', () => {
    const bad = oracle.gaps.filter(c => {
      const got = summarizeRanges(subtractRanges(rangeOf(c.parent), c.children.map(rangeOf)));
      return JSON.stringify(got.map(formatPrefix)) !== JSON.stringify(c.remaining);
    }).map(c => c.parent);
    expect(bad).toEqual([]);
  });

  it('agrees on overlap and containment for every pair', () => {
    const bad = oracle.pairs.filter(c => {
      const a = rangeOf(c.a);
      const b = rangeOf(c.b);
      return rangesOverlap(a, b) !== c.overlaps || containsRange(b, a) !== c.aInB || containsRange(a, b) !== c.bInA;
    }).map(c => `${c.a} ${c.b}`);
    expect(bad).toEqual([]);
    expect(oracle.pairs.filter(c => c.overlaps && !c.aInB && !c.bInA).length + oracle.pairs.filter(c => c.aInB || c.bInA).length).toBeGreaterThan(300);
  });

  it('expands IPv4 addresses unchanged', () => {
    expect(expandAddress(4, address('10.0.0.1'))).toBe('10.0.0.1');
  });
});
