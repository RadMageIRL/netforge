/**
 * The shared export core: the exact / approximate / unsupported account (model.ts), reading a plan
 * for export (source.ts) and the checks on typed values and plan text (text.ts). Expected values
 * are worked out by hand.
 */
import { describe, expect, it } from 'vitest';
import { accountText, countItems, FIDELITY_LABEL, ItemBuilder, output, refused } from '../../src/core/infra/model';
import {
  cidr, describeScope, ERRORS_LISTED, inScope, ip4, ip6, mask4, overlappingNetworks, planErrors, resolvePlan, scopedVlans, scopeProblem,
  usable4, vlanLabel, WHOLE_PLAN, type ResolvedPlan,
} from '../../src/core/infra/source';
import {
  checkComputerName, checkDnsName, CONTROL, hasControl, isPrintableAscii, macWithDashes, MAX_DNS_SERVERS, nameToken, parseDnsServers, parseMac, slug,
} from '../../src/core/infra/text';
import { parsePrefixText } from '../../src/core/net/address';
import { examplePlan } from '../../src/core/plan/example';
import type { Plan } from '../../src/core/plan/model';
import { validatePlan } from '../../src/core/plan/validate';
import { makePlan, makeVlan, syntheticPlan } from '../plan-helpers';

const C = (code: number) => String.fromCharCode(code);
const P = (text: string) => {
  const p = parsePrefixText(text);
  if (!p.ok) throw new Error(text);
  return p.value.prefix;
};
const resolved = (plan: Plan): ResolvedPlan => {
  const r = resolvePlan(plan);
  if (!r.ok) throw new Error(r.refusals.join(' | '));
  return r.value;
};

describe('ItemBuilder fidelity', () => {
  it('is unsupported when nothing was written, whatever the notes', () => {
    expect(new ItemBuilder('a').build().fidelity).toBe('unsupported');
    expect(new ItemBuilder('a').unsupported('f', 'd').build().fidelity).toBe('unsupported');
    expect(new ItemBuilder('a').approximate('f', 'd').build().fidelity).toBe('unsupported');
    expect(new ItemBuilder('a').remark('r').build().fidelity).toBe('unsupported');
  });

  it('is exact when something was written and nothing was noted', () => {
    const item = new ItemBuilder('VLAN 10').wrote('scope').wrote('router').build();
    expect(item).toEqual({ subject: 'VLAN 10', fidelity: 'exact', written: ['scope', 'router'], notes: [], remarks: [] });
  });

  it('is approximate when something was written and any field has a note', () => {
    expect(new ItemBuilder('a').wrote('x').approximate('Name', 'changed').build().fidelity).toBe('approximate');
    expect(new ItemBuilder('a').wrote('x').unsupported('IPv6', 'left out').build().fidelity).toBe('approximate');
  });

  it('keeps remarks apart from fidelity', () => {
    const item = new ItemBuilder('a').wrote('x').remark('worth knowing').build();
    expect(item.fidelity).toBe('exact');
    expect(item.remarks).toEqual(['worth knowing']);
  });

  it('records each note with its own label and reports wroteAnything', () => {
    const b = new ItemBuilder('a');
    expect(b.wroteAnything).toBe(false);
    b.wrote('x').approximate('A', 'one').unsupported('B', 'two');
    expect(b.wroteAnything).toBe(true);
    expect(b.build().notes).toEqual([{ fidelity: 'approximate', field: 'A', detail: 'one' }, { fidelity: 'unsupported', field: 'B', detail: 'two' }]);
  });

  it('returns copies, so a built item does not change afterward', () => {
    const b = new ItemBuilder('a').wrote('x');
    const first = b.build();
    b.wrote('y').unsupported('f', 'd');
    expect(first.written).toEqual(['x']);
    expect(first.notes).toEqual([]);
  });
});

describe('output, refused and counts', () => {
  const items = [
    new ItemBuilder('e1').wrote('x').build(),
    new ItemBuilder('e2').wrote('x').build(),
    new ItemBuilder('a1').wrote('x').approximate('f', 'd').build(),
    new ItemBuilder('u1').unsupported('f', 'd').build(),
  ];

  it('counts items by fidelity', () => {
    expect(countItems(items)).toEqual({ exact: 2, approximate: 1, unsupported: 1 });
    expect(countItems([])).toEqual({ exact: 0, approximate: 0, unsupported: 0 });
  });

  it('builds a ready output with empty defaults', () => {
    const o = output({ items });
    expect(o.ok).toBe(true);
    expect(o.refusals).toEqual([]);
    expect(o.counts).toEqual({ exact: 2, approximate: 1, unsupported: 1 });
    expect([o.files, o.skipped, o.assumptions, o.manualSteps, o.notCovered, o.privileges]).toEqual([[], [], [], [], [], []]);
  });

  it('builds a refusal with no files and no privileges, keeping the account', () => {
    const o = refused(['why'], { items, skipped: [{ subject: 's', reason: 'r' }], notCovered: ['n'], privileges: ['admin'], files: [{ name: 'f', kind: 'k', mime: 'm', text: 't' }] });
    expect(o.ok).toBe(false);
    expect(o.refusals).toEqual(['why']);
    expect(o.files).toEqual([]);
    expect(o.privileges).toEqual([]);
    expect(o.counts.unsupported).toBe(1);
    expect(o.skipped).toHaveLength(1);
    expect(o.notCovered).toEqual(['n']);
  });

  it('has a label for each fidelity', () => {
    expect(FIDELITY_LABEL).toEqual({ exact: 'Exact', approximate: 'Approximate', unsupported: 'Unsupported' });
  });
});

describe('accountText', () => {
  it('lists every item with its label, its notes and remarks, and every section', () => {
    const text = accountText('Title', output({
      items: [
        new ItemBuilder('VLAN 10').wrote('scope').wrote('router').build(),
        new ItemBuilder('VLAN 20').wrote('scope').approximate('Name', 'renamed').unsupported('IPv6', 'no pools').remark('a remark').build(),
        new ItemBuilder('VLAN 30').unsupported('Scope', 'overlaps').build(),
      ],
      skipped: [{ subject: 'VLAN 40', reason: 'no pool.' }],
      assumptions: ['assume'], manualSteps: ['do this'], notCovered: ['never'], privileges: ['admin needed'],
    }));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Title');
    expect(lines).toContain('Items: 1 exact, 1 approximate, 1 unsupported');
    expect(lines).toContain('- [Exact] VLAN 10: scope; router');
    expect(lines).toContain('- [Approximate] VLAN 20: scope');
    expect(lines).toContain('  - [Approximate] Name: renamed');
    expect(lines).toContain('  - [Unsupported] IPv6: no pools');
    expect(lines).toContain('  - a remark');
    expect(lines).toContain('- [Unsupported] VLAN 30');
    expect(lines).toContain('  - [Unsupported] Scope: overlaps');
    expect(lines).toContain('- VLAN 40: no pool.');
    for (const heading of ['Privileges', 'Assumptions', 'Manual steps', 'Not covered by this export']) expect(lines).toContain(heading);
    expect(lines).toContain('- admin needed');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('says that nothing was generated for a refusal, and leaves out empty sections', () => {
    const text = accountText('T', refused(['the plan has errors']));
    expect(text).toContain('Nothing was generated\n- the plan has errors');
    expect(text).not.toContain('Assumptions');
    expect(text).not.toContain('Items:');
    expect(accountText('T', output({ items: [new ItemBuilder('a').wrote('x').build()] }))).not.toContain('Nothing was generated');
  });
});

describe('resolvePlan', () => {
  it('reads the example plan: numbers, networks, gateways, pools and reserved ranges', () => {
    const r = resolved(examplePlan());
    expect(r.vlans).toHaveLength(10);
    const users = r.vlans.find(v => v.vlan.id === 'v1')!;
    expect(users.label).toBe('VLAN 10 Users');
    expect(users.number).toBe(10);
    expect(cidr(users.net4!)).toBe('10.10.10.0/24');
    expect(ip4(users.gateway4!)).toBe('10.10.10.1');
    expect(users.pools.map(p => `${ip4(p.first)}-${ip4(p.last)}`)).toEqual(['10.10.10.100-10.10.10.250']);
    expect(users.reserved4.map(x => [ip4(x.range.first), ip4(x.range.last), x.label])).toEqual([['10.10.10.2', '10.10.10.20', 'Printers and access points']]);
    expect(users.net6.map(cidr)).toEqual(['2001:db8:10:10::/64']);
    expect(users.gateway6).toMatchObject({ linkLocal: true, home: null });
    expect(users.site?.name).toBe('Headquarters');
    expect(users.vrf?.id).toBe('r1');
    expect(users.namespace?.id).toBe('n1');
    const servers = r.vlans.find(v => v.vlan.id === 'v3')!;
    expect(servers.gateway6?.linkLocal).toBe(false);
    expect(cidr(servers.gateway6!.home!)).toBe('2001:db8:10:30::/64');
    expect(ip6(servers.gateway6!.value)).toBe('2001:db8:10:30::1');
    const cameras = r.vlans.find(v => v.vlan.id === 'v5')!;
    expect([cameras.net4, cameras.gateway4, cameras.gateway6]).toEqual([null, null, null]);
    expect(cameras.pools).toEqual([]);
  });

  it('merges overlapping-free adjacent pools and sorts them', () => {
    const r = resolved(makePlan([{ ipv4: { network: '10.0.0.0/24', gateway: '10.0.0.1', dhcp: ['10.0.0.200 - 10.0.0.210', '10.0.0.10 - 10.0.0.20', '10.0.0.21 - 10.0.0.30', '10.0.0.64/28'] } }]));
    expect(r.vlans[0]!.pools.map(p => `${ip4(p.first)}-${ip4(p.last)}`)).toEqual(['10.0.0.10-10.0.0.30', '10.0.0.64-10.0.0.79', '10.0.0.200-10.0.0.210']);
  });

  it('tells link-local gateways from the range fe80::/10 only', () => {
    const gw = (g: string) => resolved(makePlan([{ ipv6: { prefixes: ['2001:db8::/64'], gateway: g } }])).vlans[0]!.gateway6!;
    expect(gw('fe80::1').linkLocal).toBe(true);
    expect(gw('febf:ffff::1').linkLocal).toBe(true);
    expect(gw('2001:db8::1').linkLocal).toBe(false);
    expect(cidr(gw('2001:db8::1').home!)).toBe('2001:db8::/64');
  });

  it('refuses a plan with errors, naming where each is', () => {
    const plan = makePlan([
      { vlanId: '10', name: 'A', ipv4: { network: '10.0.0.0/24', gateway: '10.0.1.1' } },
      { vlanId: '10', name: 'B' },
    ]);
    const r = resolvePlan(plan);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const errors = validatePlan(plan).issues.filter(i => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(r.refusals).toHaveLength(errors.length + 1);
    expect(r.refusals[0]).toContain(`${errors.length} errors`);
    expect(r.refusals.slice(1).some(l => l.startsWith('VLAN 10 A: '))).toBe(true);
  });

  it('says "1 error" for a single error', () => {
    const r = resolvePlan(makePlan([{ ipv4: { network: '10.0.0.0/24', gateway: '10.9.9.9' } }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]).toMatch(/^The plan has 1 error\. Fix it /);
  });

  it(`lists at most ${ERRORS_LISTED} errors and counts the rest`, () => {
    const plan = makePlan(Array.from({ length: ERRORS_LISTED + 7 }, (_, i) => ({ id: `v${i + 1}`, vlanId: String(i + 2), ipv4: { network: `10.0.${i}.0/24`, gateway: '192.0.2.1' } })));
    const total = validatePlan(plan).counts.error;
    expect(total).toBe(ERRORS_LISTED + 7);
    const r = resolvePlan(plan);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals).toHaveLength(ERRORS_LISTED + 2);
    expect(r.refusals[r.refusals.length - 1]).toBe('And 7 more.');
    expect(planErrors(plan, validatePlan(plan))).toEqual(r.refusals);
  });

  it(`adds no "more" line at exactly ${ERRORS_LISTED} errors`, () => {
    const plan = makePlan(Array.from({ length: ERRORS_LISTED }, (_, i) => ({ id: `v${i + 1}`, vlanId: String(i + 2), ipv4: { network: `10.0.${i}.0/24`, gateway: '192.0.2.1' } })));
    const r = resolvePlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toHaveLength(ERRORS_LISTED + 1);
  });

  it('exports a plan that has only warnings and notes', () => {
    const plan = makePlan([{ ipv4: { network: '10.0.0.0/31' } }]);
    const v = validatePlan(plan);
    expect(v.counts.error).toBe(0);
    expect(v.counts.warning).toBeGreaterThan(0);
    expect(planErrors(plan, v)).toBeNull();
    expect(resolvePlan(plan).ok).toBe(true);
  });

  it('refuses a plan without VLANs', () => {
    const r = resolvePlan(makePlan([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals).toHaveLength(1);
  });
});

describe('labels', () => {
  it('labels a VLAN by ID and name, saying when either is missing', () => {
    expect(vlanLabel(makeVlan('v1', { vlanId: ' 10 ', name: ' Users ' }))).toBe('VLAN 10 Users');
    expect(vlanLabel(makeVlan('v1', { vlanId: '10', name: '' }))).toBe('VLAN 10');
    expect(vlanLabel(makeVlan('v1', { vlanId: '', name: 'Users' }))).toBe('VLAN Users (no ID)');
    expect(vlanLabel(makeVlan('v1', { vlanId: '', name: ' ' }))).toBe('Unnamed VLAN (no ID)');
  });

  it('describes a scope', () => {
    const plan = examplePlan();
    expect(describeScope(plan, WHOLE_PLAN)).toBe('all sites, all VRFs');
    expect(describeScope(plan, { siteId: 's1', vrfId: 'r2', namespaceId: 'n1' })).toBe('site Headquarters, VRF Guest HQ, VLAN namespace HQ switches');
  });
});

describe('scope', () => {
  const r = resolved(examplePlan());
  const ids = (scope: { siteId: string; vrfId: string; namespaceId: string }) => scopedVlans(r, scope).map(v => v.vlan.id);

  it('filters by site, VRF and namespace, each alone and together', () => {
    expect(ids(WHOLE_PLAN)).toHaveLength(10);
    expect(ids({ siteId: 's1', vrfId: '', namespaceId: '' }).sort()).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(ids({ siteId: '', vrfId: 'r1', namespaceId: '' }).sort()).toEqual(['v1', 'v10', 'v2', 'v3', 'v4', 'v5', 'v7', 'v8']);
    expect(ids({ siteId: '', vrfId: '', namespaceId: 'n2' }).sort()).toEqual(['v10', 'v7', 'v8', 'v9']);
    expect(ids({ siteId: 's2', vrfId: 'r1', namespaceId: 'n2' }).sort()).toEqual(['v10', 'v7', 'v8']);
    expect(ids({ siteId: 's1', vrfId: 'r3', namespaceId: '' })).toEqual([]);
    expect(ids({ siteId: 's1', vrfId: 'r1', namespaceId: 'n2' })).toEqual([]);
  });

  it('agrees with inScope for every VLAN', () => {
    const scope = { siteId: 's2', vrfId: '', namespaceId: '' };
    expect(r.vlans.filter(v => inScope(v, scope)).map(v => v.vlan.siteId)).toEqual(['s2', 's2', 's2', 's2']);
  });

  it('orders by VLAN ID, VLANs without an ID last, then name, then plan order', () => {
    const plan = makePlan([
      { id: 'a', vlanId: '300', name: 'c' }, { id: 'b', vlanId: '4000', name: '' }, { id: 'c', vlanId: '20', name: 'b' },
      { id: 'd', vlanId: '4001', name: '' }, { id: 'e', vlanId: '4094', name: 'x' }, { id: 'f', vlanId: '7', name: 'y' },
    ], { namespaces: [{ id: 'n1', name: 'one', siteId: 's1', description: '' }, { id: 'n2', name: 'two', siteId: 's1', description: '' }] });
    plan.vlans.push(makeVlan('g', { vlanId: '20', name: 'a', namespaceId: 'n2' }), makeVlan('h', { vlanId: '20', name: 'a', namespaceId: 'n2' }));
    plan.vlans[7]!.vlanId = '21';
    plan.vlans.push(makeVlan('i', { vlanId: '300', name: 'c', namespaceId: 'n2' }));
    // Validation requires a VLAN ID, so a VLAN without a number cannot come out of resolvePlan;
    // the ordering rule for it is checked on a hand-made copy.
    const r0 = resolved(plan);
    const noId = new Set(['b', 'd']);
    const r1: ResolvedPlan = { ...r0, vlans: r0.vlans.map(v => (noId.has(v.vlan.id) ? { ...v, number: null } : v)) };
    expect(scopedVlans(r1, WHOLE_PLAN).map(v => v.vlan.id)).toEqual(['f', 'g', 'c', 'h', 'a', 'i', 'e', 'b', 'd']);
    expect(scopedVlans(r0, WHOLE_PLAN).map(v => v.vlan.id)).toEqual(['f', 'g', 'c', 'h', 'a', 'i', 'b', 'd', 'e']);
  });

  it('reports a site, VRF or namespace the plan does not have', () => {
    const plan = examplePlan();
    expect(scopeProblem(plan, WHOLE_PLAN)).toBeNull();
    expect(scopeProblem(plan, { siteId: 's1', vrfId: 'r1', namespaceId: 'n1' })).toBeNull();
    expect(scopeProblem(plan, { siteId: 'nope', vrfId: '', namespaceId: '' })).toContain('site');
    expect(scopeProblem(plan, { siteId: '', vrfId: 'nope', namespaceId: '' })).toContain('VRF');
    expect(scopeProblem(plan, { siteId: '', vrfId: '', namespaceId: 'nope' })).toContain('namespace');
  });
});

describe('address helpers', () => {
  it('writes dotted masks for every length', () => {
    expect(mask4(0)).toBe('0.0.0.0');
    expect(mask4(1)).toBe('128.0.0.0');
    expect(mask4(8)).toBe('255.0.0.0');
    expect(mask4(20)).toBe('255.255.240.0');
    expect(mask4(24)).toBe('255.255.255.0');
    expect(mask4(25)).toBe('255.255.255.128');
    expect(mask4(30)).toBe('255.255.255.252');
    expect(mask4(31)).toBe('255.255.255.254');
    expect(mask4(32)).toBe('255.255.255.255');
    for (let n = 0; n <= 32; n++) {
      const bits = mask4(n).split('.').map(o => Number(o).toString(2).padStart(8, '0')).join('');
      expect(bits).toBe('1'.repeat(n) + '0'.repeat(32 - n));
    }
  });

  it('gives the host range without the network and broadcast addresses', () => {
    const u = (text: string) => { const r = usable4(P(text)); return r ? `${ip4(r.first)}-${ip4(r.last)}` : null; };
    expect(u('10.0.0.0/24')).toBe('10.0.0.1-10.0.0.254');
    expect(u('10.0.0.8/30')).toBe('10.0.0.9-10.0.0.10');
    expect(u('10.0.0.8/29')).toBe('10.0.0.9-10.0.0.14');
    expect(u('10.0.0.0/8')).toBe('10.0.0.1-10.255.255.254');
    expect(u('10.0.0.8/31')).toBeNull();
    expect(u('10.0.0.8/32')).toBeNull();
  });

  it('finds VLANs whose IPv4 networks overlap, in both directions', () => {
    const plan = makePlan([
      { id: 'a', vlanId: '1', vrfId: 'r1', ipv4: { network: '10.0.0.0/16' } },
      { id: 'b', vlanId: '2', vrfId: 'r2', ipv4: { network: '10.0.1.0/24' } },
      { id: 'c', vlanId: '3', vrfId: 'r3', ipv4: { network: '10.0.200.0/24' } },
      { id: 'd', vlanId: '4', vrfId: 'r1', ipv4: { network: '10.1.0.0/24' } },
      { id: 'e', vlanId: '5', vrfId: 'r1' },
      { id: 'f', vlanId: '6', vrfId: 'r2', ipv4: { network: '10.1.0.0/24' } },
    ], { vrfs: ['r1', 'r2', 'r3'].map(id => ({ id, name: id, siteId: '', exchangesWith: [], description: '', notes: '' })) });
    const clashes = overlappingNetworks(resolved(plan).vlans);
    const of = (id: string) => (clashes.get(id) ?? []).map(v => v.vlan.id).sort();
    expect(of('a')).toEqual(['b', 'c']);
    expect(of('b')).toEqual(['a']);
    expect(of('c')).toEqual(['a']);
    expect(of('d')).toEqual(['f']);
    expect(of('f')).toEqual(['d']);
    expect(clashes.has('e')).toBe(false);
    expect(overlappingNetworks(resolved(syntheticPlan(50)).vlans).size).toBe(0);
  });

  it('does not call adjacent networks overlapping', () => {
    const plan = makePlan([{ id: 'a', vlanId: '1', ipv4: { network: '10.0.0.0/24' } }, { id: 'b', vlanId: '2', ipv4: { network: '10.0.1.0/24' } }]);
    expect(overlappingNetworks(resolved(plan).vlans).size).toBe(0);
  });
});

describe('typed values', () => {
  it('finds control characters, C1 controls and Unicode line separators', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029]) {
      expect(hasControl(`a${C(code)}b`)).toBe(true);
      expect(CONTROL.test(C(code))).toBe(true);
    }
    for (const code of [0x20, 0x7e, 0xa0, 0xe9, 0x2027, 0x202a, 0x3000]) expect(hasControl(`a${C(code)}b`)).toBe(false);
    expect(hasControl('')).toBe(false);
  });

  it('knows printable ASCII', () => {
    expect(isPrintableAscii('')).toBe(true);
    expect(isPrintableAscii(' ~Az09!')).toBe(true);
    for (const code of [0x1f, 0x7f, 0x0a, 0xe9, 0x2028]) expect(isPrintableAscii(`a${C(code)}`)).toBe(false);
  });

  it('parses DNS server lists into canonical, distinct IPv4 addresses', () => {
    expect(parseDnsServers('')).toEqual({ ok: true, values: [] });
    expect(parseDnsServers('  ,  ')).toEqual({ ok: true, values: [] });
    expect(parseDnsServers('10.0.0.1')).toEqual({ ok: true, values: ['10.0.0.1'] });
    expect(parseDnsServers(' 10.0.0.1, 10.0.0.2\t10.0.0.3\n10.0.0.4 ')).toEqual({ ok: true, values: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'] });
    for (const bad of ['10.0.0', '10.0.0.256', 'dns.example', '2001:db8::1', '10.0.0.1;calc', "10.0.0.1'", '10.0.0.1 -Force', '$(x)', '010.0.0.1']) {
      expect(parseDnsServers(bad).ok).toBe(false);
    }
    expect(parseDnsServers('10.0.0.1, 10.0.0.1').ok).toBe(false);
  });

  it(`accepts at most ${MAX_DNS_SERVERS} DNS servers`, () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `10.0.0.${i + 1}`).join(', ');
    expect(parseDnsServers(list(MAX_DNS_SERVERS))).toMatchObject({ ok: true });
    expect(parseDnsServers(list(MAX_DNS_SERVERS + 1)).ok).toBe(false);
  });

  it('checks DNS names label by label', () => {
    for (const good of ['corp', 'corp.example', 'a.b.c', 'x-y.example', 'a1.2b', `${'a'.repeat(63)}.example`]) expect(checkDnsName(good)).toBeNull();
    for (const bad of ['', '.', 'corp.', '.corp', 'a..b', '-a.example', 'a-.example', 'a b', 'a_b', "a'b", 'a;b', 'a$b', `a${C(0x0a)}b`, `${'a'.repeat(64)}.example`, `caf${C(0xe9)}.example`]) {
      expect(checkDnsName(bad)).not.toBeNull();
    }
    const long = Array.from({ length: 64 }, () => 'abc').join('.');
    expect(long.length).toBe(255);
    expect(checkDnsName(long)).not.toBeNull();
    expect(checkDnsName(long.slice(0, 253))).toBeNull();
  });

  it('accepts a DNS name or an IPv4 address as a computer name', () => {
    for (const good of ['dhcp01', 'dhcp01.corp.example', '10.0.0.5']) expect(checkComputerName(good)).toBeNull();
    for (const bad of ["dhcp'01", 'dhcp 01', 'dhcp01;', '$(hostname)', '`whoami`', 'a"b', '2001:db8::1', '']) expect(checkComputerName(bad)).not.toBeNull();
  });

  it('reads a MAC address in every common spelling', () => {
    for (const text of ['00-11-22-AA-BB-CC', '00:11:22:aa:bb:cc', '001122AABBCC', '0011.22aa.bbcc', ' 00-11-22-aa-bb-cc ']) expect(parseMac(text)).toBe('001122aabbcc');
    expect(macWithDashes('001122aabbcc')).toBe('00-11-22-aa-bb-cc');
  });

  it('rejects anything that is not six bytes in one spelling', () => {
    for (const bad of [
      '', '00-11-22-AA-BB', '00-11-22-AA-BB-CC-DD', '00-11-22-AA-BB-CG', '00:11-22:aa-bb:cc', '00-11:22-aa-bb-cc', '0011.22aa.bbc', '0011-22aa-bbcc',
      '00 11 22 aa bb cc', '001122AABBC', '001122AABBCCD', '00-11-22-aa-bb-cc;', "00-11-22-aa-bb-cc'", '00:11:22:aa:bbcc', '0-11-22-aa-bb-cc0',
    ]) expect(parseMac(bad)).toBeNull();
  });

  it('turns plan names into one-word device names: exact, approximate or refused', () => {
    const word = /^[A-Za-z0-9_.-]+$/;
    expect(nameToken('Users', word, 32, '_')).toEqual({ kind: 'exact', value: 'Users' });
    expect(nameToken('a'.repeat(32), word, 32, '_')).toEqual({ kind: 'exact', value: 'a'.repeat(32) });
    expect(nameToken('Guest  WiFi 2', word, 32, '_')).toMatchObject({ kind: 'approximate', value: 'Guest_WiFi_2' });
    expect(nameToken('Guest WiFi', word, 32, '-')).toMatchObject({ kind: 'approximate', value: 'Guest-WiFi' });
    expect(nameToken('', word, 32, '_').kind).toBe('refused');
    expect(nameToken('a'.repeat(33), word, 32, '_').kind).toBe('refused');
    expect(nameToken(`${'a'.repeat(20)} ${'b'.repeat(20)}`, word, 32, '_').kind).toBe('refused');
    for (const bad of ['a?b', 'a/b', `caf${C(0xe9)}`, `a${C(0x0a)}b`, 'a\tb', 'a;b', 'a"b', 'a b?']) expect(nameToken(bad, word, 32, '_').kind).toBe('refused');
  });

  it('never returns a token that fails the pattern or the length', () => {
    const word = /^[A-Za-z][A-Za-z0-9_-]*$/;
    for (const name of ['x', 'x y', ' x', '1x', '1 x', 'x-y_z', 'x  y   z', 'x.y', `x${C(0x2028)}y`, 'a'.repeat(64), `${'a'.repeat(63)} b`]) {
      const t = nameToken(name, word, 64, '-');
      if (t.kind !== 'refused') {
        expect(word.test(t.value)).toBe(true);
        expect(t.value.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('makes lowercase slugs of letters, digits and underscores', () => {
    expect(slug('Headquarters Global')).toBe('headquarters_global');
    expect(slug('  --Guest/HQ (2)--  ')).toBe('guest_hq_2');
    expect(slug(`caf${C(0xe9)} "x"; rm -rf`)).toBe('caf_x_rm_rf');
    expect(slug('')).toBe('');
    expect(slug('???')).toBe('');
    expect(slug('abcdef ghij', 7)).toBe('abcdef');
    expect(slug('a'.repeat(100))).toHaveLength(40);
    for (const s of ['${x}', 'a"b', `a${C(0x0a)}b`, 'A.B']) expect(slug(s)).toMatch(/^[a-z0-9_]*$/);
  });
});
