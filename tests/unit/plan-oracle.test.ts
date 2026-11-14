/**
 * The plan engine against independent references: tests/fixtures/plan-oracle.json is produced by
 * scripts/oracles/plan_oracle.py from Python's ipaddress module and brute force (every pair of
 * networks compared, every child prefix and aligned subnet tried in order).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePrefixText, prefixToRange, formatPrefix } from '../../src/core/net/address';
import { allocatePrefixes } from '../../src/core/net/prefix-alloc';
import { previewAllocation } from '../../src/core/plan/allocate';
import { validatePlan } from '../../src/core/plan/validate';
import { makePlan, makeVlan } from '../plan-helpers';

interface Fixture {
  scoping: { vrfs: { id: string; exchangesWith: string[] }[]; vlans: { id: string; vrf: string; ipv4: string; ipv6: string }[]; conflicts: string[]; kinds: Record<string, string>; identical: string[]; reuse: string[] }[];
  vlanids: { sites: string[]; namespaces: { id: string; siteId: string }[]; vlans: { id: string; siteId: string; namespaceId: string; vlanId: string }[]; duplicates: Record<string, string[]> }[];
  addressing: { network: string; gateway: string; hosts: string; dhcp: string[]; reserved: string[]; codes: string[] }[];
  prefix6: { parents: string[]; child: number; occupied: string[]; requests: { key: string; count: number }[]; placed: Record<string, string[]>; failures: { key: string; available: number }[]; freeBefore: number; freeAfter: number }[];
  alloc4: { parents: string[]; existing: string[]; requests: { index: number; hosts: number }[]; assigned: Record<string, string>; failed: number[] }[];
}

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'plan-oracle.json'), 'utf8')) as Fixture;
const P = (t: string) => {
  const p = parsePrefixText(t);
  if (!p.ok) throw new Error(t);
  return p.value.prefix;
};

describe('plan oracle (Python ipaddress and brute force)', () => {
  it('has the expected number of cases', () => {
    expect([fixture.scoping.length, fixture.vlanids.length, fixture.addressing.length, fixture.prefix6.length, fixture.alloc4.length]).toEqual([120, 100, 800, 250, 250]);
  });

  it('scopes every overlap by routing domain exactly as a pairwise comparison does', () => {
    let pairs = 0;
    let reuses = 0;
    for (const c of fixture.scoping) {
      const plan = makePlan(c.vlans.map((v, i) => ({ id: v.id, vlanId: String(i + 2), vrfId: v.vrf, ipv4: { network: v.ipv4 }, ipv6: { prefixes: v.ipv6 ? [v.ipv6] : [] } })), {
        vrfs: c.vrfs.map(v => ({ id: v.id, name: v.id, siteId: '', exchangesWith: v.exchangesWith, description: '', notes: '' })),
      });
      const v = validatePlan(plan);
      const conflicts = new Set<string>();
      const reuse = new Set<string>();
      const identical = new Set(c.identical);
      for (const issue of v.issues) {
        const fam = issue.field === 'ipv4.network' ? 'ipv4' : 'ipv6';
        if (issue.code === 'overlap' || issue.code === 'duplicate-network' || issue.code === 'overlap-more') {
          for (const r of issue.related) conflicts.add(`${issue.target.id}>${r.id}`);
          if (issue.code !== 'overlap-more') {
            const key = `${issue.target.id}>${issue.related[0].id}>${fam}`;
            expect(issue.scope!.kind).toBe(c.kinds[key]);
            expect(issue.code === 'duplicate-network').toBe(identical.has(key));
          }
        }
        if (issue.code === 'reuse-independent') {
          for (const vrf of issue.scope!.vrfIds.slice(1)) reuse.add(`${issue.target.id}|${fam === 'ipv4' ? 4 : 6}|${vrf}`);
          expect(issue.severity).toBe('info');
        }
      }
      expect([...conflicts].sort()).toEqual(c.conflicts);
      expect([...reuse].sort()).toEqual(c.reuse);
      pairs += c.conflicts.length;
      reuses += c.reuse.length;
    }
    expect(pairs).toBeGreaterThan(500);
    expect(reuses).toBeGreaterThan(250);
  });

  it('finds duplicate VLAN IDs per namespace, and only there', () => {
    let dups = 0;
    for (const c of fixture.vlanids) {
      const plan = makePlan(c.vlans.map(v => ({ id: v.id, vlanId: v.vlanId, siteId: v.siteId, namespaceId: v.namespaceId })), {
        sites: c.sites.map(id => ({ id, name: id, description: '', notes: '', blocks: [] })),
        namespaces: c.namespaces.map(n => ({ id: n.id, name: n.id, siteId: n.siteId, description: '' })),
      });
      const v = validatePlan(plan);
      const actual: Record<string, string[]> = {};
      for (const issue of v.issues) if (issue.code === 'vlan-id-duplicate') actual[issue.target.id] = issue.related.map(r => r.id).sort();
      expect(actual).toEqual(c.duplicates);
      dups += Object.keys(c.duplicates).length;
    }
    expect(dups).toBeGreaterThan(300);
  });

  it('checks gateways, DHCP pools, reservations and capacity as the reference rules do', () => {
    const seen = new Set<string>();
    fixture.addressing.forEach((c, i) => {
      const plan = makePlan([{ hosts: c.hosts, ipv4: { network: c.network, gateway: c.gateway, dhcp: c.dhcp }, reserved: c.reserved.map(range => ({ range, label: '' })) }]);
      const actual = validatePlan(plan).issues.map(x => (x.line === null ? x.code : `${x.code}:${x.line}`)).sort();
      expect(actual, `case ${i}: ${JSON.stringify(c)}`).toEqual(c.codes);
      for (const code of c.codes) seen.add(code.split(':')[0]);
    });
    // Every rule was exercised.
    expect([...seen].sort()).toEqual([
      'capacity', 'dhcp-broadcast', 'dhcp-gateway', 'dhcp-invalid', 'dhcp-network', 'dhcp-no-network', 'dhcp-outside', 'dhcp-overlap', 'dhcp-reserved',
      'gateway-broadcast', 'gateway-network', 'gateway-no-network', 'gateway-outside', 'ipv4-point-to-point', 'ipv4-single-address', 'no-network',
      'reserved-invalid', 'reserved-no-network', 'reserved-outside', 'reserved-overlap', 'unallocated',
    ]);
  });

  it('allocates IPv6 prefixes exactly as trying every child prefix in order does', () => {
    let failures = 0;
    for (const c of fixture.prefix6) {
      const result = allocatePrefixes({ parents: c.parents.map(P), childLength: c.child, occupied: c.occupied.map(o => prefixToRange(P(o))), requests: c.requests });
      expect(result.errors).toEqual([]);
      const placed: Record<string, string[]> = {};
      for (const [k, list] of result.placed) placed[k] = list.map(formatPrefix);
      expect(placed).toEqual(c.placed);
      expect(result.failures.map(f => ({ key: f.key, available: Number(f.available) }))).toEqual(c.failures);
      expect([Number(result.freeBefore), Number(result.freeAfter)]).toEqual([c.freeBefore, c.freeAfter]);
      failures += c.failures.length;
    }
    expect(failures).toBeGreaterThan(50);
  });

  it('allocates IPv4 VLANs into several parents exactly as trying every aligned subnet does', () => {
    let failed = 0;
    let assigned = 0;
    for (const c of fixture.alloc4) {
      const existing = c.existing.map((network, i) => makeVlan(`e${i + 1}`, { vlanId: String(1000 + i), ipv4: { network } }));
      const requests = c.requests.map(r => makeVlan(`q${r.index}`, { vlanId: String(100 + r.index), hosts: String(r.hosts) }));
      const plan = makePlan([]);
      plan.vlans = [...existing, ...requests];
      const pv = previewAllocation(plan, validatePlan(plan), { family: 4, siteId: 's1', vrfId: 'r1', parents: c.parents, reallocate: false, setGateway: false });
      expect(pv.errors).toEqual([]);
      const got: Record<string, string> = {};
      for (const ch of pv.changes) got[ch.vlanId.slice(1)] = ch.after[0];
      expect(got).toEqual(c.assigned);
      expect(pv.failures.map(f => Number(f.vlanId.slice(1))).sort((a, b) => a - b)).toEqual(c.failed);
      failed += c.failed.length;
      assigned += Object.keys(c.assigned).length;
    }
    expect(failed).toBeGreaterThan(50);
    expect(assigned).toBeGreaterThan(500);
  });
});
