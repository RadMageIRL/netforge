/**
 * The network plan: model helpers, validation (scoping, VLAN namespaces, addressing rules), IPv4
 * and IPv6 allocation, the address map, the plan file and CSV exports. Expected values are worked
 * out by hand here; plan-oracle.test.ts compares against Python's ipaddress on generated plans.
 */
import { describe, expect, it } from 'vitest';
import { parsePrefixText, prefixToRange, type IpPrefix } from '../../src/core/net/address';
import { alignedCount, allocatePrefixes, DEFAULT_MAX_CHILDREN } from '../../src/core/net/prefix-alloc';
import { buildMapView, collectMapItems, MAX_CELL_BITS, zoomPath } from '../../src/core/plan/addressmap';
import { applyAllocation, previewAllocation, type AllocationOptions } from '../../src/core/plan/allocate';
import { examplePlan } from '../../src/core/plan/example';
import { LIMITS, parsePlanJson, PLAN_VERSION, planToJson } from '../../src/core/plan/file';
import { emptyPlan, nextId, routingNeighbors, usage, vlanDefaults, vrfsForSite, type Plan } from '../../src/core/plan/model';
import { issuesCsv, vlanCsv, VLAN_CSV_COLUMNS } from '../../src/core/plan/reports';
import { OVERLAPS_LISTED, validatePlan, type PlanIssue, type PlanValidation } from '../../src/core/plan/validate';
import { makePlan, syntheticPlan, type VlanSpec } from '../plan-helpers';

const P = (text: string): IpPrefix => {
  const p = parsePrefixText(text);
  if (!p.ok) throw new Error(text);
  return p.value.prefix;
};
const issuesOf = (v: PlanValidation, kind: PlanIssue['target']['kind'], id: string) => v.forTarget(kind, id);
const codes = (v: PlanValidation, id: string, kind: PlanIssue['target']['kind'] = 'vlan') => issuesOf(v, kind, id).map(i => i.code).sort();
const errorCodes = (v: PlanValidation, id: string) => issuesOf(v, 'vlan', id).filter(i => i.severity === 'error').map(i => i.code).sort();
const one = (spec: VlanSpec) => validatePlan(makePlan([spec]));
const twoVrfs = (exchange: boolean): Partial<Plan> => ({
  vrfs: [
    { id: 'r1', name: 'Corp', siteId: '', exchangesWith: exchange ? ['r2'] : [], description: '', notes: '' },
    { id: 'r2', name: 'Lab', siteId: '', exchangesWith: [], description: '', notes: '' },
  ],
});

describe('model helpers', () => {
  it('picks the lowest free id', () => {
    expect(nextId('v', [])).toBe('v1');
    expect(nextId('v', [{ id: 'v1' }, { id: 'v3' }])).toBe('v2');
  });

  it('scopes VRFs and namespaces to sites', () => {
    const plan = examplePlan();
    expect(vrfsForSite(plan, 's1').map(v => v.id)).toEqual(['r1', 'r2']);
    expect(vrfsForSite(plan, 's2').map(v => v.id)).toEqual(['r1', 'r3']);
    expect(vlanDefaults(plan, 's2')).toEqual({ siteId: 's2', vrfId: 'r1', namespaceId: 'n2' });
  });

  it('treats route exchange as symmetric', () => {
    const plan = makePlan([], twoVrfs(true));
    expect([...routingNeighbors(plan, 'r1')].sort()).toEqual(['r1', 'r2']);
    expect([...routingNeighbors(plan, 'r2')].sort()).toEqual(['r1', 'r2']);
    expect([...routingNeighbors(makePlan([], twoVrfs(false)), 'r2')]).toEqual(['r2']);
  });

  it('counts what uses each site, VRF and namespace', () => {
    const u = usage(examplePlan());
    expect(u.sites.get('s1')).toBe(6 + 1 + 1); // 6 VLANs, VRF r2, namespace n1
    expect(u.vrfs.get('r1')).toBe(8 + 4); // 8 VLANs, 4 parent blocks
    expect(u.namespaces.get('n2')).toBe(4);
  });

  it('starts a new plan with one site, a global VRF and a namespace, and no VLANs', () => {
    const p = emptyPlan();
    expect([p.sites.length, p.vrfs.length, p.namespaces.length, p.vlans.length]).toEqual([1, 1, 1, 0]);
    expect(validatePlan(p).issues).toEqual([]);
  });
});

describe('the example plan', () => {
  it('validates with only the expected notes', () => {
    const v = validatePlan(examplePlan());
    expect(v.counts).toEqual({ error: 0, warning: 0, info: 4 });
    expect(v.issues.map(i => `${i.target.id} ${i.code}`)).toEqual(['v5 unallocated', 'v6 reuse-independent', 'v9 reuse-independent', 'v10 unallocated']);
  });
});

describe('VLAN IDs and namespaces', () => {
  it.each([
    ['', 'vlan-id-empty'], ['abc', 'vlan-id-invalid'], ['1.5', 'vlan-id-invalid'], ['-3', 'vlan-id-invalid'], ['0', 'vlan-id-reserved'],
    ['4095', 'vlan-id-reserved'], ['4096', 'vlan-id-range'], ['99999999', 'vlan-id-range'],
  ])('rejects VLAN ID %j (%s)', (vlanId, code) => {
    expect(errorCodes(one({ vlanId }), 'v1')).toEqual([code]);
  });

  it('accepts 1 to 4094, with notes on VLAN 1 and the legacy Cisco range', () => {
    expect(codes(one({ vlanId: '4094' }), 'v1')).toEqual(['no-network']);
    expect(codes(one({ vlanId: '2' }), 'v1')).toEqual(['no-network']);
    expect(issuesOf(one({ vlanId: '1' }), 'vlan', 'v1').find(i => i.code === 'vlan-id-default')?.severity).toBe('info');
    for (const id of ['1002', '1005']) expect(issuesOf(one({ vlanId: id }), 'vlan', 'v1').find(i => i.code === 'vlan-id-legacy')?.severity).toBe('warning');
    for (const id of ['1001', '1006']) expect(codes(one({ vlanId: id }), 'v1')).not.toContain('vlan-id-legacy');
    expect(codes(one({ vlanId: ' 010 ' }), 'v1')).toEqual(['no-network']);
  });

  it('flags a duplicate VLAN ID on both VLANs in the same namespace', () => {
    const v = validatePlan(makePlan([{ vlanId: '10' }, { vlanId: '10' }, { vlanId: '20' }]));
    expect(errorCodes(v, 'v1')).toEqual(['vlan-id-duplicate']);
    expect(errorCodes(v, 'v2')).toEqual(['vlan-id-duplicate']);
    expect(errorCodes(v, 'v3')).toEqual([]);
    const issue = issuesOf(v, 'vlan', 'v1').find(i => i.code === 'vlan-id-duplicate')!;
    expect(issue.message).toBe('VLAN 10 is also used in VLAN namespace "Site one switches" by VLAN 10 VLAN v2 at Site one.');
    expect(issue.related).toEqual([{ kind: 'vlan', id: 'v2' }]);
  });

  it('allows the same VLAN ID in different namespaces, even at the same site', () => {
    const plan = makePlan([{ vlanId: '10' }, { vlanId: '10', namespaceId: 'n2' }], {
      namespaces: [{ id: 'n1', name: 'Core', siteId: 's1', description: '' }, { id: 'n2', name: 'Lab stack', siteId: 's1', description: '' }],
    });
    expect(validatePlan(plan).counts.error).toBe(0);
  });

  it('does not let a VRF boundary make VLAN IDs unique: same namespace, different VRFs is still a duplicate', () => {
    const plan = makePlan([{ vlanId: '10', vrfId: 'r1' }, { vlanId: '10', vrfId: 'r2' }], twoVrfs(false));
    expect(errorCodes(validatePlan(plan), 'v2')).toEqual(['vlan-id-duplicate']);
  });

  it('does not assume VLAN IDs are unique per site or per organization: a stretched namespace spans sites', () => {
    const sites = [{ id: 's1', name: 'A', description: '', notes: '', blocks: [] }, { id: 's2', name: 'B', description: '', notes: '', blocks: [] }];
    const perSite = makePlan([{ vlanId: '10', siteId: 's1', namespaceId: 'n1' }, { vlanId: '10', siteId: 's2', namespaceId: 'n2' }], {
      sites, namespaces: [{ id: 'n1', name: 'A', siteId: 's1', description: '' }, { id: 'n2', name: 'B', siteId: 's2', description: '' }],
    });
    expect(validatePlan(perSite).counts.error).toBe(0);
    const stretched = makePlan([{ vlanId: '10', siteId: 's1', namespaceId: 'n1' }, { vlanId: '10', siteId: 's2', namespaceId: 'n1' }], {
      sites, namespaces: [{ id: 'n1', name: 'Campus fabric', siteId: '', description: '' }],
    });
    expect(errorCodes(validatePlan(stretched), 'v1')).toEqual(['vlan-id-duplicate']);
  });

  it('lists at most three other VLANs in a duplicate message', () => {
    const v = validatePlan(makePlan(Array.from({ length: 6 }, () => ({ vlanId: '7' }))));
    const msg = issuesOf(v, 'vlan', 'v1').find(i => i.code === 'vlan-id-duplicate')!;
    expect(msg.message).toMatch(/ and 2 more\.$/);
    expect(msg.related).toHaveLength(5);
  });
});

describe('site, VRF and namespace references', () => {
  it('reports missing references by field', () => {
    const v = validatePlan(makePlan([{ siteId: 'nope', namespaceId: '', vrfId: 'gone' }]));
    expect(issuesOf(v, 'vlan', 'v1').filter(i => i.severity === 'error').map(i => `${i.field} ${i.code}`).sort()).toEqual(['namespaceId namespace-missing', 'siteId site-missing', 'vrfId vrf-missing']);
  });

  it('rejects a namespace or VRF that belongs to another site', () => {
    const plan = makePlan([{ siteId: 's1', namespaceId: 'n2', vrfId: 'r2' }], {
      sites: [{ id: 's1', name: 'A', description: '', notes: '', blocks: [] }, { id: 's2', name: 'B', description: '', notes: '', blocks: [] }],
      namespaces: [{ id: 'n1', name: 'A', siteId: 's1', description: '' }, { id: 'n2', name: 'B', siteId: 's2', description: '' }],
      vrfs: [{ id: 'r1', name: 'G', siteId: '', exchangesWith: [], description: '', notes: '' }, { id: 'r2', name: 'B only', siteId: 's2', exchangesWith: [], description: '', notes: '' }],
    });
    expect(errorCodes(validatePlan(plan), 'v1')).toEqual(['namespace-site', 'vrf-site']);
  });

  it('checks names and references of sites, VRFs and namespaces', () => {
    const plan = makePlan([], {
      sites: [{ id: 's1', name: 'HQ', description: '', notes: '', blocks: [] }, { id: 's2', name: 'hq ', description: '', notes: '', blocks: [] }, { id: 's3', name: '', description: '', notes: '', blocks: [] }],
      vrfs: [
        { id: 'r1', name: 'Guest', siteId: 's1', exchangesWith: ['r1', 'zz'], description: '', notes: '' },
        { id: 'r2', name: 'Guest', siteId: 's2', exchangesWith: [], description: '', notes: '' },
        { id: 'r3', name: 'guest', siteId: '', exchangesWith: [], description: '', notes: '' },
        { id: 'r4', name: 'X', siteId: 'missing', exchangesWith: [], description: '', notes: '' },
      ],
      namespaces: [{ id: 'n1', name: 'Core', siteId: 'missing', description: '' }],
    });
    const v = validatePlan(plan);
    expect(codes(v, 's2', 'site')).toEqual(['name-duplicate']);
    expect(codes(v, 's3', 'site')).toEqual(['name-empty']);
    expect(codes(v, 'r1', 'vrf')).toEqual(['exchange-self', 'vrf-missing']);
    expect(codes(v, 'r2', 'vrf')).toEqual([]); // same name at another site is fine
    expect(codes(v, 'r3', 'vrf')).toEqual(['name-duplicate']); // a VRF at every site clashes with both
    expect(codes(v, 'r4', 'vrf')).toEqual(['site-missing']);
    expect(codes(v, 'n1', 'namespace')).toEqual(['site-missing']);
    expect(issuesOf(v, 'vrf', 'r1').find(i => i.code === 'exchange-self')!.severity).toBe('warning');
  });
});

describe('overlaps are scoped by routing domain', () => {
  it('is an error inside one VRF, with the scope stated', () => {
    const v = validatePlan(makePlan([{ ipv4: { network: '10.0.0.0/24' } }, { ipv4: { network: '10.0.0.128/25' } }]));
    const a = issuesOf(v, 'vlan', 'v1').find(i => i.code === 'overlap')!;
    const b = issuesOf(v, 'vlan', 'v2').find(i => i.code === 'overlap')!;
    expect(a.message).toBe('10.0.0.0/24 contains 10.0.0.128/25 of VLAN 20 VLAN v2 at Site one, in VRF "Global".');
    expect(b.message).toBe('10.0.0.128/25 is inside 10.0.0.0/24 of VLAN 10 VLAN v1 at Site one, in VRF "Global".');
    expect(a.scope).toEqual({ kind: 'same-vrf', vrfIds: ['r1'], text: 'VRF "Global"' });
    expect(a.field).toBe('ipv4.network');
  });

  it('calls identical networks duplicates', () => {
    const v = validatePlan(makePlan([{ ipv4: { network: '10.0.0.0/24' } }, { ipv4: { network: '10.0.0.0/24' } }]));
    expect(errorCodes(v, 'v1')).toEqual(['duplicate-network']);
    expect(errorCodes(v, 'v2')).toEqual(['duplicate-network']);
  });

  it('allows touching networks', () => {
    expect(validatePlan(makePlan([{ ipv4: { network: '10.0.0.0/25' } }, { ipv4: { network: '10.0.0.128/25' } }])).counts.error).toBe(0);
  });

  it('allows reuse across independent VRFs, as a note naming both', () => {
    const v = validatePlan(makePlan([{ vrfId: 'r1', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r2', ipv4: { network: '10.0.0.0/24' } }], twoVrfs(false)));
    expect(v.counts.error).toBe(0);
    const note = issuesOf(v, 'vlan', 'v1').find(i => i.code === 'reuse-independent')!;
    expect(note.severity).toBe('info');
    expect(note.scope!.kind).toBe('independent-vrfs');
    expect(note.scope!.vrfIds).toEqual(['r1', 'r2']);
    expect(note.message).toBe('10.0.0.0/24 overlaps 1 network in VRF "Lab", which does not exchange routes with VRF "Corp". Reuse across independent routing domains is allowed.');
  });

  it('is an error between VRFs that exchange routes, whichever side lists the other', () => {
    for (const plan of [
      makePlan([{ vrfId: 'r1', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r2', ipv4: { network: '10.0.0.0/25' } }], twoVrfs(true)),
      makePlan([{ vrfId: 'r2', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r1', ipv4: { network: '10.0.0.0/25' } }], twoVrfs(true)),
    ]) {
      const v = validatePlan(plan);
      const issue = issuesOf(v, 'vlan', 'v1').find(i => i.code === 'overlap')!;
      expect(issue.scope!.kind).toBe('exchanging-vrfs');
      expect(issue.message).toMatch(/which exchange routes\.$/);
      expect(errorCodes(v, 'v2')).toEqual(['overlap']);
    }
  });

  it('applies across sites when the VRF spans them', () => {
    const plan = makePlan([{ siteId: 's1', namespaceId: 'n1', ipv4: { network: '10.9.0.0/24' } }, { siteId: 's2', namespaceId: 'n2', ipv4: { network: '10.9.0.0/24' } }], {
      sites: [{ id: 's1', name: 'A', description: '', notes: '', blocks: [] }, { id: 's2', name: 'B', description: '', notes: '', blocks: [] }],
      namespaces: [{ id: 'n1', name: 'A', siteId: 's1', description: '' }, { id: 'n2', name: 'B', siteId: 's2', description: '' }],
    });
    expect(errorCodes(validatePlan(plan), 'v2')).toEqual(['duplicate-network']);
  });

  it('applies to IPv6 the same way, and never compares IPv4 with IPv6', () => {
    const same = validatePlan(makePlan([{ ipv6: { prefixes: ['2001:db8:1::/48'] } }, { ipv6: { prefixes: ['2001:db8:1:5::/64'] } }]));
    expect(errorCodes(same, 'v2')).toEqual(['overlap']);
    expect(issuesOf(same, 'vlan', 'v2').find(i => i.code === 'overlap')!.field).toBe('ipv6.prefixes');
    const independent = validatePlan(makePlan([{ vrfId: 'r1', ipv6: { prefixes: ['2001:db8:1::/64'] } }, { vrfId: 'r2', ipv6: { prefixes: ['2001:db8:1::/64'] } }], twoVrfs(false)));
    expect(independent.counts.error).toBe(0);
    // Same numeric values, different families: never compared.
    const mixed = validatePlan(makePlan([{ ipv4: { network: '10.0.0.0/8' } }, { ipv6: { prefixes: ['::a00:0/104'] } }]));
    expect(mixed.counts.error).toBe(0);
  });

  it(`lists ${OVERLAPS_LISTED} overlaps per network and counts the rest`, () => {
    const specs: VlanSpec[] = [{ ipv4: { network: '10.0.0.0/16' } }, ...Array.from({ length: 8 }, (_, i) => ({ ipv4: { network: `10.0.${i}.0/24` } }))];
    const v = validatePlan(makePlan(specs));
    const big = issuesOf(v, 'vlan', 'v1');
    expect(big.filter(i => i.code === 'overlap')).toHaveLength(OVERLAPS_LISTED);
    const more = big.find(i => i.code === 'overlap-more')!;
    expect(more.message).toBe('10.0.0.0/16 overlaps 3 more networks in the same routing domain.');
    expect(more.related).toHaveLength(3);
  });

  it('reports every overlapping pair once per side in a random plan (brute-force check)', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const specs: VlanSpec[] = Array.from({ length: 60 }, (_, i) => ({
      vrfId: rand() < 0.5 ? 'r1' : 'r2', vlanId: String(i + 2), ipv4: { network: normalize(`10.0.${Math.floor(rand() * 256)}.0/${20 + Math.floor(rand() * 8)}`) },
    }));
    const plan = makePlan(specs, twoVrfs(false));
    const v = validatePlan(plan);
    const expected = new Set<string>();
    plan.vlans.forEach((a, i) => plan.vlans.forEach((b, j) => {
      if (i === j || a.vrfId !== b.vrfId) return;
      const ra = prefixToRange(P(a.ipv4.network));
      const rb = prefixToRange(P(b.ipv4.network));
      if (ra.first <= rb.last && rb.first <= ra.last) expected.add(`${a.id}>${b.id}`);
    }));
    const actual = new Set(v.issues.filter(i => ['overlap', 'duplicate-network', 'overlap-more'].includes(i.code)).flatMap(i => i.related.map(r => `${i.target.id}>${r.id}`)));
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(expected.size).toBeGreaterThan(20);
  });
});

function normalize(text: string): string {
  const p = P(text);
  return `${[24, 16, 8, 0].map(s => Number((p.network >> BigInt(s)) & 255n)).join('.')}/${p.length}`;
}

describe('IPv4 network, gateway, DHCP, reservations and capacity', () => {
  it('reads the network strictly', () => {
    expect(errorCodes(one({ ipv4: { network: '10.0.0.5/24' } }), 'v1')).toEqual(['ipv4-host-bits']);
    expect(errorCodes(one({ ipv4: { network: '10.0.0.0/33' } }), 'v1')).toEqual(['ipv4-network-invalid']);
    expect(errorCodes(one({ ipv4: { network: '2001:db8::/64' } }), 'v1')).toEqual(['ipv4-network-family']);
    expect(errorCodes(one({ ipv4: { network: '10.0.0.0 255.255.255.0' } }), 'v1')).toEqual([]);
  });

  it.each([['127.0.0.0/24', 'is loopback'], ['224.1.0.0/16', 'is multicast'], ['240.0.0.0/8', 'is reserved'], ['0.0.0.0/0', 'overlaps 0.0.0.0/8'], ['0.1.0.0/16', 'is "this network"']])('refuses %s as a VLAN network', (network, text) => {
    const issue = issuesOf(one({ ipv4: { network } }), 'vlan', 'v1').find(i => i.code === 'not-assignable')!;
    expect(issue.severity).toBe('error');
    expect(issue.message).toContain(text);
  });

  it('warns about link-local, /31 and /32 networks', () => {
    expect(issuesOf(one({ ipv4: { network: '169.254.1.0/24' } }), 'vlan', 'v1').map(i => `${i.severity} ${i.code}`)).toEqual(['warning link-local']);
    expect(codes(one({ ipv4: { network: '10.0.0.0/31' } }), 'v1')).toEqual(['ipv4-point-to-point']);
    expect(codes(one({ ipv4: { network: '10.0.0.1/32' } }), 'v1')).toEqual(['ipv4-single-address']);
  });

  it('checks the gateway against the network, its network address and broadcast address', () => {
    const g = (gateway: string, network = '10.0.0.0/24') => errorCodes(one({ ipv4: { network, gateway } }), 'v1');
    expect(g('10.0.0.1')).toEqual([]);
    expect(g('10.0.0.254')).toEqual([]);
    expect(g('10.0.0.0')).toEqual(['gateway-network']);
    expect(g('10.0.0.255')).toEqual(['gateway-broadcast']);
    expect(g('10.0.1.1')).toEqual(['gateway-outside']);
    expect(g('9.255.255.255')).toEqual(['gateway-outside']);
    expect(g('10.0.0.256')).toEqual(['gateway-invalid']);
    expect(g('fe80::1')).toEqual(['gateway-invalid']);
    // /31 has no network or broadcast address (RFC 3021)
    expect(g('10.0.0.0', '10.0.0.0/31')).toEqual([]);
    expect(g('10.0.0.1', '10.0.0.0/31')).toEqual([]);
    expect(errorCodes(one({ ipv4: { gateway: '10.0.0.1' } }), 'v1')).toEqual(['gateway-no-network']);
    expect(issuesOf(one({ ipv4: { network: '10.0.0.0/24', gateway: '10.0.1.1' } }), 'vlan', 'v1')[0].message).toBe('10.0.1.1 is not in 10.0.0.0/24 (10.0.0.0 to 10.0.0.255).');
  });

  it('keeps DHCP pools inside the usable range, clear of the gateway, reservations and each other', () => {
    const d = (dhcp: string[], extra: VlanSpec = {}) => issuesOf(one({ ...extra, ipv4: { network: '10.0.0.0/24', gateway: '10.0.0.1', dhcp, ...extra.ipv4 } }), 'vlan', 'v1').filter(i => i.field === 'ipv4.dhcp').map(i => `${i.line} ${i.code}`);
    expect(d(['10.0.0.10 - 10.0.0.254'])).toEqual([]);
    expect(d(['10.0.0.2 - 10.0.0.2', '10.0.0.3', '10.0.0.128/26'])).toEqual([]);
    expect(d(['10.0.0.0 - 10.0.0.9'])).toEqual(['0 dhcp-network']);
    expect(d(['10.0.0.200 - 10.0.0.255'])).toEqual(['0 dhcp-broadcast']);
    expect(d(['10.0.0.200 - 10.0.1.5'])).toEqual(['0 dhcp-outside']);
    expect(d(['10.0.0.1 - 10.0.0.50'])).toEqual(['0 dhcp-gateway']);
    expect(d(['10.0.0.10 - 10.0.0.50', '10.0.0.50 - 10.0.0.60'])).toEqual(['1 dhcp-overlap']);
    expect(d(['10.0.0.10 - 10.0.0.50'], { reserved: [{ range: '10.0.0.40 - 10.0.0.45', label: 'APs' }] })).toEqual(['0 dhcp-reserved']);
    expect(d(['10.0.0.10 - 10.0.0.50'], { reserved: [{ range: '10.0.0.51 - 10.0.0.60', label: '' }] })).toEqual([]);
    expect(d(['10.0.0.50 - 10.0.0.10'])).toEqual(['0 dhcp-invalid']);
    expect(d(['10.0.0.12/24'])).toEqual(['0 dhcp-invalid']);
    expect(d(['2001:db8::1 - 2001:db8::9'])).toEqual(['0 dhcp-family']);
    expect(issuesOf(one({ ipv4: { dhcp: ['10.0.0.5 - 10.0.0.9'] } }), 'vlan', 'v1').map(i => i.code)).toEqual(['dhcp-no-network']);
    const msg = issuesOf(one({ ipv4: { network: '10.0.0.0/24', gateway: '10.0.0.1', dhcp: ['10.0.0.1 - 10.0.0.50'] } }), 'vlan', 'v1')[0].message;
    expect(msg).toBe('DHCP pool 1 (10.0.0.1 - 10.0.0.50) includes the gateway 10.0.0.1, so a client could be leased the gateway\'s address.');
  });

  it('keeps reservations inside the VLAN\'s networks, in either family', () => {
    const r = (reserved: string[], spec: VlanSpec = { ipv4: { network: '10.0.0.0/24' }, ipv6: { prefixes: ['2001:db8:1::/64'] } }) =>
      issuesOf(one({ ...spec, reserved: reserved.map(range => ({ range, label: '' })) }), 'vlan', 'v1').filter(i => i.field === 'reserved').map(i => `${i.line} ${i.severity} ${i.code}`);
    expect(r(['10.0.0.0 - 10.0.0.9', '10.0.0.255', '2001:db8:1::1 - 2001:db8:1::ff'])).toEqual([]);
    expect(r(['10.0.1.0/24'])).toEqual(['0 error reserved-outside']);
    expect(r(['2001:db8:2::1'])).toEqual(['0 error reserved-outside']);
    expect(r(['10.0.0.5 - 10.0.0.1'])).toEqual(['0 error reserved-invalid']);
    expect(r(['10.0.0.10 - 10.0.0.20', '10.0.0.20 - 10.0.0.30'])).toEqual(['1 warning reserved-overlap']);
    expect(r(['10.0.0.1'], {})).toEqual(['0 error reserved-no-network']);
    expect(r(['2001:db8::1'], { ipv4: { network: '10.0.0.0/24' } })).toEqual(['0 error reserved-no-network']);
  });

  it('checks the host target against the usable addresses of the network', () => {
    const h = (hosts: string, network = '10.0.0.0/24') => issuesOf(one({ hosts, ipv4: { network } }), 'vlan', 'v1').map(i => `${i.severity} ${i.code}`);
    expect(h('254')).toEqual([]);
    expect(h('255')).toEqual(['error capacity']);
    expect(h('2', '10.0.0.0/31')).toEqual(['warning ipv4-point-to-point']);
    expect(h('3', '10.0.0.0/31')).toEqual(['error capacity', 'warning ipv4-point-to-point']);
    expect(h('2', '10.0.0.0/30')).toEqual([]);
    expect(h('3', '10.0.0.0/30')).toEqual(['error capacity']);
    expect(h('0')).toEqual(['error hosts-invalid']);
    expect(h('ten')).toEqual(['error hosts-invalid']);
    expect(h('4294967295')).toEqual(['error hosts-too-many']);
    expect(issuesOf(one({ hosts: '300', ipv4: { network: '10.0.0.0/24' } }), 'vlan', 'v1')[0].message).toBe('Needs 300 usable addresses, but 10.0.0.0/24 has 254. The smallest network that fits is a /23.');
    expect(issuesOf(one({ hosts: '300' }), 'vlan', 'v1').map(i => `${i.severity} ${i.code}`)).toEqual(['info unallocated']);
  });

  it('notes a VLAN with no network at all', () => {
    expect(issuesOf(one({}), 'vlan', 'v1').map(i => `${i.severity} ${i.code} ${i.field}`)).toEqual(['info no-network null']);
  });
});

describe('IPv6 prefixes and gateway', () => {
  const six = (prefixes: string[], gateway = '') => issuesOf(one({ ipv6: { prefixes, gateway } }), 'vlan', 'v1').map(i => `${i.severity} ${i.code}${i.line === null ? '' : ` ${i.line}`}`);

  it('accepts /64 prefixes and warns about other lengths', () => {
    expect(six(['2001:db8:10:1::/64', '2001:db8:10:2::/64'])).toEqual([]);
    expect(six(['2001:db8:10::/56'])).toEqual(['warning ipv6-not-64 0']);
    expect(six(['2001:db8:10:1::/80'])).toEqual(['warning ipv6-not-64 0']);
  });

  it('rejects invalid, host-bit, IPv4, duplicate and self-overlapping entries', () => {
    expect(six(['2001:db8:10:1::5/64'])).toEqual(['error ipv6-host-bits 0']);
    expect(six(['2001:db8::g/64'])).toEqual(['error ipv6-invalid 0']);
    expect(six(['2001:db8::/129'])).toEqual(['error ipv6-invalid 0']);
    expect(six(['10.0.0.0/24'])).toEqual(['error ipv6-family 0']);
    expect(six(['2001:db8:1::/64', '2001:DB8:1:0::/64'])).toEqual(['error ipv6-duplicate 1']);
    expect(six(['2001:db8:1::/48', '2001:db8:1:2::/64'])).toEqual(['error ipv6-self-overlap 1', 'warning ipv6-not-64 0']);
  });

  it.each([['fe80::/64', 'link-local'], ['ff02::/64', 'multicast'], ['::ffff:0:0/96', 'IPv4-mapped'], ['::1/128', 'loopback'], ['::/64', 'unspecified']])('refuses %s', (prefix, text) => {
    const issue = issuesOf(one({ ipv6: { prefixes: [prefix] } }), 'vlan', 'v1').find(i => i.code === 'not-assignable')!;
    expect(issue.message).toContain(text);
  });

  it('accepts a gateway in a prefix or a link-local gateway, and refuses the Subnet-Router anycast address', () => {
    expect(six(['2001:db8:1::/64'], '2001:db8:1::1')).toEqual([]);
    expect(six(['2001:db8:1::/64'], 'fe80::1')).toEqual([]);
    expect(six([], 'fe80::1')).toEqual([]);
    expect(six(['2001:db8:1::/64'], '2001:db8:1::')).toEqual(['error gateway6-anycast']);
    expect(six(['2001:db8:1::/64'], '2001:db8:2::1')).toEqual(['error gateway6-outside']);
    expect(six([], '2001:db8:2::1')).toEqual(['error gateway6-no-network']);
    expect(six(['2001:db8:1::/64'], '10.0.0.1')).toEqual(['error gateway6-invalid']);
  });
});

describe('parent blocks', () => {
  const withBlocks = (vlans: VlanSpec[], blocks: Plan['sites'][number]['blocks'], extra: Partial<Plan> = {}) => makePlan(vlans, { sites: [{ id: 's1', name: 'HQ', description: '', notes: '', blocks }], ...extra });
  const block = (id: string, network: string, vrfId = 'r1', reserved: { range: string; label: string }[] = []) => ({ id, network, vrfId, description: '', reserved });

  it('keeps a site\'s VLAN networks inside its blocks for that VRF and family', () => {
    const plan = withBlocks([
      { ipv4: { network: '10.40.1.0/24' } }, { ipv4: { network: '10.41.0.0/24' } }, { ipv6: { prefixes: ['2001:db8:9::/64'] } }, { vrfId: 'r2', ipv4: { network: '172.16.0.0/24' } },
    ], [block('b1', '10.40.0.0/16'), block('b2', '2001:db8:40::/48')], twoVrfs(false));
    const v = validatePlan(plan);
    expect(errorCodes(v, 'v1')).toEqual([]);
    expect(errorCodes(v, 'v2')).toEqual(['outside-parent']);
    expect(issuesOf(v, 'vlan', 'v2')[0].message).toBe('10.41.0.0/24 is outside the parent blocks of site "HQ" for VRF "Corp": 10.40.0.0/16.');
    expect(errorCodes(v, 'v3')).toEqual(['outside-parent']);
    expect(errorCodes(v, 'v4')).toEqual([]); // no blocks for VRF r2 at this site: no constraint
  });

  it('a network straddling the block edge is outside it', () => {
    expect(errorCodes(validatePlan(withBlocks([{ ipv4: { network: '10.40.0.0/15' } }], [block('b1', '10.40.0.0/16')])), 'v1')).toEqual(['outside-parent']);
  });

  it('validates blocks: network, VRF and reservations', () => {
    const v = validatePlan(withBlocks([], [block('b1', ''), block('b2', '10.0.0.1/8'), block('b3', '10.0.0.0/8', 'zz'), block('b4', '172.16.0.0/16', 'r1', [{ range: '172.17.0.0/24', label: '' }, { range: 'x', label: '' }])]));
    expect(codes(v, 'b1', 'block')).toEqual(['block-network-empty']);
    expect(codes(v, 'b2', 'block')).toEqual(['block-host-bits']);
    expect(codes(v, 'b3', 'block')).toEqual(['vrf-missing']);
    expect(codes(v, 'b4', 'block')).toEqual(['reserved-invalid', 'reserved-outside']);
  });

  it('flags overlapping blocks in one routing domain, across sites too, but not in independent VRFs', () => {
    const sites = (b1: string, b2: string, vrf2: string): Partial<Plan> => ({
      sites: [{ id: 's1', name: 'A', description: '', notes: '', blocks: [block('b1', b1)] }, { id: 's2', name: 'B', description: '', notes: '', blocks: [block('b2', b2, vrf2)] }],
      ...twoVrfs(false),
    });
    const clash = validatePlan(makePlan([], sites('10.0.0.0/16', '10.0.128.0/17', 'r1')));
    expect(codes(clash, 'b1', 'block')).toEqual(['block-overlap']);
    expect(issuesOf(clash, 'block', 'b2')[0].message).toBe('10.0.128.0/17 overlaps 10.0.0.0/16 of site "A" in VRF "Corp".');
    expect(validatePlan(makePlan([], sites('10.0.0.0/16', '10.0.0.0/16', 'r2'))).counts.error).toBe(0);
  });
});

describe('ordering', () => {
  it('lists errors, then warnings, then notes, each in plan order', () => {
    const v = validatePlan(makePlan([{ hosts: '5' }, { vlanId: '1002', ipv4: { network: '10.0.0.0/24', gateway: '10.0.1.1' } }, { vlanId: 'x' }]));
    expect(v.issues.map(i => `${i.severity} ${i.target.id}`)).toEqual(['error v2', 'error v3', 'warning v2', 'info v1', 'info v3']);
  });
});

// ---- IPv6 prefix allocator ----------------------------------------------------------------------

describe('prefix allocator', () => {
  const r = (text: string) => prefixToRange(P(text));
  const texts = (list: readonly IpPrefix[] | undefined) => (list ?? []).map(p => `${p.network.toString(16)}/${p.length}`);
  const fmt6 = (list: readonly IpPrefix[] | undefined) => (list ?? []).map(p => {
    const parts: string[] = [];
    for (let i = 7; i >= 0; i--) parts.push(((p.network >> BigInt(16 * i)) & 0xffffn).toString(16));
    return `${parts.join(':')}/${p.length}`;
  });

  it('places one /64 per request, lowest first', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8:10::/48')], childLength: 64, occupied: [], requests: [{ key: 'a', count: 1 }, { key: 'b', count: 2 }] });
    expect(fmt6(result.placed.get('a'))).toEqual(['2001:db8:10:0:0:0:0:0/64']);
    expect(fmt6(result.placed.get('b'))).toEqual(['2001:db8:10:1:0:0:0:0/64', '2001:db8:10:2:0:0:0:0/64']);
    expect(result.freeBefore).toBe(65536n);
    expect(result.freeAfter).toBe(65533n);
  });

  it('skips occupied space, keeping alignment', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8::/56')], childLength: 60, occupied: [r('2001:db8::/64'), r('2001:db8:0:11::/64'), r('2001:db8:0:30::/62')], requests: [{ key: 'a', count: 3 }] });
    expect(fmt6(result.placed.get('a'))).toEqual(['2001:db8:0:20:0:0:0:0/60', '2001:db8:0:40:0:0:0:0/60', '2001:db8:0:50:0:0:0:0/60']);
    expect(result.freeBefore).toBe(13n);
  });

  it('fills parents in order and fails a request atomically when too few are left', () => {
    const result = allocatePrefixes({
      parents: [P('2001:db8:1::/62'), P('2001:db8:2::/63')], childLength: 64, occupied: [r('2001:db8:1:1::/64')],
      requests: [{ key: 'a', count: 3 }, { key: 'b', count: 2 }, { key: 'c', count: 3 }, { key: 'd', count: 1 }],
    });
    expect(fmt6(result.placed.get('a'))).toEqual(['2001:db8:1:0:0:0:0:0/64', '2001:db8:1:2:0:0:0:0/64', '2001:db8:1:3:0:0:0:0/64']);
    expect(fmt6(result.placed.get('b'))).toEqual(['2001:db8:2:0:0:0:0:0/64', '2001:db8:2:1:0:0:0:0/64']);
    expect(result.placed.has('c')).toBe(false);
    expect(result.failures).toEqual([
      { key: 'c', count: 3, available: 0n, message: 'needs 3 /64 prefixes, but the parent space is exhausted: no /64 is free.' },
      { key: 'd', count: 1, available: 0n, message: 'needs 1 /64 prefix, but the parent space is exhausted: no /64 is free.' },
    ]);
    expect(result.placed.has('d')).toBe(false);
    expect(result.freeBefore).toBe(5n);
    expect(result.freeAfter).toBe(0n);
  });

  it('lets a later, smaller request use what a failed larger one could not', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8::/62')], childLength: 64, occupied: [], requests: [{ key: 'a', count: 3 }, { key: 'b', count: 2 }, { key: 'c', count: 1 }] });
    expect(result.failures.map(f => `${f.key} ${f.available}`)).toEqual(['b 1']);
    expect(result.failures[0].message).toBe('needs 2 /64 prefixes, but only 1 is free. Nothing was assigned to it.');
    expect(fmt6(result.placed.get('c'))).toEqual(['2001:db8:0:3:0:0:0:0/64']);
  });

  it('counts exactly in very large spaces', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8::/32')], childLength: 64, occupied: [r('2001:db8::/33')], requests: [{ key: 'a', count: 1 }] });
    expect(result.freeBefore).toBe(2n ** 31n);
    expect(fmt6(result.placed.get('a'))).toEqual(['2001:db8:8000:0:0:0:0:0/64']);
    expect(alignedCount(r('::/0'), 2n ** 64n)).toBe(2n ** 64n);
    expect(alignedCount({ family: 6, first: 1n, last: 2n ** 64n * 3n - 1n }, 2n ** 64n)).toBe(2n);
    expect(alignedCount({ family: 6, first: 5n, last: 6n }, 4n)).toBe(0n);
  });

  it('refuses a run over the limit as a whole instead of cutting it short', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8::/32')], childLength: 64, occupied: [], requests: [{ key: 'a', count: DEFAULT_MAX_CHILDREN }, { key: 'b', count: 1 }] });
    expect(result.errors.map(e => e.code)).toEqual(['too-many']);
    expect(result.placed.size).toBe(0);
    expect(result.errors[0].message).toBe('This run would place 65,537 prefixes, more than the limit of 65,536 per run. Allocate fewer VLANs at a time or fewer prefixes per VLAN; nothing was allocated.');
    expect(allocatePrefixes({ parents: [P('2001:db8::/32')], childLength: 64, occupied: [], requests: [{ key: 'a', count: DEFAULT_MAX_CHILDREN }] }).placed.get('a')).toHaveLength(DEFAULT_MAX_CHILDREN);
  });

  it('rejects bad input', () => {
    const codesOf = (input: Parameters<typeof allocatePrefixes>[0]) => allocatePrefixes(input).errors.map(e => e.code);
    expect(codesOf({ parents: [], childLength: 64, occupied: [], requests: [] })).toEqual(['no-parent']);
    expect(codesOf({ parents: [P('2001:db8::/64')], childLength: 64, occupied: [], requests: [] })).toEqual(['child-length']);
    expect(codesOf({ parents: [P('2001:db8::/48')], childLength: 129, occupied: [], requests: [] })).toEqual(['child-length']);
    expect(codesOf({ parents: [P('2001:db8::/48'), P('2001:db8::/56')], childLength: 64, occupied: [], requests: [] })).toEqual(['parents-overlap']);
    expect(codesOf({ parents: [P('2001:db8::/48'), P('10.0.0.0/8')], childLength: 64, occupied: [], requests: [] })).toEqual(['mixed-family']);
    expect(codesOf({ parents: [P('2001:db8::/48')], childLength: 64, occupied: [], requests: [{ key: 'a', count: 0 }] })).toEqual(['count-invalid']);
  });

  it('reports the remaining free space as exact CIDR blocks', () => {
    const result = allocatePrefixes({ parents: [P('2001:db8::/62')], childLength: 64, occupied: [], requests: [{ key: 'a', count: 1 }] });
    expect(texts(result.free)).toEqual(['20010db8000000010000000000000000/64', '20010db8000000020000000000000000/63']);
  });
});

// ---- Plan allocation -------------------------------------------------------------------------------

describe('IPv4 allocation into a plan', () => {
  const v4 = (o: Partial<AllocationOptions> = {}): AllocationOptions => ({ family: 4, siteId: 's1', vrfId: 'r1', parents: ['10.10.0.0/16'], reallocate: false, setGateway: true, ...o });

  it('fills VLANs that have a host target and no network, and keeps everything else', () => {
    const plan = examplePlan();
    const pv = previewAllocation(plan, validatePlan(plan), v4());
    expect(pv.errors).toEqual([]);
    expect(pv.changes.map(c => `${c.vlanId} ${c.kind} ${c.after.join()} gw ${c.gateway}`)).toEqual(['v5 new 10.10.0.0/25 gw 10.10.0.1']);
    expect(pv.overwrites).toBe(0);
    expect(pv.skipped.map(s => s.vlanId)).toEqual(['v1', 'v2', 'v3', 'v4']);
    const applied = applyAllocation(plan, pv, false);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const cameras = applied.value.vlans.find(v => v.id === 'v5')!;
    expect([cameras.ipv4.network, cameras.ipv4.gateway]).toEqual(['10.10.0.0/25', '10.10.0.1']);
    expect(plan.vlans.find(v => v.id === 'v5')!.ipv4.network).toBe(''); // the original is untouched
    const after = validatePlan(applied.value);
    expect(after.counts.error).toBe(0);
    expect(after.issues.filter(i => i.code === 'unallocated').map(i => i.target.id)).toEqual(['v10']);
  });

  it('needs explicit confirmation to replace existing networks, and never moves fixed ones', () => {
    const plan = examplePlan();
    const pv = previewAllocation(plan, validatePlan(plan), v4({ reallocate: true }));
    expect(pv.changes.map(c => `${c.vlanId} ${c.kind} ${c.before.join()} -> ${c.after.join()}`)).toEqual([
      'v1 changed 10.10.10.0/24 -> 10.10.0.0/24', 'v2 changed 10.10.20.0/24 -> 10.10.1.0/25', 'v4 changed 10.10.99.0/26 -> 10.10.2.0/26', 'v5 new  -> 10.10.1.128/25',
    ]);
    // Voice needs 120 addresses, so it shrinks to a /25; its DHCP pool (offsets 50 to 200) no longer fits.
    expect(pv.changes[1].stranded).toEqual(['10.10.20.50 - 10.10.20.200 (does not fit in 10.10.1.0/25)']);
    expect(pv.changes[1].moves).toEqual([{ field: 'ipv4.gateway', from: '10.10.20.1', to: '10.10.1.1' }]);
    expect(pv.changes[3].gateway).toBe('10.10.1.129');
    expect(pv.skipped.find(s => s.vlanId === 'v3')!.message).toBe('Keeps 10.10.30.0/25 (marked fixed).');
    expect(pv.overwrites).toBe(3);
    const refused = applyAllocation(plan, pv, false);
    expect(refused.ok ? 'applied' : refused.error.code).toBe('confirmation-required');
    const done = applyAllocation(plan, pv, true);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const users = done.value.vlans.find(v => v.id === 'v1')!;
    // Gateway, DHCP pool and reservation keep their offsets in the new network.
    expect([users.ipv4.network, users.ipv4.gateway, users.ipv4.dhcp[0], users.reserved[0].range]).toEqual(['10.10.0.0/24', '10.10.0.1', '10.10.0.100 - 10.10.0.250', '10.10.0.2 - 10.10.0.20']);
    expect(done.value.vlans.find(v => v.id === 'v3')!.ipv4.network).toBe('10.10.30.0/25');
    const after = validatePlan(done.value);
    expect(after.issues.filter(i => i.severity === 'error').map(i => `${i.target.id} ${i.code}`)).toEqual(['v2 dhcp-outside']);
  });

  it('refuses a preview made before the plan changed', () => {
    const plan = examplePlan();
    const pv = previewAllocation(plan, validatePlan(plan), v4());
    plan.vlans.find(v => v.id === 'v5')!.ipv4.network = '10.10.200.0/25';
    const r = applyAllocation(plan, pv, true);
    expect(r.ok ? 'applied' : r.error.code).toBe('stale-preview');
  });

  it('leaves entries that do not fit a smaller network where they were', () => {
    const plan = makePlan([{ hosts: '20', ipv4: { network: '10.0.0.0/24', gateway: '10.0.0.200', dhcp: ['10.0.0.10 - 10.0.0.20'] } }]);
    const pv = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.0.0.0/24'], reallocate: true }));
    expect(pv.changes[0].after).toEqual(['10.0.0.0/27']);
    expect(pv.changes[0].kind).toBe('changed');
    expect(pv.changes[0].stranded).toEqual(['10.0.0.200 (does not fit in 10.0.0.0/27)']);
    expect(pv.changes[0].moves).toEqual([]);
  });

  it('uses fragmented space in order: what does not fit the first parent goes to the next', () => {
    const plan = makePlan([{ hosts: '100' }, { hosts: '500' }, { hosts: '20' }, { hosts: '20' }]);
    const pv = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.0.0.0/25', '10.0.8.0/22', '10.0.0.128/27'], setGateway: false }));
    expect(pv.changes.map(c => `${c.vlanId} ${c.after.join()}`)).toEqual(['v1 10.0.0.0/25', 'v2 10.0.8.0/23', 'v3 10.0.10.0/27', 'v4 10.0.10.32/27']);
    expect(pv.failures).toEqual([]);
  });

  it('avoids space in use anywhere in the routing domain, block reservations and other sites\' blocks', () => {
    const plan = makePlan([
      { siteId: 's1', hosts: '50' },
      { siteId: 's2', namespaceId: 'n2', ipv4: { network: '10.0.0.0/26' } },
      { siteId: 's1', vrfId: 'r2', ipv4: { network: '10.0.0.64/26' } },
    ], {
      sites: [
        { id: 's1', name: 'A', description: '', notes: '', blocks: [{ id: 'b1', network: '10.0.0.0/24', vrfId: 'r1', description: '', reserved: [{ range: '10.0.0.128 - 10.0.0.191', label: 'later' }] }] },
        { id: 's2', name: 'B', description: '', notes: '', blocks: [{ id: 'b2', network: '10.0.0.192/26', vrfId: 'r1', description: '', reserved: [] }] },
      ],
      namespaces: [{ id: 'n1', name: 'A', siteId: 's1', description: '' }, { id: 'n2', name: 'B', siteId: 's2', description: '' }],
      ...twoVrfs(false),
    });
    // 10.0.0.0/26 is used by site B in the same VRF, .128/26 is reserved, .192/26 is site B's block; .64/26 is used only in the independent VRF.
    const pv = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.0.0.0/24'] }));
    expect(pv.changes.map(c => c.after.join())).toEqual(['10.0.0.64/26']);
    // When the other VRF exchanges routes with this one, its network is in use too.
    const exchanging = structuredClone(plan);
    exchanging.vrfs[0].exchangesWith = ['r2'];
    const pv2 = previewAllocation(exchanging, validatePlan(exchanging), v4({ parents: ['10.0.0.0/24'] }));
    expect(pv2.changes).toEqual([]);
    expect(pv2.failures.map(f => f.message)).toEqual(['Needs a /26 (64 addresses for 50 usable), but no free aligned block that size is left in 10.0.0.0/24. No free space is left.']);
  });

  it('explains failures with the largest free block', () => {
    const plan = makePlan([{ hosts: '1000' }, { hosts: '200' }]);
    const pv = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.0.0.0/23'] }));
    expect(pv.changes.map(c => c.after.join())).toEqual(['10.0.0.0/24']);
    expect(pv.failures.map(f => f.message)).toEqual(['Needs a /22 (1,024 addresses for 1,000 usable), which is larger than 10.0.0.0/23.']);
    const full = makePlan([{ hosts: '200' }, { hosts: '200' }, { hosts: '100' }]);
    const pv2 = previewAllocation(full, validatePlan(full), v4({ parents: ['10.0.0.0/23', '10.0.4.0/26'] }));
    expect(pv2.failures.map(f => f.message)).toEqual(['Needs a /25 (128 addresses for 100 usable), but no free aligned block that size is left in any of the 2 parent networks. The largest free block is a /26 (64 addresses).']);
  });

  it('skips VLANs whose network or host target is not valid', () => {
    const plan = makePlan([{ hosts: '20', ipv4: { network: '10.0.0.1/24' } }, { hosts: 'lots' }, {}]);
    const pv = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.0.0.0/24'], reallocate: true }));
    expect(pv.changes).toEqual([]);
    expect(pv.skipped.map(s => s.message)).toEqual([
      'Its IPv4 network is not valid. Fix it first; it was not treated as free or as used.', 'Its host target is not valid.', 'It has no host target, so there is nothing to size a network from.',
    ]);
  });

  it('checks the request itself', () => {
    const plan = makePlan([{ hosts: '20' }]);
    const errs = (o: Partial<AllocationOptions>) => previewAllocation(plan, validatePlan(plan), v4(o)).errors;
    expect(errs({ parents: [] })).toEqual(['Enter at least one parent IPv4 network.']);
    expect(errs({ parents: ['10.0.0.5/24'] })).toEqual(['Parent 1 (10.0.0.5/24) has host bits set. Did you mean 10.0.0.0/24?']);
    expect(errs({ parents: ['10.0.0.0/16', '10.0.5.0/24'] })).toEqual(['Parent 2 (10.0.5.0/24) overlaps 10.0.0.0/16.']);
    expect(errs({ parents: ['2001:db8::/48'] })).toHaveLength(1);
    expect(errs({ siteId: 'zz' })).toEqual(['Choose a site.']);
  });

  it('is deterministic', () => {
    const plan = syntheticPlan(120);
    for (const v of plan.vlans.slice(0, 30)) v.ipv4 = { ...v.ipv4, network: '', gateway: '', dhcp: [] };
    const a = previewAllocation(plan, validatePlan(plan), v4({ parents: ['10.1.0.0/16'] }));
    const b = previewAllocation(structuredClone(plan), validatePlan(structuredClone(plan)), v4({ parents: ['10.1.0.0/16'] }));
    expect(a.changes).toEqual(b.changes);
    expect(a.changes).toHaveLength(30);
  });
});

describe('IPv6 allocation into a plan', () => {
  const v6 = (o: Partial<AllocationOptions> = {}): AllocationOptions => ({ family: 6, siteId: 's1', vrfId: 'r1', parents: ['2001:db8:10::/48'], reallocate: false, childLength: 64, perVlan: 1, ...o });

  it('gives each VLAN without IPv6 one /64, around existing prefixes, in plan order', () => {
    const plan = examplePlan();
    const pv = previewAllocation(plan, validatePlan(plan), v6());
    expect(pv.changes.map(c => `${c.vlanId} ${c.after.join()}`)).toEqual(['v4 2001:db8:10::/64', 'v5 2001:db8:10:1::/64']);
    expect(pv.freeChildrenBefore).toBe(65536n - 3n);
    expect(pv.freeChildrenAfter).toBe(65536n - 5n);
  });

  it('gives several prefixes per VLAN when asked, and replaces only with confirmation', () => {
    const plan = makePlan([{ ipv6: { prefixes: ['2001:db8:0:9::/64'], gateway: '2001:db8:0:9::1' } }, { ipv6: { prefixes: ['2001:db8:0:a::/64'], fixed: true } }, {}]);
    const pv = previewAllocation(plan, validatePlan(plan), v6({ parents: ['2001:db8::/56'], perVlan: 2, reallocate: true }));
    expect(pv.changes.map(c => `${c.vlanId} ${c.kind} ${c.after.join(' ')} gw ${c.gateway}`)).toEqual([
      'v1 changed 2001:db8::/64 2001:db8:0:1::/64 gw 2001:db8::1', 'v3 new 2001:db8:0:2::/64 2001:db8:0:3::/64 gw null',
    ]);
    expect(pv.overwrites).toBe(1);
    expect(applyAllocation(plan, pv, false).ok).toBe(false);
    const done = applyAllocation(plan, pv, true);
    expect(done.ok && done.value.vlans[0].ipv6.gateway).toBe('2001:db8::1');
    expect(done.ok && validatePlan(done.value).counts.error).toBe(0);
  });

  it('reports exhaustion per VLAN without partial assignment', () => {
    const plan = makePlan([{}, {}, {}]);
    const pv = previewAllocation(plan, validatePlan(plan), v6({ parents: ['2001:db8::/63'], perVlan: 1 }));
    expect(pv.changes.map(c => c.vlanId)).toEqual(['v1', 'v2']);
    expect(pv.failures.map(f => `${f.vlanId}: ${f.message}`)).toEqual(['v3: Needs 1 /64 prefix, but the parent space is exhausted: no /64 is free.']);
  });

  it('enforces the per-VLAN and per-run limits without truncating', () => {
    const plan = makePlan([{}, {}]);
    expect(previewAllocation(plan, validatePlan(plan), v6({ perVlan: 257 })).errors).toEqual(['Prefixes per VLAN must be a whole number from 1 to 256.']);
    const many = makePlan(Array.from({ length: 300 }, () => ({})));
    const pv = previewAllocation(many, validatePlan(many), v6({ parents: ['2001:db8::/32'], perVlan: 256 }));
    expect(pv.errors[0]).toMatch(/^This run would place 76,800 prefixes, more than the limit of 65,536 per run\./);
    expect(pv.changes).toEqual([]);
    expect(previewAllocation(plan, validatePlan(plan), v6({ childLength: 40 })).errors).toEqual(['2001:db8:10::/48 cannot hold /40 prefixes: the child prefix must be longer than the parent\'s /48.']);
  });
});

// ---- Address map ---------------------------------------------------------------------------------

describe('address map', () => {
  it('draws at most 256 cells, whatever the size of the space', () => {
    const plan = examplePlan();
    const v = validatePlan(plan);
    const { items, conflicts } = collectMapItems(plan, v, 6, 'r1');
    for (const view of ['::/0', '2001:db8::/32', '2001:db8:10::/48', '2001:db8:10:10::/64', '2001:db8:10:10::/124']) {
      const mv = buildMapView(P(view), items, conflicts);
      expect(mv.cells.length).toBe(Math.min(256, 2 ** (128 - P(view).length)));
    }
    expect(MAX_CELL_BITS).toBe(8);
    const tiny = buildMapView(P('10.0.0.0/28'), [], []);
    expect([tiny.cells.length, tiny.columns, tiny.cellLength]).toEqual([16, 4, 32]);
    expect(buildMapView(P('10.0.0.0/29'), [], []).columns).toBe(4);
  });

  it('marks allocated, partial, reserved and free cells, with owners', () => {
    const plan = examplePlan();
    const { items, conflicts } = collectMapItems(plan, validatePlan(plan), 4, 'r1');
    const mv = buildMapView(P('10.10.0.0/16'), items, conflicts);
    const cell = (third: number) => mv.cells[third];
    expect(cell(10).status).toBe('allocated');
    expect(cell(10).owner!.ownerId).toBe('v1');
    expect(cell(30).status).toBe('partial');
    expect(cell(30).fill).toBe(0.5);
    expect(cell(99).status).toBe('partial');
    expect(cell(255).status).toBe('reserved');
    expect(cell(0).status).toBe('free');
    expect(mv.itemCount).toBe(7);
    expect(mv.conflictCount).toBe(0);
    // Inside VLAN 10's /24, the reservation shows at single-address cells.
    const inner = buildMapView(P('10.10.10.0/24'), items, conflicts);
    expect(inner.cells.every(c => c.status === 'allocated')).toBe(true);
  });

  it('shows conflicts only between networks that must not overlap', () => {
    const plan = makePlan([{ vrfId: 'r1', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r1', ipv4: { network: '10.0.0.128/25' } }, { vrfId: 'r2', ipv4: { network: '10.0.1.0/24' } }, { vrfId: 'r1', ipv4: { network: '10.0.1.0/25' } }], twoVrfs(false));
    const v = validatePlan(plan);
    const { items, conflicts } = collectMapItems(plan, v, 4, 'r1');
    expect(items.filter(i => i.kind === 'network').map(i => i.ownerId)).toEqual(['v1', 'v2', 'v4']);
    // Cells are /31: 0-63 VLAN 1 only, 64-127 VLANs 1 and 2 (same VRF), 128-191 VLAN 4, 192-255 free.
    const status = (m: ReturnType<typeof buildMapView>, from: number, to: number) => [...new Set(m.cells.slice(from, to).map(c => c.status))];
    const mv = buildMapView(P('10.0.0.0/23'), items, conflicts);
    expect([status(mv, 0, 64), status(mv, 64, 128), status(mv, 128, 192), status(mv, 192, 256)]).toEqual([['allocated'], ['conflict'], ['allocated'], ['free']]);
    // Once VRF 2 exchanges routes with VRF 1, its 10.0.1.0/24 is shown and clashes with VLAN 4.
    const joined = structuredClone(plan);
    joined.vrfs[0].exchangesWith = ['r2'];
    const j = collectMapItems(joined, validatePlan(joined), 4, 'r1');
    const mj = buildMapView(P('10.0.0.0/23'), j.items, j.conflicts);
    expect([status(mj, 128, 192), status(mj, 192, 256)]).toEqual([['conflict'], ['allocated']]);
  });

  it('does not draw a conflict between two neighbors that are independent of each other', () => {
    // r1 exchanges routes with r2 and with r3, but r2 and r3 do not exchange routes with each other.
    const plan = makePlan([{ vrfId: 'r2', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r3', ipv4: { network: '10.0.0.0/24' } }, { vrfId: 'r1', ipv4: { network: '10.0.1.0/24' } }], {
      vrfs: [
        { id: 'r1', name: 'Shared', siteId: '', exchangesWith: ['r2', 'r3'], description: '', notes: '' },
        { id: 'r2', name: 'A', siteId: '', exchangesWith: [], description: '', notes: '' },
        { id: 'r3', name: 'B', siteId: '', exchangesWith: [], description: '', notes: '' },
      ],
    });
    const v = validatePlan(plan);
    expect(v.counts.error).toBe(0);
    expect(v.forTarget('vlan', 'v1').map(i => i.code)).toEqual(['reuse-independent']);
    const { items, conflicts } = collectMapItems(plan, v, 4, 'r1');
    expect(items.map(i => i.ownerId)).toEqual(['v1', 'v2', 'v3']);
    expect(conflicts).toEqual([]);
    expect(buildMapView(P('10.0.0.0/23'), items, conflicts).cells.some(c => c.status === 'conflict')).toBe(false);
  });

  it('builds the zoom path a level at a time', () => {
    expect(zoomPath(P('10.0.0.0/8'), P('10.20.30.0/24')).map(p => `${p.network}/${p.length}`)).toEqual([`${P('10.0.0.0/8').network}/8`, `${P('10.20.0.0/16').network}/16`, `${P('10.20.30.0/24').network}/24`]);
  });

  it('is fast for a large IPv6 space with many networks', () => {
    const plan = syntheticPlan(1000);
    const v = validatePlan(plan);
    const { items, conflicts } = collectMapItems(plan, v, 6, 'r1');
    const start = performance.now();
    const mv = buildMapView(P('2001:db8::/32'), items, conflicts);
    expect(performance.now() - start).toBeLessThan(500);
    expect(mv.cells.filter(c => c.status !== 'free')).toHaveLength(1);
    expect(mv.itemCount).toBe(980);
  });
});

// ---- File ------------------------------------------------------------------------------------------

describe('plan file', () => {
  it('round-trips the example and odd values exactly', () => {
    const plan = examplePlan();
    plan.vlans[0].vlanId = '010';
    plan.vlans[1].vlanId = 'abc';
    plan.vlans[2].hosts = '';
    plan.vlans[3].notes = 'line one\nline two, "quoted"';
    plan.vlans[4].ipv4.dhcp = ['10.0.0.300 - nonsense'];
    const text = planToJson(plan);
    const back = parsePlanJson(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.plan).toEqual(plan);
    expect(back.value.warnings).toEqual([]);
    expect(planToJson(back.value.plan)).toBe(text);
  });

  it('writes VLAN IDs and host targets as numbers when they are plain integers', () => {
    const json = JSON.parse(planToJson(examplePlan())) as { format: string; version: number; plan: { vlans: { vlanId: unknown; hosts: unknown }[] } };
    expect([json.format, json.version]).toEqual(['netforge-plan', PLAN_VERSION]);
    expect(json.plan.vlans[0].vlanId).toBe(10);
    expect(json.plan.vlans[0].hosts).toBe(200);
    expect(json.plan.vlans[5].hosts).toBe('');
  });

  it('round-trips large generated plans', () => {
    const plan = syntheticPlan(1000);
    const back = parsePlanJson(planToJson(plan));
    expect(back.ok && back.value.plan).toEqual(plan);
  });

  const file = (plan: unknown, extra: object = {}) => JSON.stringify({ format: 'netforge-plan', version: 1, plan, ...extra });
  const code = (text: string) => {
    const r = parsePlanJson(text);
    return r.ok ? 'ok' : r.error.code;
  };
  const message = (text: string) => {
    const r = parsePlanJson(text);
    return r.ok ? 'ok' : r.error.message;
  };

  it('rejects unsupported and invalid versions clearly', () => {
    expect(code(JSON.stringify({ format: 'netforge-plan', version: 2, plan: {} }))).toBe('unsupported-version');
    expect(message(JSON.stringify({ format: 'netforge-plan', version: 2, plan: {} }))).toBe('This plan file uses format version 2, which is newer than this version of NetForge reads (version 1). Open it with a newer NetForge.');
    for (const version of [0, -1, 1.5, '1', null]) expect(code(JSON.stringify({ format: 'netforge-plan', version, plan: {} }))).toBe('invalid-version');
    expect(code(JSON.stringify({ format: 'netforge-plan', plan: {} }))).toBe('invalid-version');
  });

  it('handles malformed files safely', () => {
    expect(code('')).toBe('empty');
    expect(code('   \n')).toBe('empty');
    expect(code('{"format": "netforge-plan",')).toBe('not-json');
    expect(message('{\n "a": 1,\n}')).toBe('The file is not valid JSON: Trailing comma: JSON does not allow a comma before \'}\'. (line 2, column 8).');
    expect(code('[1, 2]')).toBe('not-plan');
    expect(code('{"format":"other"}')).toBe('not-plan');
    expect(code('"netforge-plan"')).toBe('not-plan');
    expect(code('{"format":"netforge-plan","version":1,"version":2,"plan":{}}')).toBe('duplicate-key');
    expect(code(`${String.fromCharCode(0xfeff)}${file({})}`)).toBe('ok');
    expect(code(' '.repeat(20_000_001))).toBe('empty');
    expect(code(`${file({})}${' '.repeat(20_000_000)}`)).toBe('too-large');
  });

  it.each([
    [{ vlans: {} }, 'plan.vlans must be a list.'],
    [{ vlans: [{ id: 'v1', name: 5 }] }, 'plan.vlans[0].name must be text.'],
    [{ vlans: [{ id: 'v1', vlanId: 1.5 }] }, 'plan.vlans[0].vlanId must be a whole number of 0 or more, or text.'],
    [{ vlans: [{ id: 'v1', ipv4: { fixed: 'yes' } }] }, 'plan.vlans[0].ipv4.fixed must be true or false.'],
    [{ vlans: [{ id: 'v1', ipv6: { prefixes: [1] } }] }, 'plan.vlans[0].ipv6.prefixes[0] must be text.'],
    [{ vlans: [{ id: 'v1' }, { id: 'v1' }] }, 'plan.vlans[1].id "v1" is used twice.'],
    [{ vlans: [{ id: 'has space' }] }, 'plan.vlans[0].id must be 1 to 64 letters, digits, dots, colons, hyphens or underscores.'],
    [{ vlans: [{}] }, 'plan.vlans[0].id must be 1 to 64 letters, digits, dots, colons, hyphens or underscores.'],
    [{ vlans: [null] }, 'plan.vlans[0] must be an object.'],
    [{ sites: [{ id: 's1', blocks: [{ id: 'b1', reserved: [{ range: 7 }] }] }] }, 'plan.sites[0].blocks[0].reserved[0].range must be text.'],
    [{ sites: [{ id: 's1', blocks: [{ id: 'b1' }] }, { id: 's2', blocks: [{ id: 'b1' }] }] }, 'plan.sites[1].blocks[0].id "b1" is used twice.'],
    [{ name: 'x'.repeat(501) }, 'plan.name is longer than 500 characters.'],
    [{ vlans: [{ id: 'v1', ipv4: { dhcp: Array(LIMITS.entriesPerList + 1).fill('x') } }] }, `plan.vlans[0].ipv4.dhcp has ${LIMITS.entriesPerList + 1} entries; the limit is ${LIMITS.entriesPerList}.`],
  ])('reports the damaged field: %j', (plan, text) => {
    expect(message(file(plan))).toBe(`The plan file is damaged or was edited incorrectly: ${text}`);
  });

  it('opens content problems so validation can show them, and fills missing optional fields', () => {
    const r = parsePlanJson(file({ vlans: [{ id: 'v1', vlanId: 99999, siteId: 'nowhere', ipv4: { network: 'not a network' } }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value.plan.vlans[0];
    expect([v.vlanId, v.name, v.ipv4.gateway, v.ipv4.dhcp, v.ipv4.fixed, v.ipv6.prefixes, v.reserved]).toEqual(['99999', '', '', [], false, [], []]);
    expect(errorCodes(validatePlan(r.value.plan), 'v1')).toEqual(['ipv4-network-invalid', 'namespace-missing', 'site-missing', 'vlan-id-range', 'vrf-missing']);
  });

  it('leaves out unknown fields with a warning, including __proto__', () => {
    const text = '{"format":"netforge-plan","version":1,"extra":1,"plan":{"__proto__":{"polluted":true},"vlans":[{"id":"v1","color":"red"}]}}';
    const r = parsePlanJson(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.warnings).toEqual(['file.extra is not part of the plan format and was left out.', 'plan.__proto__ is not part of the plan format and was left out.', 'plan.vlans[0].color is not part of the plan format and was left out.']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.value.plan)).toBe(Object.prototype);
  });

  it('caps the unknown-field warnings', () => {
    const vlans = Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, x: 1 }));
    const r = parsePlanJson(file({ vlans }));
    expect(r.ok && r.value.warnings.length).toBe(21);
    expect(r.ok && r.value.warnings[20]).toBe('10 more unrecognized fields were left out.');
  });
});

// ---- CSV ---------------------------------------------------------------------------------------------

describe('CSV export', () => {
  it('writes one row per VLAN with names, networks and counts', () => {
    const plan = examplePlan();
    const rows = vlanCsv(plan, validatePlan(plan)).split('\r\n');
    expect(rows[0]).toBe(VLAN_CSV_COLUMNS.join(','));
    expect(rows[1]).toBe('Headquarters,HQ switches,10,Users,Global,10.10.10.0/24,255.255.255.0,10.10.10.1,254,200,10.10.10.100 - 10.10.10.250,10.10.10.2 - 10.10.10.20 (Printers and access points),no,2001:db8:10:10::/64,fe80::1,no,,,0,0');
    expect(rows[3]).toBe('Headquarters,HQ switches,30,Servers,Global,10.10.30.0/25,255.255.255.128,10.10.30.1,126,60,,10.10.30.2 - 10.10.30.9 (Hypervisor hosts),yes,2001:db8:10:30::/64,2001:db8:10:30::1,yes,Static addressing only.,,0,0');
    expect(rows).toHaveLength(plan.vlans.length + 2);
    expect(rows[rows.length - 1]).toBe('');
  });

  it('guards text cells against spreadsheet formulas and quotes separators', () => {
    const plan = makePlan([{ name: '=HYPERLINK("x")', description: 'a, b', ipv6: { prefixes: ['2001:db8::/64', '2001:db8:0:1::/64'] } }]);
    const row = vlanCsv(plan, validatePlan(plan)).split('\r\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"a, b"');
    expect(row).toContain('2001:db8::/64; 2001:db8:0:1::/64');
  });

  it('exports findings with their scope', () => {
    const plan = makePlan([{ ipv4: { network: '10.0.0.0/24' } }, { ipv4: { network: '10.0.0.0/24' } }]);
    const v = validatePlan(plan);
    const lines = issuesCsv(v.issues, i => i.target.id).split('\r\n');
    expect(lines[0]).toBe('Severity,Code,Where,Field,Entry,Message,Routing-domain scope');
    expect(lines[1]).toBe('error,duplicate-network,v1,ipv4.network,,"10.0.0.0/24 is also assigned to VLAN 20 VLAN v2 at Site one, in VRF ""Global"".","VRF ""Global"""');
  });
});

// ---- Performance -------------------------------------------------------------------------------------

describe('performance at enterprise scale', () => {
  for (const n of [100, 500, 1000]) {
    it(`validates ${n} VLANs quickly and finds the plan clean`, () => {
      const plan = syntheticPlan(n);
      validatePlan(plan); // warm-up
      const runs = 5;
      const start = performance.now();
      let v: PlanValidation | null = null;
      for (let i = 0; i < runs; i++) v = validatePlan(plan);
      const ms = (performance.now() - start) / runs;
      console.log(`validate ${n} VLANs: ${ms.toFixed(1)} ms`);
      expect(v!.counts.error).toBe(0);
      expect(v!.counts.warning).toBe(0);
      expect(ms).toBeLessThan(n * 1.5);
    });
  }

  it('stays fast when every network overlaps every other', () => {
    const plan = makePlan(Array.from({ length: 1000 }, (_, i) => ({ vlanId: String((i % 4000) + 2), namespaceId: 'n1', ipv4: { network: '10.0.0.0/16' } })));
    const start = performance.now();
    const v = validatePlan(plan);
    const ms = performance.now() - start;
    console.log(`validate 1000 identical networks: ${ms.toFixed(1)} ms`);
    expect(v.forTarget('vlan', 'v1').filter(i => i.code === 'duplicate-network')).toHaveLength(OVERLAPS_LISTED);
    expect(ms).toBeLessThan(5000);
  });

  it('allocates 1,000 VLANs of IPv4 and IPv6 in one run', () => {
    const plan = makePlan(Array.from({ length: 1000 }, (_, i) => ({ vlanId: String(i + 2), hosts: String(10 + (i % 200)) })));
    const v = validatePlan(plan);
    let start = performance.now();
    const pv4 = previewAllocation(plan, v, { family: 4, siteId: 's1', vrfId: 'r1', parents: ['10.0.0.0/8'], reallocate: false, setGateway: true });
    const ms4 = performance.now() - start;
    start = performance.now();
    const pv6 = previewAllocation(plan, v, { family: 6, siteId: 's1', vrfId: 'r1', parents: ['2001:db8::/48'], reallocate: false, childLength: 64, perVlan: 1 });
    const ms6 = performance.now() - start;
    console.log(`allocate 1000 VLANs: IPv4 ${ms4.toFixed(1)} ms, IPv6 ${ms6.toFixed(1)} ms`);
    expect(pv4.changes).toHaveLength(1000);
    expect(pv6.changes).toHaveLength(1000);
    const step = applyAllocation(plan, pv4, false);
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    // The IPv6 preview was made from the same plan, and IPv4 allocation does not touch IPv6 fields.
    const applied = applyAllocation(step.value, pv6, false);
    expect(applied.ok && validatePlan(applied.value).counts.error).toBe(0);
    expect(ms4 + ms6).toBeLessThan(10_000);
  });
});
