/**
 * Address classification: the bundled registry data, block boundaries, hand cases from the
 * registry rows, and Python ipaddress's flags as an independent cross-check.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAddress, type Family } from '../../src/core/net/address';
import { blocksOverlapping, classifyAddress, REGISTRY_BLOCKS } from '../../src/core/net/classify';
import { parsePrefixText } from '../../src/core/net/address';
import { REGISTRY_SOURCES } from '../../src/core/net/registry-data';

const ROOT = join(import.meta.dirname, '..', '..');

function classify(text: string) {
  const a = parseAddress(text);
  if (!a.ok) throw new Error(`test setup: ${text}`);
  return classifyAddress(a.value.family, a.value.value);
}

describe('bundled registry data', () => {
  it('is exactly what the generator makes from the files in data/iana', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'registry', 'build-registry.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toContain('up to date');
  });

  it('keeps every registry file byte for byte as downloaded (SHA-256 as recorded in SOURCES.txt)', () => {
    const sources = readFileSync(join(ROOT, 'data', 'iana', 'SOURCES.txt'), 'utf8');
    const recorded = [...sources.matchAll(/^(\S+\.(?:csv|xml))\s+https:\S+\s+sha256 ([0-9a-f]{64})/gm)].map(m => [m[1], m[2]]);
    expect(recorded).toHaveLength(5);
    for (const [file, hash] of recorded) {
      expect(createHash('sha256').update(readFileSync(join(ROOT, 'data', 'iana', file))).digest('hex'), file).toBe(hash);
    }
  });

  it('records sources and dates', () => {
    expect(REGISTRY_SOURCES.ipv4Special).toMatchObject({ updated: '2025-10-09', retrieved: '2026-11-14' });
    expect(REGISTRY_SOURCES.ipv6Special).toMatchObject({ updated: '2025-10-09', retrieved: '2026-11-14' });
  });

  it('has every registry row as a valid, aligned, tagged block', () => {
    expect(REGISTRY_BLOCKS.filter(b => b.family === 4)).toHaveLength(26);
    expect(REGISTRY_BLOCKS.filter(b => b.family === 6)).toHaveLength(25);
    for (const b of REGISTRY_BLOCKS) {
      expect(b.tags.length, b.block).toBeGreaterThan(0);
      expect(b.allocated, b.block).toMatch(/^[0-9]{4}-[0-9]{2}$/);
    }
    const csv = readFileSync(join(ROOT, 'data', 'iana', 'iana-ipv4-special-registry-1.csv'), 'utf8');
    expect(csv).toContain('198.18.0.0/15,Benchmarking');
  });
});

describe('block boundaries', () => {
  it('includes the first and last address of every block and excludes the addresses just outside', () => {
    const problems: string[] = [];
    const max = (f: Family) => (f === 4 ? (1n << 32n) - 1n : (1n << 128n) - 1n);
    for (const block of REGISTRY_BLOCKS) {
      const has = (v: bigint) => classifyAddress(block.family, v).matches.includes(block);
      if (!has(block.range.first) || !has(block.range.last)) problems.push(`${block.block} misses its own edge`);
      if (block.range.first > 0n && has(block.range.first - 1n)) problems.push(`${block.block} includes the address before it`);
      if (block.range.last < max(block.family) && has(block.range.last + 1n)) problems.push(`${block.block} includes the address after it`);
    }
    expect(problems).toEqual([]);
  });
});

describe('classification', () => {
  it('private use', () => {
    const c = classify('10.1.2.3');
    expect(c.properties).toEqual(['private-use']);
    expect(c.globallyReachable).toBe('false');
    expect(c.matches.map(m => m.block)).toEqual(['10.0.0.0/8']);
  });

  it('lists every matching block, most specific first, and lets the most specific decide reachability', () => {
    const c = classify('192.0.0.9');
    expect(c.matches.map(m => m.block)).toEqual(['192.0.0.9/32', '192.0.0.0/24']);
    expect(c.globallyReachable).toBe('true');
    expect(c.reachabilityFrom?.block).toBe('192.0.0.9/32');
    expect(c.properties).toEqual(expect.arrayContaining(['anycast', 'protocol-assignment']));
    const other = classify('192.0.0.100');
    expect(other.globallyReachable).toBe('false');
    expect(other.matches[0].notes).toEqual(['Not useable unless by virtue of a more specific reservation.']);
  });

  it('skips blocks that state no reachability (deprecated ones)', () => {
    expect(classify('192.88.99.1')).toMatchObject({ globallyReachable: 'unspecified', properties: ['deprecated'], reachabilityFrom: null });
    expect(classify('192.88.99.2')).toMatchObject({ globallyReachable: 'false' });
    // The deprecated ORCHID block (blank columns) sits inside 2001::/23, which then decides.
    const orchid = classify('2001:10::1');
    expect(orchid.matches.map(m => m.block)).toEqual(['2001:10::/28', '2001::/23']);
    expect(orchid.globallyReachable).toBe('false');
    expect(orchid.reachabilityFrom?.block).toBe('2001::/23');
  });

  it.each([
    ['100.64.0.1', 'shared-address-space', 'false'],
    ['127.0.0.1', 'loopback', 'false'],
    ['169.254.10.20', 'link-local', 'false'],
    ['192.0.2.55', 'documentation', 'false'],
    ['198.51.100.1', 'documentation', 'false'],
    ['203.0.113.254', 'documentation', 'false'],
    ['198.19.255.255', 'benchmarking', 'false'],
    ['240.0.0.1', 'reserved', 'false'],
    ['255.255.255.255', 'limited-broadcast', 'false'],
    ['0.0.0.0', 'unspecified', 'false'],
    ['0.1.2.3', 'this-network', 'false'],
    ['192.31.196.1', 'anycast', 'true'],
    ['::1', 'loopback', 'false'],
    ['::', 'unspecified', 'false'],
    ['::ffff:10.0.0.1', 'ipv4-mapped', 'false'],
    ['64:ff9b::808:808', 'translation', 'true'],
    ['64:ff9b:1::1', 'translation', 'false'],
    ['100::1', 'discard', 'false'],
    ['2001:2::1', 'benchmarking', 'false'],
    ['2001:db8::1', 'documentation', 'false'],
    ['3fff::1', 'documentation', 'false'],
    ['5f00::1', 'protocol-assignment', 'false'],
    ['fd12:3456::1', 'private-use', 'false'],
    ['fe80::1', 'link-local', 'false'],
    ['2001:1::1', 'anycast', 'true'],
    ['2001::1', 'tunneling', 'n/a'],
    ['2002:c000:204::1', 'tunneling', 'n/a'],
  ])('%s has %s and reachability %s', (address, property, reach) => {
    const c = classify(address);
    expect(c.properties).toContain(property);
    expect(c.globallyReachable).toBe(reach);
  });

  it('marks ordinary unicast as not listed, and says routing cannot be known offline', () => {
    for (const address of ['8.8.8.8', '198.20.0.0', '2606:4700::1111']) {
      const c = classify(address);
      expect(c.globallyReachable).toBe('not-listed');
      expect(c.matches).toEqual([]);
      expect(c.reachabilityNote).toContain('cannot check offline');
    }
    expect(classify('2606:4700::1111').properties).toEqual(['global-unicast']);
    expect(classify('8.8.8.8').properties).toEqual([]);
  });

  it('describes IPv4 multicast scopes', () => {
    expect(classify('224.0.0.251')).toMatchObject({ properties: ['multicast'], globallyReachable: 'not-listed' });
    expect(classify('224.0.0.251').multicastScope).toContain('Local Network Control Block');
    expect(classify('239.1.2.3').multicastScope).toContain('Administratively scoped');
    expect(classify('232.1.1.1').multicastScope).toContain('Source-Specific');
    expect(classify('233.1.1.1').multicastScope).toBe('Multicast (RFC 5771)');
    expect(classify('223.255.255.255').properties).toEqual([]);
  });

  it('reads the IPv6 multicast scope from the address', () => {
    expect(classify('ff02::1').multicastScope).toBe('Link-local scope (2)');
    expect(classify('ff05::2').multicastScope).toBe('Site-local scope (5)');
    expect(classify('ff0e::1').multicastScope).toBe('Global scope (e)');
    expect(classify('ff03::1').multicastScope).toBe('Realm-local scope (3)');
    expect(classify('ff06::1').multicastScope).toBe('Unassigned scope (6)');
  });

  it('reports the IPv6 address space allocation', () => {
    expect(classify('2001:db8::1').addressSpace?.allocation).toBe('Global Unicast');
    expect(classify('fec0::1')).toMatchObject({ properties: ['site-local-deprecated'], globallyReachable: 'not-listed' });
    expect(classify('4000::1').properties).toEqual(['reserved-by-ietf']);
    expect(classify('fd00::1').properties).toEqual(expect.arrayContaining(['private-use', 'unique-local']));
  });

  it('lists the special-purpose blocks that overlap a prefix', () => {
    const p = parsePrefixText('192.0.0.0/23');
    if (!p.ok) throw new Error('setup');
    const blocks = blocksOverlapping(p.value.prefix);
    expect(blocks.map(b => [b.block.block, b.relation])).toEqual([
      ['192.0.0.0/24', 'inside-prefix'], ['192.0.0.0/29', 'inside-prefix'], ['192.0.0.8/32', 'inside-prefix'], ['192.0.0.9/32', 'inside-prefix'],
      ['192.0.0.10/32', 'inside-prefix'], ['192.0.0.170/32', 'inside-prefix'], ['192.0.0.171/32', 'inside-prefix'],
    ]);
    const q = parsePrefixText('10.20.0.0/16');
    if (!q.ok) throw new Error('setup');
    expect(blocksOverlapping(q.value.prefix).map(b => [b.block.block, b.relation])).toEqual([['10.0.0.0/8', 'contains-prefix']]);
  });
});

interface FlagRow { family: 4 | 6; address: string; private: boolean; global: boolean; loopback: boolean; linkLocal: boolean; multicast: boolean; reserved: boolean; unspecified: boolean; siteLocal?: boolean }
const flags = (JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'net-oracle.json'), 'utf8')) as { flags: FlagRow[] }).flags;

/**
 * Registry rows newer than Python 3.13's built-in table: NetForge follows the registry. Each is
 * asserted below to be the cause of a real disagreement, so the list cannot go stale silently.
 */
const NEWER_THAN_PYTHON = ['100:0:0:1::/64', '2001:1::3/128', '5f00::/16'];

describe('classification against Python ipaddress flags', () => {
  it('reports the embedded IPv4 address of an IPv4-mapped address', () => {
    const c = classify('::ffff:10.1.2.3');
    expect(c.embeddedIPv4?.properties).toEqual(['private-use']);
    expect(classify('2001:db8::1').embeddedIPv4).toBeNull();
  });

  it('agrees on loopback, link-local, multicast, unspecified, reserved and site-local at every probe', () => {
    const bad: string[] = [];
    let mapped = 0;
    for (const row of flags) {
      const outer = classify(row.address);
      // Python 3.13 reports the embedded IPv4 address's properties for IPv4-mapped addresses.
      const c = outer.embeddedIPv4 ?? outer;
      if (outer.embeddedIPv4) mapped++;
      const has = (p: string) => c.properties.includes(p as never);
      const checks: [string, boolean, boolean][] = [
        ['loopback', has('loopback'), row.loopback],
        ['link-local', has('link-local'), row.linkLocal],
        ['multicast', has('multicast'), row.multicast],
        ['unspecified', has('unspecified'), row.unspecified],
        ['reserved', c.family === 4 ? has('reserved') : has('reserved-by-ietf'), row.reserved],
      ];
      if (c.family === 6) checks.push(['site-local', has('site-local-deprecated'), row.siteLocal!]);
      for (const [name, mine, py] of checks) if (mine !== py) bad.push(`${row.address} ${name}: NetForge ${mine}, Python ${py}`);
    }
    expect(bad).toEqual([]);
    expect(mapped).toBeGreaterThan(0);
  });

  it('agrees on global reachability wherever both state it', () => {
    const bad: string[] = [];
    const excludedHits = new Set<string>();
    let compared = 0;
    for (const row of flags) {
      const c = classify(row.address);
      if (c.embeddedIPv4) continue;
      if (c.reachabilityFrom && NEWER_THAN_PYTHON.includes(c.reachabilityFrom.block)) {
        if ((c.globallyReachable === 'true') !== row.global) excludedHits.add(c.reachabilityFrom.block);
        continue;
      }
      let mine: boolean | null = null;
      if (c.globallyReachable === 'true') mine = true;
      else if (c.globallyReachable === 'false') mine = false;
      else if (c.globallyReachable === 'not-listed' && !c.properties.includes('multicast') && (row.family === 4 || c.properties.includes('global-unicast'))) mine = true;
      if (mine === null) continue;
      compared++;
      if (mine !== row.global) bad.push(`${row.address}: NetForge ${mine} (${c.reachabilityFrom?.block ?? 'not listed'}), Python ${row.global}`);
    }
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThan(500);
    expect([...excludedHits].sort()).toEqual([...NEWER_THAN_PYTHON].sort());
  });
});
