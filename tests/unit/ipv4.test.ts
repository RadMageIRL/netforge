/**
 * IPv4 calculations against values worked out by hand from the definitions (and RFC 3021 for /31).
 * The oracle suite (ipv4-oracle.test.ts) adds hundreds of cases computed by Python's ipaddress.
 */
import { describe, expect, it } from 'vitest';
import { calculateSubnet, formatIPv4, IPV4_MAX, maskToPrefix, parseIPv4, parseSubnetInput, prefixToMask } from '../../src/core/net/ipv4';

function ip(text: string): bigint {
  const r = parseIPv4(text);
  if (!r.ok) throw new Error(`test setup: ${text} did not parse`);
  return r.value;
}

function calc(input: string) {
  const r = parseSubnetInput(input);
  if (!r.ok) throw new Error(`test setup: ${input} did not parse: ${r.error.message}`);
  const s = calculateSubnet(r.value.address, r.value.prefix);
  return {
    kind: s.kind,
    network: formatIPv4(s.network),
    broadcast: s.broadcast === null ? null : formatIPv4(s.broadcast),
    mask: formatIPv4(s.mask),
    wildcard: formatIPv4(s.wildcard),
    total: s.totalAddresses,
    first: formatIPv4(s.firstUsable),
    last: formatIPv4(s.lastUsable),
    usable: s.usableHosts,
    role: s.addressRole,
  };
}

describe('parseIPv4', () => {
  it('reads the lowest and highest addresses', () => {
    expect(parseIPv4('0.0.0.0')).toEqual({ ok: true, value: 0n });
    expect(parseIPv4('255.255.255.255')).toEqual({ ok: true, value: 0xffffffffn });
  });

  it('places each octet in its byte', () => {
    expect(ip('192.168.1.130')).toBe((192n << 24n) + (168n << 16n) + (1n << 8n) + 130n);
    expect(ip('1.0.0.0')).toBe(16777216n);
    expect(ip('0.0.0.1')).toBe(1n);
  });

  it.each([
    ['', 'empty'],
    ['1.2.3', 'octet-count'],
    ['1.2.3.4.5', 'octet-count'],
    ['1..3.4', 'octet-empty'],
    ['1.2.3.', 'octet-empty'],
    ['1.2.3.a', 'octet-not-number'],
    [' 1.2.3.4', 'octet-not-number'],
    ['1.2.3.4 ', 'octet-not-number'],
    ['1.2.3.-4', 'octet-not-number'],
    ['1.2.3.+4', 'octet-not-number'],
    [`${String.fromCharCode(0xff11)}.2.3.4`, 'octet-not-number'],
    ['01.2.3.4', 'leading-zero'],
    ['1.2.3.00', 'leading-zero'],
    ['256.1.1.1', 'octet-range'],
    ['1.2.3.1000', 'octet-range'],
    ['1.2.3.99999999999999999999', 'octet-range'],
    ['::1', 'ipv6'],
    ['2001:db8::1', 'ipv6'],
  ])('rejects %j with code %s', (text, code) => {
    const r = parseIPv4(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.message.length).toBeGreaterThan(10);
    }
  });

  it('formats back to the same dotted quad', () => {
    for (const text of ['0.0.0.0', '10.0.0.1', '172.16.254.3', '255.255.255.255']) expect(formatIPv4(ip(text))).toBe(text);
  });

  it('refuses to format values outside 32 bits', () => {
    expect(() => formatIPv4(-1n)).toThrow(RangeError);
    expect(() => formatIPv4(IPV4_MAX + 1n)).toThrow(RangeError);
  });
});

describe('masks', () => {
  it('maps the prefix extremes, including /0 where a 32-bit shift would wrap', () => {
    expect(prefixToMask(0)).toBe(0n);
    expect(prefixToMask(1)).toBe(0x80000000n);
    expect(prefixToMask(24)).toBe(0xffffff00n);
    expect(prefixToMask(31)).toBe(0xfffffffen);
    expect(prefixToMask(32)).toBe(0xffffffffn);
  });

  it('rejects prefix lengths outside 0 to 32', () => {
    expect(() => prefixToMask(-1)).toThrow(RangeError);
    expect(() => prefixToMask(33)).toThrow(RangeError);
    expect(() => prefixToMask(1.5)).toThrow(RangeError);
  });

  it('reads contiguous masks and returns null for non-contiguous ones', () => {
    expect(maskToPrefix(ip('255.255.255.0'))).toBe(24);
    expect(maskToPrefix(ip('255.255.240.0'))).toBe(20);
    expect(maskToPrefix(0n)).toBe(0);
    expect(maskToPrefix(0xffffffffn)).toBe(32);
    expect(maskToPrefix(ip('255.0.255.0'))).toBeNull();
    expect(maskToPrefix(ip('0.0.0.255'))).toBeNull();
    expect(maskToPrefix(ip('127.255.255.255'))).toBeNull();
  });

  it('round-trips every prefix length', () => {
    for (let p = 0; p <= 32; p++) expect(maskToPrefix(prefixToMask(p))).toBe(p);
  });
});

describe('parseSubnetInput', () => {
  it.each([
    ['10.0.0.1/24', 24, 'prefix'],
    ['  10.0.0.1/24  ', 24, 'prefix'],
    ['10.0.0.1 / 24', 24, 'prefix'],
    ['10.0.0.1 24', 24, 'prefix'],
    ['10.0.0.1/255.255.255.0', 24, 'mask'],
    ['10.0.0.1 255.255.255.0', 24, 'mask'],
    [`10.0.0.1${String.fromCharCode(9)}255.255.0.0`, 16, 'mask'],
    ['10.0.0.1/0', 0, 'prefix'],
    ['10.0.0.1 0.0.0.0', 0, 'mask'],
    ['10.0.0.1/32', 32, 'prefix'],
    ['10.0.0.1 255.255.255.255', 32, 'mask'],
  ])('accepts %j as /%i (%s notation)', (text, prefix, notation) => {
    const r = parseSubnetInput(text);
    expect(r).toEqual({ ok: true, value: { address: ip('10.0.0.1'), prefix, notation } });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['/24', 'empty'],
    ['10.0.0.1', 'missing-prefix'],
    ['10.0.0.1/', 'prefix-empty'],
    ['10.0.0.1/33', 'prefix-range'],
    ['10.0.0.1/123', 'prefix-range'],
    ['10.0.0.1/-1', 'prefix-invalid'],
    ['10.0.0.1/2a', 'prefix-invalid'],
    ['10.0.0.1/24/8', 'prefix-invalid'],
    ['10.0.0.1 255.0.255.0', 'mask-noncontiguous'],
    ['10.0.0.1 255.255.255.256', 'mask-invalid'],
    ['10.0.0.1 0.0.0.255', 'wildcard-mask'],
    ['10.0.0.1 255.255.255.0 extra', 'too-many-parts'],
    ['10.0.0.256/24', 'octet-range'],
    ['2001:db8::/32', 'ipv6'],
  ])('rejects %j with code %s', (text, code) => {
    const r = parseSubnetInput(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('names the matching subnet mask when given a wildcard mask', () => {
    const r = parseSubnetInput('10.0.0.1 0.0.15.255');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('255.255.240.0');
      expect(r.error.message).toContain('/20');
    }
  });
});

describe('calculateSubnet', () => {
  it('computes a /26 inside a /24', () => {
    expect(calc('192.168.1.130/26')).toEqual({
      kind: 'standard', network: '192.168.1.128', broadcast: '192.168.1.191', mask: '255.255.255.192', wildcard: '0.0.0.63',
      total: 64n, first: '192.168.1.129', last: '192.168.1.190', usable: 62n, role: 'host',
    });
  });

  it('computes a mask-notation /20', () => {
    expect(calc('172.16.5.4 255.255.240.0')).toMatchObject({
      network: '172.16.0.0', broadcast: '172.16.15.255', total: 4096n, first: '172.16.0.1', last: '172.16.15.254', usable: 4094n,
    });
  });

  it('computes /0 as the whole address space with 2^32 - 2 usable hosts', () => {
    expect(calc('8.8.8.8/0')).toEqual({
      kind: 'standard', network: '0.0.0.0', broadcast: '255.255.255.255', mask: '0.0.0.0', wildcard: '255.255.255.255',
      total: 4294967296n, first: '0.0.0.1', last: '255.255.255.254', usable: 4294967294n, role: 'host',
    });
  });

  it('computes /30 with two usable hosts', () => {
    expect(calc('10.0.0.5/30')).toMatchObject({ kind: 'standard', network: '10.0.0.4', broadcast: '10.0.0.7', first: '10.0.0.5', last: '10.0.0.6', usable: 2n, total: 4n });
  });

  it('treats /31 as a point-to-point link: both addresses usable, no broadcast (RFC 3021)', () => {
    expect(calc('203.0.113.9/31')).toEqual({
      kind: 'point-to-point', network: '203.0.113.8', broadcast: null, mask: '255.255.255.254', wildcard: '0.0.0.1',
      total: 2n, first: '203.0.113.8', last: '203.0.113.9', usable: 2n, role: 'host',
    });
  });

  it('treats /32 as a single host with no broadcast', () => {
    expect(calc('198.51.100.7/32')).toEqual({
      kind: 'host', network: '198.51.100.7', broadcast: null, mask: '255.255.255.255', wildcard: '0.0.0.0',
      total: 1n, first: '198.51.100.7', last: '198.51.100.7', usable: 1n, role: 'host',
    });
  });

  it('handles the top and bottom of the address space at /31 and /32', () => {
    expect(calc('255.255.255.255/31')).toMatchObject({ network: '255.255.255.254', first: '255.255.255.254', last: '255.255.255.255' });
    expect(calc('0.0.0.0/32')).toMatchObject({ network: '0.0.0.0', first: '0.0.0.0', last: '0.0.0.0', usable: 1n });
    expect(calc('255.255.255.255/32')).toMatchObject({ network: '255.255.255.255', usable: 1n });
  });

  it('says whether the entered address is the network address, the broadcast address or a host', () => {
    expect(calc('10.0.0.4/30').role).toBe('network');
    expect(calc('10.0.0.7/30').role).toBe('broadcast');
    expect(calc('10.0.0.5/30').role).toBe('host');
    expect(calc('10.0.0.4/31').role).toBe('host');
    expect(calc('10.0.0.5/31').role).toBe('host');
  });

  it('refuses addresses outside 32 bits', () => {
    expect(() => calculateSubnet(IPV4_MAX + 1n, 24)).toThrow(RangeError);
    expect(() => calculateSubnet(-1n, 24)).toThrow(RangeError);
  });
});
