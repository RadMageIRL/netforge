/**
 * VLSM allocation. The brief's example is worked out by hand below; 300 random plans are checked
 * against a brute-force reference written with Python's ipaddress (net_oracle.py), which tries
 * every aligned candidate in order instead of skipping ahead the way the allocator does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPrefix, formatRange, parsePrefixText, prefixToRange } from '../../src/core/net/address';
import { formatIPv4 } from '../../src/core/net/ipv4';
import { rangesOverlap } from '../../src/core/net/ops';
import { allocateVlsm, hostCapacity, MAX_HOSTS, prefixForHosts, type VlsmInput, type VlsmResult } from '../../src/core/net/vlsm';
import { rng } from '../helpers';

const BRIEF: VlsmInput = {
  parent: '10.40.0.0/16',
  requests: [
    { name: 'Servers', hosts: 400 },
    { name: 'Clients', hosts: 1000 },
    { name: 'Voice', hosts: 350 },
    { name: 'Cameras', hosts: 120 },
    { name: 'Printers', hosts: 80 },
    { name: 'Management', hosts: 30 },
  ],
};

function plan(result: VlsmResult): Record<string, string> {
  return Object.fromEntries(result.blocks.map(b => [b.name, b.prefix ? formatPrefix(b.prefix) : formatRange(b.range)]));
}

describe('sizing', () => {
  it.each([
    [1, 30], [2, 30], [3, 29], [6, 29], [7, 28], [14, 28], [15, 27], [30, 27], [31, 26], [62, 26], [63, 25],
    [126, 25], [127, 24], [254, 24], [255, 23], [1000, 22], [1022, 22], [1023, 21], [MAX_HOSTS, 0],
  ])('%i hosts need a /%i', (hosts, length) => {
    expect(prefixForHosts(hosts)).toBe(length);
  });

  it('uses /31 and /32 only when point-to-point sizing is on', () => {
    expect(prefixForHosts(1, true)).toBe(32);
    expect(prefixForHosts(2, true)).toBe(31);
    expect(prefixForHosts(3, true)).toBe(29);
    expect(prefixForHosts(2, false)).toBe(30);
  });

  it('counts usable hosts: /32 one, /31 two, otherwise minus network and broadcast', () => {
    expect(hostCapacity(32)).toBe(1n);
    expect(hostCapacity(31)).toBe(2n);
    expect(hostCapacity(30)).toBe(2n);
    expect(hostCapacity(24)).toBe(254n);
    expect(hostCapacity(0)).toBe(4294967294n);
  });

  it('refuses host counts that cannot be sized', () => {
    for (const bad of [0, -1, 1.5, MAX_HOSTS + 1]) expect(() => prefixForHosts(bad)).toThrow(RangeError);
  });
});

describe('the example in the brief', () => {
  const result = allocateVlsm(BRIEF);

  it('places largest first at the lowest aligned addresses', () => {
    expect(result.issues).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(plan(result)).toEqual({
      Clients: '10.40.0.0/22', Servers: '10.40.4.0/23', Voice: '10.40.6.0/23',
      Cameras: '10.40.8.0/25', Printers: '10.40.8.128/25', Management: '10.40.9.0/27',
    });
    expect(result.blocks.map(b => b.name)).toEqual(['Clients', 'Servers', 'Voice', 'Cameras', 'Printers', 'Management']);
    expect(result.order).toEqual([1, 0, 2, 3, 4, 5]);
  });

  it('reports masks, usable ranges and capacities', () => {
    const servers = result.blocks.find(b => b.name === 'Servers')!;
    expect(formatIPv4(servers.firstUsable!)).toBe('10.40.4.1');
    expect(formatIPv4(servers.lastUsable!)).toBe('10.40.5.254');
    expect(servers.hostCapacity).toBe(510n);
    expect(servers.requestedHosts).toBe(400);
  });

  it('lists the unallocated space as the fewest blocks', () => {
    expect(result.free.map(formatPrefix)).toEqual([
      '10.40.9.32/27', '10.40.9.64/26', '10.40.9.128/25', '10.40.10.0/23', '10.40.12.0/22', '10.40.16.0/20', '10.40.32.0/19', '10.40.64.0/18', '10.40.128.0/17',
    ]);
  });

  it('summarizes utilization', () => {
    expect(result.summary).toEqual({
      parentAddresses: 65536n, allocatedAddresses: 2336n, fixedAddresses: 0n, reservedAddresses: 0n, freeAddresses: 63200n,
      requestedHosts: 1980, hostCapacity: 2324n,
    });
  });
});

describe('point-to-point links', () => {
  const links = { parent: '10.0.0.0/29', requests: [{ name: 'link-a', hosts: 2 }, { name: 'link-b', hosts: 2 }, { name: 'loopback', hosts: 1 }] };

  it('fits two /31 links and a /32 into a /29 with the option on', () => {
    const r = allocateVlsm({ ...links, pointToPoint: true });
    expect(plan(r)).toEqual({ 'link-a': '10.0.0.0/31', 'link-b': '10.0.0.2/31', 'loopback': '10.0.0.4/32' });
    const loop = r.blocks.find(b => b.name === 'loopback')!;
    expect(loop.hostCapacity).toBe(1n);
    expect(loop.firstUsable).toBe(loop.lastUsable);
    expect(r.blocks.find(b => b.name === 'link-a')!.hostCapacity).toBe(2n);
  });

  it('uses /30s without it, and the third request no longer fits', () => {
    const r = allocateVlsm(links);
    expect(plan(r)).toEqual({ 'link-a': '10.0.0.0/30', 'link-b': '10.0.0.4/30' });
    expect(r.failures.map(f => [f.name, f.code, f.prefixLength])).toEqual([['loopback', 'no-space', 30]]);
    expect(r.failures[0].message).toContain('No free space is left');
  });
});

describe('fixed allocations and reservations', () => {
  it('works around them and explains a request that no longer fits', () => {
    const r = allocateVlsm({
      parent: '10.0.0.0/24',
      reserved: [{ name: 'Infrastructure', range: '10.0.0.0 - 10.0.0.9' }],
      fixed: [{ name: 'DMZ', network: '10.0.0.64/26' }],
      requests: [{ name: 'A', hosts: 60 }, { name: 'B', hosts: 100 }],
    });
    expect(r.issues).toEqual([]);
    expect(plan(r)).toEqual({ 'Infrastructure': '10.0.0.0 - 10.0.0.9', 'DMZ': '10.0.0.64/26', 'B': '10.0.0.128/25' });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ name: 'A', code: 'no-space', prefixLength: 26 });
    expect(r.failures[0].message).toContain('largest free aligned block is a /27 (32 addresses), and 54 addresses are free in total');
    expect(r.free.map(formatPrefix)).toEqual(['10.0.0.10/31', '10.0.0.12/30', '10.0.0.16/28', '10.0.0.32/27']);
    expect(r.summary).toMatchObject({ reservedAddresses: 10n, fixedAddresses: 64n, allocatedAddresses: 128n, freeAddresses: 54n });
  });

  it('reports a request larger than the parent', () => {
    const r = allocateVlsm({ parent: '192.168.1.0/24', requests: [{ name: 'Big', hosts: 300 }, { name: 'Small', hosts: 10 }] });
    expect(r.failures.map(f => [f.name, f.code])).toEqual([['Big', 'larger-than-parent']]);
    expect(r.failures[0].message).toContain('/23');
    expect(plan(r)).toEqual({ Small: '192.168.1.0/28' });
  });

  it('accepts overlapping reservations and counts their space once', () => {
    const r = allocateVlsm({ parent: '10.0.0.0/24', requests: [], reserved: [{ name: 'a', range: '10.0.0.0/25' }, { name: 'b', range: '10.0.0.64 - 10.0.0.200' }] });
    expect(r.summary?.reservedAddresses).toBe(201n);
    expect(r.free.map(formatPrefix)).toEqual(['10.0.0.201/32', '10.0.0.202/31', '10.0.0.204/30', '10.0.0.208/28', '10.0.0.224/27']);
  });
});

describe('validation', () => {
  const base = { parent: '10.0.0.0/16', requests: [{ name: 'A', hosts: 10 }] };
  it.each([
    [{ ...base, parent: '2001:db8::/48' }, 'parent', 'parent-ipv6'],
    [{ ...base, parent: '10.0.0.0' }, 'parent', 'parent-invalid'],
    [{ ...base, parent: '' }, 'parent', 'parent-invalid'],
    [{ ...base, requests: [{ name: ' ', hosts: 10 }] }, 'requests', 'name-empty'],
    [{ ...base, requests: [{ name: 'A', hosts: 10 }, { name: 'a', hosts: 5 }] }, 'requests', 'name-duplicate'],
    [{ ...base, requests: [{ name: 'A', hosts: '0' }] }, 'requests', 'hosts-invalid'],
    [{ ...base, requests: [{ name: 'A', hosts: '1.5' }] }, 'requests', 'hosts-invalid'],
    [{ ...base, requests: [{ name: 'A', hosts: '1,000' }] }, 'requests', 'hosts-invalid'],
    [{ ...base, requests: [{ name: 'A', hosts: 'many' }] }, 'requests', 'hosts-invalid'],
    [{ ...base, requests: [{ name: 'A', hosts: 4294967295 }] }, 'requests', 'hosts-too-many'],
    [{ ...base, fixed: [{ name: 'A', network: '10.0.1.0/24' }] }, 'fixed', 'name-duplicate'],
    [{ ...base, fixed: [{ name: 'F', network: '10.0.1.5/24' }] }, 'fixed', 'host-bits'],
    [{ ...base, fixed: [{ name: 'F', network: '10.1.0.0/24' }] }, 'fixed', 'outside-parent'],
    [{ ...base, fixed: [{ name: 'F', network: '10.0.0.0/8' }] }, 'fixed', 'outside-parent'],
    [{ ...base, fixed: [{ name: 'F', network: '2001:db8::/64' }] }, 'fixed', 'network-ipv6'],
    [{ ...base, fixed: [{ name: 'F', network: 'nope' }] }, 'fixed', 'network-invalid'],
    [{ ...base, fixed: [{ name: 'F', network: '10.0.1.0/24' }, { name: 'G', network: '10.0.1.128/25' }] }, 'fixed', 'conflict'],
    [{ ...base, reserved: [{ name: 'R', range: '10.0.1.0 - 10.0.1.9' }], fixed: [{ name: 'F', network: '10.0.1.0/28' }] }, 'fixed', 'conflict'],
    [{ ...base, reserved: [{ name: 'R', range: '9.255.255.255 - 10.0.0.5' }] }, 'reserved', 'outside-parent'],
    [{ ...base, reserved: [{ name: 'R', range: '10.0.0.9 - 10.0.0.1' }] }, 'reserved', 'network-invalid'],
    [{ ...base, reserved: [{ name: 'R', range: '10.0.0.5/24' }] }, 'reserved', 'host-bits'],
    [{ ...base, reserved: [{ name: 'R', range: '2001:db8::1' }] }, 'reserved', 'network-ipv6'],
  ] as [VlsmInput, string, string][])('rejects %j', (input, section, code) => {
    const r = allocateVlsm(input);
    expect(r.issues.map(i => [i.section, i.code])).toContainEqual([section, code]);
    expect(r.blocks).toEqual([]);
    expect(r.summary).toBeNull();
  });

  it('names the row and the clash in conflict messages', () => {
    const r = allocateVlsm({ ...base, reserved: [{ name: 'Gateways', range: '10.0.1.0 - 10.0.1.9' }], fixed: [{ name: 'Lab', network: '10.0.1.0/28' }] });
    expect(r.issues[0].message).toBe('Fixed allocation 1 (Lab): 10.0.1.0/28 overlaps reservation "Gateways" (10.0.1.0 - 10.0.1.9).');
  });

  it('normalizes a parent with host bits set and says so', () => {
    const r = allocateVlsm({ parent: '10.0.5.0/16', requests: [{ name: 'A', hosts: 10 }] });
    expect(r.issues).toEqual([]);
    expect(formatPrefix(r.parent!)).toBe('10.0.0.0/16');
    expect(r.notes).toEqual(['10.0.5.0/16 has host bits set, so the parent network is 10.0.0.0/16.']);
  });

  it('accepts host counts typed as text with surrounding space', () => {
    expect(plan(allocateVlsm({ parent: '10.0.0.0/24', requests: [{ name: 'A', hosts: ' 50 ' }] }))).toEqual({ A: '10.0.0.0/26' });
  });
});

describe('determinism', () => {
  it('keeps the entered order for requests of equal size', () => {
    const r = allocateVlsm({ parent: '10.0.0.0/24', requests: [{ name: 'c', hosts: 50 }, { name: 'a', hosts: 50 }, { name: 'b', hosts: 50 }] });
    expect(plan(r)).toEqual({ c: '10.0.0.0/26', a: '10.0.0.64/26', b: '10.0.0.128/26' });
  });

  it('places the larger host count first when two requests need the same block', () => {
    const r = allocateVlsm({ parent: '10.0.0.0/24', requests: [{ name: 'small', hosts: 40 }, { name: 'large', hosts: 60 }] });
    expect(plan(r)).toEqual({ large: '10.0.0.0/26', small: '10.0.0.64/26' });
  });

  it('gives the same plan however distinct requests are ordered', () => {
    const requests = [{ name: 'a', hosts: 500 }, { name: 'b', hosts: 100 }, { name: 'c', hosts: 60 }, { name: 'd', hosts: 2000 }, { name: 'e', hosts: 5 }, { name: 'f', hosts: 30 }];
    const reference = plan(allocateVlsm({ parent: '172.16.0.0/20', requests }));
    const random = rng(7);
    for (let i = 0; i < 25; i++) {
      const shuffled = [...requests].sort(() => random() - 0.5);
      expect(plan(allocateVlsm({ parent: '172.16.0.0/20', requests: shuffled }))).toEqual(reference);
    }
  });
});

describe('invariants on random plans', () => {
  it('never overlaps, stays inside the parent, aligns every block and covers each request', () => {
    const random = rng(1918);
    for (let n = 0; n < 200; n++) {
      const length = 16 + Math.floor(random() * 9);
      const requests = Array.from({ length: 1 + Math.floor(random() * 10) }, (_, i) => ({ name: `r${i}`, hosts: 1 + Math.floor(random() ** 3 * 3000) }));
      const r = allocateVlsm({ parent: `10.${Math.floor(random() * 256)}.0.0/${length}`, requests, pointToPoint: random() < 0.3 });
      const parent = prefixToRange(r.parent!);
      for (const [i, a] of r.blocks.entries()) {
        expect(a.range.first >= parent.first && a.range.last <= parent.last).toBe(true);
        if (a.prefix) expect(a.prefix.network % (a.range.last - a.range.first + 1n)).toBe(0n);
        if (a.requestedHosts !== null) expect(a.hostCapacity! >= BigInt(a.requestedHosts)).toBe(true);
        for (const b of r.blocks.slice(i + 1)) expect(rangesOverlap(a.range, b.range)).toBe(false);
      }
      expect(r.blocks.filter(b => b.kind === 'request').length + r.failures.length).toBe(requests.length);
      const s = r.summary!;
      expect(s.allocatedAddresses + s.fixedAddresses + s.reservedAddresses + s.freeAddresses).toBe(s.parentAddresses);
    }
  });
});

interface Scenario {
  parent: string; pointToPoint: boolean; fixed: { name: string; network: string }[]; reserved: { name: string; range: string }[];
  requests: { name: string; hosts: number }[]; order: number[]; result: string[];
}
const scenarios = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'net-oracle.json'), 'utf8')) as { vlsm: Scenario[] }).vlsm;

describe('against a brute-force reference', () => {
  it('has varied scenarios (generator sanity)', () => {
    expect(scenarios).toHaveLength(300);
    expect(scenarios.filter(s => s.fixed.length > 0).length).toBeGreaterThan(50);
    expect(scenarios.filter(s => s.reserved.length > 0).length).toBeGreaterThan(50);
    expect(scenarios.filter(s => s.result.includes('no-space')).length).toBeGreaterThan(30);
    expect(scenarios.filter(s => s.pointToPoint).length).toBeGreaterThan(50);
  });

  it('makes the same plan in all 300 scenarios', () => {
    const bad: string[] = [];
    for (const [n, s] of scenarios.entries()) {
      const r = allocateVlsm(s);
      if (r.issues.length) {
        bad.push(`#${n}: ${r.issues[0].message}`);
        continue;
      }
      const got = s.requests.map((_req, i) => {
        const block = r.blocks.find(b => b.kind === 'request' && b.index === i);
        return block ? formatPrefix(block.prefix!) : r.failures.find(f => f.index === i)!.code;
      });
      if (JSON.stringify(got) !== JSON.stringify(s.result) || JSON.stringify(r.order) !== JSON.stringify(s.order)) bad.push(`#${n} ${s.parent}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('parsing helpers used by the editor', () => {
  it('reads the parent the same way as the Subnet Calculator', () => {
    const p = parsePrefixText('10.40.0.0 255.255.0.0');
    expect(p.ok && formatPrefix(p.value.prefix)).toBe('10.40.0.0/16');
  });
});
