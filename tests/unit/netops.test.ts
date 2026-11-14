/** Family-aware primitives and set operations against hand-worked values. */
import { describe, expect, it } from 'vitest';
import {
  FamilyMismatchError, formatPrefix, formatRange, makePrefix, parseAddress, parsePrefixText, prefixSize, prefixToRange, rangeAsPrefix,
  type IpPrefix, type IpRange,
} from '../../src/core/net/address';
import { parseNetworkList } from '../../src/core/net/list';
import {
  alignUp, compareRanges, containsRange, coveringPrefix, intersectRanges, largestBlock, mergeRanges, rangeToPrefixes, rangesOverlap, sortRanges,
  splitPrefix, subtractRanges, summarizeRanges, supernet,
} from '../../src/core/net/ops';

function p(text: string): IpPrefix {
  const r = parsePrefixText(text);
  if (!r.ok) throw new Error(`test setup: ${text}: ${r.error.message}`);
  return r.value.prefix;
}
const r = (text: string): IpRange => prefixToRange(p(text));
function range(a: string, b: string): IpRange {
  const x = parseAddress(a);
  const y = parseAddress(b);
  if (!x.ok || !y.ok) throw new Error('test setup');
  return { family: x.value.family, first: x.value.value, last: y.value.value };
}
const cidrs = (list: readonly IpPrefix[]) => list.map(formatPrefix);

describe('prefixes', () => {
  it('parses IPv6 prefixes and reports host bits', () => {
    const a = parsePrefixText('2001:db8::1/64');
    expect(a.ok && a.value.hostBitsSet).toBe(true);
    expect(a.ok && formatPrefix(a.value.prefix)).toBe('2001:db8::/64');
    const b = parsePrefixText('2001:DB8:0:0::/48');
    expect(b.ok && b.value.hostBitsSet).toBe(false);
    expect(b.ok && formatPrefix(b.value.prefix)).toBe('2001:db8::/48');
  });

  it('keeps the IPv4 notations of Phase 0', () => {
    expect(formatPrefix(p('10.1.2.3 255.255.0.0'))).toBe('10.1.0.0/16');
    expect(formatPrefix(p('10.1.2.3/8'))).toBe('10.0.0.0/8');
  });

  it.each([
    ['2001:db8::', undefined, 'missing-prefix'],
    ['2001:db8::/', undefined, 'prefix-empty'],
    ['2001:db8::/129', undefined, 'prefix-range'],
    ['2001:db8::/1000', undefined, 'prefix-range'],
    ['2001:db8::/x', undefined, 'prefix-invalid'],
    ['2001:db8::/64', 4, 'wrong-family'],
    ['10.0.0.0/8', 6, 'wrong-family'],
    ['', 6, 'empty'],
  ] as const)('rejects %j (family %s) with %s', (text, family, code) => {
    const result = parsePrefixText(text, family);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('handles the boundary lengths of both families', () => {
    expect(prefixToRange(p('::/0'))).toEqual({ family: 6, first: 0n, last: (1n << 128n) - 1n });
    expect(prefixSize(6, 0)).toBe(1n << 128n);
    expect(prefixSize(6, 128)).toBe(1n);
    expect(prefixSize(6, 64)).toBe(18446744073709551616n);
    expect(prefixToRange(p('2001:db8::5/128'))).toEqual(range('2001:db8::5', '2001:db8::5'));
    expect(prefixToRange(p('0.0.0.0/0'))).toEqual({ family: 4, first: 0n, last: 4294967295n });
    expect(() => makePrefix(6, 0n, 129)).toThrow(RangeError);
    expect(() => makePrefix(4, 0n, 33)).toThrow(RangeError);
    expect(() => makePrefix(4, 1n << 32n, 8)).toThrow(RangeError);
  });

  it('recognizes ranges that are exactly one block', () => {
    expect(rangeAsPrefix(range('10.0.0.0', '10.0.0.255'))).toEqual(p('10.0.0.0/24'));
    expect(rangeAsPrefix(range('10.0.0.1', '10.0.1.0'))).toBeNull();
    expect(rangeAsPrefix(range('10.0.0.128', '10.0.1.127'))).toBeNull();
    expect(formatRange(range('10.0.0.1', '10.0.0.9'))).toBe('10.0.0.1 - 10.0.0.9');
    expect(formatRange(range('::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))).toBe('::/0');
  });
});

describe('range to CIDR', () => {
  it('covers 192.168.0.1 - 192.168.0.254 with the 14 blocks worked out by hand', () => {
    expect(cidrs(rangeToPrefixes(range('192.168.0.1', '192.168.0.254')))).toEqual([
      '192.168.0.1/32', '192.168.0.2/31', '192.168.0.4/30', '192.168.0.8/29', '192.168.0.16/28', '192.168.0.32/27', '192.168.0.64/26',
      '192.168.0.128/26', '192.168.0.192/27', '192.168.0.224/28', '192.168.0.240/29', '192.168.0.248/30', '192.168.0.252/31', '192.168.0.254/32',
    ]);
  });

  it('returns one block for whole spaces and aligned ranges', () => {
    expect(cidrs(rangeToPrefixes(range('0.0.0.0', '255.255.255.255')))).toEqual(['0.0.0.0/0']);
    expect(cidrs(rangeToPrefixes(range('::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')))).toEqual(['::/0']);
    expect(cidrs(rangeToPrefixes(range('2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff')))).toEqual(['2001:db8::/32']);
    expect(cidrs(rangeToPrefixes(range('10.0.0.7', '10.0.0.7')))).toEqual(['10.0.0.7/32']);
  });

  it('works at the very top of the IPv6 space', () => {
    expect(cidrs(rangeToPrefixes(range('ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')))).toEqual(['ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127']);
  });

  it('refuses reversed ranges', () => {
    expect(() => rangeToPrefixes({ family: 4, first: 5n, last: 4n })).toThrow(RangeError);
  });
});

describe('aggregation', () => {
  it('joins adjacent networks into their exact aggregate', () => {
    expect(cidrs(summarizeRanges([r('10.0.0.0/25'), r('10.0.0.128/25')]))).toEqual(['10.0.0.0/24']);
    expect(cidrs(summarizeRanges(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24'].map(r)))).toEqual(['10.0.0.0/22']);
  });

  it('never widens: adjacent but unaligned networks stay separate', () => {
    expect(cidrs(summarizeRanges([r('10.0.1.0/24'), r('10.0.2.0/24')]))).toEqual(['10.0.1.0/24', '10.0.2.0/24']);
  });

  it('removes duplicates and nested networks', () => {
    expect(cidrs(summarizeRanges(['10.0.0.0/16', '10.0.5.0/24', '10.0.0.0/16', '10.0.255.255/32'].map(r)))).toEqual(['10.0.0.0/16']);
  });

  it('merges overlapping ranges', () => {
    expect(mergeRanges([range('10.0.0.0', '10.0.0.10'), range('10.0.0.5', '10.0.0.20'), range('10.0.0.21', '10.0.0.30'), range('10.0.0.40', '10.0.0.50')]))
      .toEqual([range('10.0.0.0', '10.0.0.30'), range('10.0.0.40', '10.0.0.50')]);
  });

  it('aggregates IPv6', () => {
    expect(cidrs(summarizeRanges([r('2001:db8::/49'), r('2001:db8:0:8000::/49')]))).toEqual(['2001:db8::/48']);
  });
});

describe('splitting and supernets', () => {
  it('splits a /24 into four /26s', () => {
    const s = splitPrefix(p('10.0.0.0/24'), 26);
    expect(s.total).toBe(4n);
    expect(cidrs(s.subnets)).toEqual(['10.0.0.0/26', '10.0.0.64/26', '10.0.0.128/26', '10.0.0.192/26']);
  });

  it('pages through very large IPv6 splits without listing them all', () => {
    const s = splitPrefix(p('2001:db8::/32'), 64, 4294967294n, 10);
    expect(s.total).toBe(4294967296n);
    expect(cidrs(s.subnets)).toEqual(['2001:db8:ffff:fffe::/64', '2001:db8:ffff:ffff::/64']);
    expect(cidrs(splitPrefix(p('2001:db8::/32'), 64, 0n, 2).subnets)).toEqual(['2001:db8::/64', '2001:db8:0:1::/64']);
  });

  it('splits down to single addresses', () => {
    expect(cidrs(splitPrefix(p('10.0.0.0/31'), 32).subnets)).toEqual(['10.0.0.0/32', '10.0.0.1/32']);
    expect(cidrs(splitPrefix(p('::/127'), 128).subnets)).toEqual(['::/128', '::1/128']);
  });

  it('refuses split lengths that are not longer than the prefix or past the family width', () => {
    expect(() => splitPrefix(p('10.0.0.0/24'), 24)).toThrow(RangeError);
    expect(() => splitPrefix(p('10.0.0.0/24'), 33)).toThrow(RangeError);
    expect(() => splitPrefix(p('::/64'), 129)).toThrow(RangeError);
  });

  it('finds supernets', () => {
    expect(formatPrefix(supernet(p('192.168.1.0/24'), 16))).toBe('192.168.0.0/16');
    expect(formatPrefix(supernet(p('192.168.1.0/24'), 0))).toBe('0.0.0.0/0');
    expect(formatPrefix(supernet(p('2001:db8:1234::/48'), 32))).toBe('2001:db8::/32');
    expect(() => supernet(p('10.0.0.0/8'), 8)).toThrow(RangeError);
    expect(() => supernet(p('10.0.0.0/8'), -1)).toThrow(RangeError);
  });

  it('finds the smallest covering prefix, which may add addresses', () => {
    expect(formatPrefix(coveringPrefix([r('10.0.0.0/24'), r('10.0.3.0/24')]))).toBe('10.0.0.0/22');
    expect(formatPrefix(coveringPrefix([r('10.0.1.0/24'), r('10.0.2.0/24')]))).toBe('10.0.0.0/22');
    expect(formatPrefix(coveringPrefix([r('10.0.0.5/32')]))).toBe('10.0.0.5/32');
    expect(formatPrefix(coveringPrefix([r('0.0.0.0/32'), r('255.255.255.255/32')]))).toBe('0.0.0.0/0');
  });
});

describe('relations', () => {
  it('detects containment, overlap and intersection', () => {
    expect(containsRange(r('10.0.0.0/8'), r('10.1.0.0/16'))).toBe(true);
    expect(containsRange(r('10.1.0.0/16'), r('10.0.0.0/8'))).toBe(false);
    expect(rangesOverlap(range('10.0.0.0', '10.0.0.10'), range('10.0.0.10', '10.0.0.20'))).toBe(true);
    expect(rangesOverlap(range('10.0.0.0', '10.0.0.9'), range('10.0.0.10', '10.0.0.20'))).toBe(false);
    expect(intersectRanges(range('10.0.0.0', '10.0.0.10'), range('10.0.0.5', '10.0.0.20'))).toEqual(range('10.0.0.5', '10.0.0.10'));
    expect(intersectRanges(r('10.0.0.0/24'), r('10.0.1.0/24'))).toBeNull();
  });

  it('subtracts to find gaps', () => {
    expect(subtractRanges(r('10.0.0.0/24'), [r('10.0.0.0/26'), r('10.0.0.128/26')])).toEqual([range('10.0.0.64', '10.0.0.127'), range('10.0.0.192', '10.0.0.255')]);
    expect(subtractRanges(r('10.0.0.0/24'), [r('10.0.0.0/8')])).toEqual([]);
    expect(subtractRanges(r('10.0.0.0/24'), [])).toEqual([r('10.0.0.0/24')]);
  });

  it('sorts IPv4 before IPv6, then by address, containers first', () => {
    const sorted = sortRanges([r('2001:db8::/32'), r('10.0.1.0/24'), r('10.0.0.0/16'), r('10.0.0.0/24'), r('::/0')]);
    expect(sorted.map(formatRange)).toEqual(['10.0.0.0/16', '10.0.0.0/24', '10.0.1.0/24', '::/0', '2001:db8::/32']);
    expect(compareRanges(r('10.0.0.0/24'), r('10.0.0.0/24'))).toBe(0);
  });

  it('finds the largest aligned block in free space, and aligns up', () => {
    expect(largestBlock([range('10.0.0.1', '10.0.0.200')])).toEqual(p('10.0.0.64/26'));
    expect(largestBlock([])).toBeNull();
    expect(alignUp(5n, 4n)).toBe(8n);
    expect(alignUp(8n, 4n)).toBe(8n);
  });
});

describe('address families are never mixed', () => {
  const v4 = r('10.0.0.0/8');
  const v6 = r('2001:db8::/32');
  it.each([
    ['containment', () => containsRange(v4, v6)],
    ['overlap', () => rangesOverlap(v4, v6)],
    ['intersection', () => intersectRanges(v6, v4)],
    ['merging', () => mergeRanges([v4, v6])],
    ['summarization', () => summarizeRanges([v4, v6])],
    ['covering prefix', () => coveringPrefix([v4, v6])],
    ['subtraction', () => subtractRanges(v4, [v6])],
  ])('%s throws FamilyMismatchError', (_name, run) => {
    expect(run).toThrow(FamilyMismatchError);
  });
});

describe('network lists', () => {
  it('parses CIDRs, addresses and ranges with line numbers, skipping blanks and comments', () => {
    const { entries, errors } = parseNetworkList('# corp\n10.0.0.0/8\n\n192.0.2.7   # host\n2001:db8::/32\n198.51.100.10 - 198.51.100.20\n10.1.2.3/16\n');
    expect(errors).toEqual([]);
    expect(entries.map(e => [e.line, e.kind, formatRange(e), e.hostBitsSet])).toEqual([
      [2, 'prefix', '10.0.0.0/8', false],
      [4, 'address', '192.0.2.7/32', false],
      [5, 'prefix', '2001:db8::/32', false],
      [6, 'range', '198.51.100.10 - 198.51.100.20', false],
      [7, 'prefix', '10.1.0.0/16', true],
    ]);
  });

  it('reports each bad line and keeps the good ones', () => {
    const { entries, errors } = parseNetworkList('10.0.0.0/8\n10.0.0.300\n192.0.2.9 - 192.0.2.1\n10.0.0.1 - 2001:db8::1\n2001:db8::/129\nfoo\n::1\n');
    expect(entries.map(e => e.line)).toEqual([1, 7]);
    expect(errors.map(e => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(errors[1].message).toContain('ends before it starts');
    expect(errors[2].message).toContain('same family');
  });

  it('can refuse ranges', () => {
    expect(parseNetworkList('10.0.0.1 - 10.0.0.5', { allowRanges: false }).errors).toHaveLength(1);
  });
});
