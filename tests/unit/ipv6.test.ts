/**
 * IPv6 text forms against the examples in RFC 4291 section 2.2 and RFC 5952 section 4. The oracle
 * suite (net-oracle.test.ts) adds over a thousand addresses checked against Python's ipaddress.
 */
import { describe, expect, it } from 'vitest';
import { expandIPv6, formatIPv6, isIPv4Mapped, parseIPv6 } from '../../src/core/net/ipv6';

function v(text: string): bigint {
  const r = parseIPv6(text);
  if (!r.ok) throw new Error(`test setup: ${text} did not parse: ${r.error.message}`);
  return r.value;
}

const canonical = (text: string) => formatIPv6(v(text));

describe('RFC 5952 canonical form', () => {
  it.each([
    // 4.1: leading zeros suppressed
    ['2001:0db8::0001', '2001:db8::1'],
    // 4.2.1: shorten as much as possible
    ['2001:db8:0:0:0:0:2:1', '2001:db8::2:1'],
    // 4.2.2: a single zero group is not compressed
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    // 4.2.3: the longest run is compressed; on a tie, the first
    ['2001:0:0:1:0:0:0:1', '2001:0:0:1::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    // 4.3: lowercase
    ['2001:DB8::1', '2001:db8::1'],
    // RFC 4291 section 2.2 examples
    ['2001:DB8:0:0:8:800:200C:417A', '2001:db8::8:800:200c:417a'],
    ['FF01:0:0:0:0:0:0:101', 'ff01::101'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['0:0:0:0:0:0:13.1.68.3', '::d01:4403'],
    // Section 5: IPv4-mapped addresses in mixed notation
    ['0:0:0:0:0:FFFF:129.144.52.38', '::ffff:129.144.52.38'],
    ['::ffff:c000:201', '::ffff:192.0.2.1'],
    // Runs at the ends
    ['1:0:0:0:0:0:0:0', '1::'],
    ['0:0:1:0:0:0:0:0', '0:0:1::'],
    ['1:0:1:0:1:0:1:0', '1:0:1:0:1:0:1:0'],
  ])('%s is written %s', (input, expected) => {
    expect(canonical(input)).toBe(expected);
  });

  it('expands to eight four-digit groups', () => {
    expect(expandIPv6(v('2001:db8::1'))).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(expandIPv6(0n)).toBe('0000:0000:0000:0000:0000:0000:0000:0000');
    expect(expandIPv6(v('::ffff:192.0.2.1'))).toBe('0000:0000:0000:0000:0000:ffff:c000:0201');
  });

  it('recognizes only ::ffff:0:0/96 as IPv4-mapped', () => {
    expect(isIPv4Mapped(v('::ffff:0.0.0.0'))).toBe(true);
    expect(isIPv4Mapped(v('::ffff:255.255.255.255'))).toBe(true);
    expect(isIPv4Mapped(v('::fffe:ffff:ffff'))).toBe(false);
    expect(isIPv4Mapped(v('::1:ffff:0:0'))).toBe(false);
    expect(canonical('64:ff9b::192.0.2.1')).toBe('64:ff9b::c000:201');
  });
});

describe('parsing', () => {
  it('reads the extremes', () => {
    expect(v('::')).toBe(0n);
    expect(v('::1')).toBe(1n);
    expect(v('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe((1n << 128n) - 1n);
    expect(v('1::')).toBe(1n << 112n);
  });

  it('accepts every spelling of the same address', () => {
    const want = v('2001:db8::1');
    for (const text of ['2001:DB8::1', '2001:0db8:0:0:0:0:0:1', '2001:db8:0::1', '2001:db8::0:1', '2001:0DB8:0000:0000:0000:0000:0000:0001']) {
      expect(v(text)).toBe(want);
    }
  });

  it('allows "::" to stand for a single zero group, as RFC 4291 permits on input', () => {
    expect(v('1:2:3:4:5:6::8')).toBe(v('1:2:3:4:5:6:0:8'));
  });

  it('accepts an embedded IPv4 address in the last 32 bits', () => {
    expect(v('1:2:3:4:5:6:1.2.3.4')).toBe(v('1:2:3:4:5:6:102:304'));
    expect(v('::1.2.3.4')).toBe(0x01020304n);
  });

  it.each([
    ['', 'empty'],
    ['[2001:db8::1]', 'bracketed'],
    ['[2001:db8::1]:443', 'bracketed'],
    ['fe80::1%eth0', 'zone-id'],
    ['2001:db8::g', 'invalid-char'],
    ['2001:db8:: 1', 'invalid-char'],
    ['1.2.3.4', 'no-colon'],
    ['abcd', 'no-colon'],
    ['1::2::3', 'double-compression'],
    [':::', 'empty-group'],
    ['1:::2', 'empty-group'],
    [':1:2:3:4:5:6:7', 'empty-group'],
    ['1:2:3:4:5:6:7:', 'empty-group'],
    ['1:2:3:4:5:6:7', 'group-count'],
    ['1:2:3:4:5:6:7:8:9', 'group-count'],
    ['1::2:3:4:5:6:7:8', 'group-count'],
    ['1:2:3:4:5:6:7:1.2.3.4', 'group-count'],
    ['12345::', 'group-too-long'],
    ['::ffff:1.2.3.256', 'ipv4-tail'],
    ['::ffff:01.2.3.4', 'ipv4-tail'],
    ['ffff::1.2.3', 'ipv4-tail'],
    ['1.2.3.4::', 'ipv4-position'],
    ['::1.2.3.4:5', 'ipv4-position'],
  ])('rejects %j with %s', (text, code) => {
    const r = parseIPv6(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.message.length).toBeGreaterThan(10);
    }
  });

  it('round-trips canonical text', () => {
    for (const text of ['::', '::1', '2001:db8::', 'fe80::1:2', 'ff02::1:ff00:1', '2001:db8:1:2:3:4:5:6', '::ffff:10.0.0.1']) {
      expect(formatIPv6(v(text))).toBe(text);
    }
  });

  it('refuses to format values outside 128 bits', () => {
    expect(() => formatIPv6(-1n)).toThrow(RangeError);
    expect(() => formatIPv6(1n << 128n)).toThrow(RangeError);
  });
});
