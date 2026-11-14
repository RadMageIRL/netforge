/**
 * Cisco IOS / IOS-XE export. Every generated text is read by the strict line grammar in
 * helpers/device-grammar.ts (documented syntax, not a device), and the model it reads back is
 * compared with the plan. Assertions are on structure, labels and fields, not on wording.
 */
import { describe, expect, it } from 'vitest';
import { GLOBAL_NONE, GLOBAL_UNSET, type DeviceContext } from '../../src/core/infra/devices';
import { iosConfig, type IosOptions, type IosSections } from '../../src/core/infra/ios';
import type { ExportItem, ExportOutput } from '../../src/core/infra/model';
import type { Plan } from '../../src/core/plan/model';
import { makePlan, type VlanSpec } from '../plan-helpers';
import { forbiddenLines, iosLeasable, parseIos, parseV4, parseV6 } from './helpers/device-grammar';

const ch = (code: number) => String.fromCharCode(code);
const WHOLE = { siteId: '', vrfId: '', namespaceId: '' };
const ALL: IosSections = { vlans: true, svis: true, dhcp: true };
const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({ scope: WHOLE, globalVrfId: 'r1', vrfNames: {}, ...over });
const run = (plan: Plan, over: Partial<IosOptions> = {}): ExportOutput => iosConfig(plan, { context: ctx(), sections: ALL, dnsServers: '', dnsDomain: '', ...over });
const text = (o: ExportOutput): string => o.files[0]!.text;
const body = (o: ExportOutput): string[] => text(o).split('\n').filter(l => l !== '' && !l.startsWith('!'));
const item = (o: ExportOutput, subject: string): ExportItem => {
  const found = o.items.find(i => i.subject === subject);
  if (!found) throw new Error(`no item ${subject}: ${o.items.map(i => i.subject).join(' | ')}`);
  return found;
};
const notes = (i: ExportItem) => i.notes.map(n => `${n.fidelity}:${n.field}`);
const ip = (t: string) => parseV4(t)!;

const TWO_VRFS: Partial<Plan> = {
  vrfs: [
    { id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: '', notes: '' },
    { id: 'r2', name: 'Guest net', siteId: '', exchangesWith: [], description: '', notes: '' },
  ],
};
const TWO_NAMESPACES: Partial<Plan> = {
  namespaces: [
    { id: 'n1', name: 'Core switches', siteId: 's1', description: '' },
    { id: 'n2', name: 'Lab switches', siteId: 's1', description: '' },
  ],
};
const users: VlanSpec = { vlanId: '10', name: 'Users', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1', dhcp: ['10.0.10.100 - 10.0.10.200'] } };

describe('refusals', () => {
  it('refuses a plan with errors and writes no file', () => {
    const o = run(makePlan([users, { ...users, name: 'Twin' }]));
    expect(o.ok).toBe(false);
    expect(o.files).toEqual([]);
    expect(o.refusals.length).toBeGreaterThan(1);
  });

  it('refuses a scope the plan does not have', () => {
    for (const scope of [{ ...WHOLE, siteId: 'nope' }, { ...WHOLE, vrfId: 'nope' }, { ...WHOLE, namespaceId: 'nope' }]) {
      const o = run(makePlan([users]), { context: ctx({ scope }) });
      expect(o.ok).toBe(false);
      expect(o.refusals).toHaveLength(1);
    }
  });

  it('refuses when no section is chosen', () => {
    const o = run(makePlan([users]), { sections: { vlans: false, svis: false, dhcp: false } });
    expect(o.ok).toBe(false);
    expect(o.refusals).toHaveLength(1);
    expect(o.refusals[0]).toMatch(/section/i);
    expect(o.skipped).toEqual([]);
    expect(o.notCovered.length).toBeGreaterThan(0);
  });

  it('refuses a selection without VLANs', () => {
    const plan = makePlan([users], { sites: [{ id: 's1', name: 'One', description: '', notes: '', blocks: [] }, { id: 's2', name: 'Two', description: '', notes: '', blocks: [] }] });
    expect(run(plan, { context: ctx({ scope: { ...WHOLE, siteId: 's2' } }) }).ok).toBe(false);
  });

  it('validates DNS servers and the domain name only when the DHCP section is on', () => {
    const plan = makePlan([users]);
    for (const bad of ['10.0.0.300', 'ns1.example', '10.0.0.1 10.0.0.1', '1.1.1.1 1.1.1.2 1.1.1.3 1.1.1.4 1.1.1.5 1.1.1.6 1.1.1.7 1.1.1.8 1.1.1.9']) {
      expect(run(plan, { dnsServers: bad }).ok, bad).toBe(false);
      expect(run(plan, { dnsServers: bad, sections: { vlans: true, svis: true, dhcp: false } }).ok, bad).toBe(true);
    }
    for (const bad of ['bad domain', '-x.example', 'a..b', `x${ch(10)}y`, 'x?', 'a_b.example', `${'a'.repeat(64)}.example`]) {
      expect(run(plan, { dnsDomain: bad }).ok, bad).toBe(false);
    }
    const two = run(plan, { dnsServers: 'x', dnsDomain: 'bad domain' });
    expect(two.refusals).toHaveLength(2);
  });

  it('refuses when nothing can be written, and still explains each VLAN', () => {
    const o = run(makePlan([{ vlanId: '1002', name: 'Old' }, { vlanId: '1005', name: 'Older' }]));
    expect(o.ok).toBe(false);
    expect(o.files).toEqual([]);
    expect(o.items.map(i => i.fidelity)).toEqual(['unsupported', 'unsupported']);
    expect(o.counts.unsupported).toBe(2);
  });
});

describe('VLAN declarations', () => {
  it('writes a vlan block with its name', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'Users' }, { vlanId: '20', name: '' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    expect(body(o)).toEqual(['vlan 10', ' name Users', 'vlan 20']);
    const m = parseIos(text(o));
    expect(m.vlans.get(10)).toEqual({ name: 'Users' });
    expect(m.vlans.get(20)).toEqual({ name: null });
    expect(item(o, 'VLAN 10 Users').fidelity).toBe('exact');
    expect(item(o, 'VLAN 20').fidelity).toBe('exact');
  });

  it('orders VLANs by ID', () => {
    const o = run(makePlan([{ vlanId: '300', name: 'c' }, { vlanId: '20', name: 'a' }, { vlanId: '100', name: 'b' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    expect([...parseIos(text(o)).vlans.keys()]).toEqual([20, 100, 300]);
  });

  it('is refused as a whole when a VLAN has no ID, because that is a plan error', () => {
    const o = run(makePlan([{ vlanId: '', name: 'Later', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }, users]));
    expect(o.ok).toBe(false);
    expect(o.files).toEqual([]);
  });

  it('writes nothing for either VLAN when an ID appears in two namespaces of the selection', () => {
    const plan = makePlan([
      { ...users, namespaceId: 'n1' },
      { vlanId: '10', name: 'Lab', namespaceId: 'n2', ipv4: { network: '10.0.50.0/24', gateway: '10.0.50.1' } },
      { vlanId: '20', name: 'Voice', namespaceId: 'n1' },
    ], TWO_NAMESPACES);
    const o = run(plan);
    const m = parseIos(text(o));
    expect([...m.vlans.keys()]).toEqual([20]);
    expect(m.interfaces.size).toBe(0);
    expect(m.pools.size).toBe(0);
    expect(o.items.filter(i => i.fidelity === 'unsupported').map(i => i.subject).sort()).toEqual(['VLAN 10 Lab', 'VLAN 10 Users']);
    // One namespace at a time has no duplicate.
    const one = run(plan, { context: ctx({ scope: { ...WHOLE, namespaceId: 'n1' } }) });
    expect([...parseIos(text(one)).vlans.keys()]).toEqual([10, 20]);
    expect(parseIos(text(one)).interfaces.has(10)).toBe(true);
  });

  it('writes no vlan lines for VLAN 1 but still allows its interface', () => {
    const o = run(makePlan([{ vlanId: '1', name: 'Native', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }]));
    const m = parseIos(text(o));
    expect(m.vlans.size).toBe(0);
    expect(m.interfaces.get(1)!.ip4).toEqual({ address: ip('10.0.1.1'), length: 24 });
    const i = item(o, 'VLAN 1 Native');
    expect(notes(i)).toEqual(['unsupported:Name']);
    expect(i.remarks.length).toBe(1);
    // Without a name there is nothing to report as a difference.
    const plain = run(makePlan([{ vlanId: '1', name: '', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }]));
    expect(item(plain, 'VLAN 1').notes).toEqual([]);
  });

  it('skips VLAN 1 with a reason when only the VLAN section is on', () => {
    const o = run(makePlan([{ vlanId: '1', name: '' }, { vlanId: '5', name: 'Five' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 1']);
    expect(o.items.map(i => i.subject)).toEqual(['VLAN 5 Five']);
  });

  it.each([1002, 1003, 1004, 1005])('refuses reserved VLAN %i completely', n => {
    const o = run(makePlan([{ vlanId: String(n), name: 'Legacy', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1', dhcp: ['10.0.1.10 - 10.0.1.20'] } }, users]));
    const m = parseIos(text(o));
    expect(m.vlans.has(n)).toBe(false);
    expect(m.interfaces.has(n)).toBe(false);
    expect(m.pools.has(`VLAN${n}`)).toBe(false);
    expect(item(o, `VLAN ${n} Legacy`).fidelity).toBe('unsupported');
  });

  it.each([[1001, false], [1006, true], [4094, true]])('VLAN %i: extended-range manual step is %s', (n, expected) => {
    const o = run(makePlan([{ vlanId: String(n), name: 'Edge' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    expect(parseIos(text(o)).vlans.has(n)).toBe(true);
    expect(o.manualSteps.some(s => s.includes('1006'))).toBe(expected);
  });

  it('keeps a one-word name, joins spaces with underscores, and leaves out what does not fit', () => {
    const long = 'x'.repeat(33);
    const o = run(makePlan([
      { vlanId: '10', name: 'Users-1.a_b' },
      { vlanId: '20', name: 'Voice  phones' },
      { vlanId: '30', name: 'Caf/e' },
      { vlanId: '40', name: long },
      { vlanId: '50', name: 'x'.repeat(32) },
      { vlanId: '60', name: `Z${ch(0xfc)}rich` },
    ]), { sections: { vlans: true, svis: false, dhcp: false } });
    const m = parseIos(text(o));
    expect(m.vlans.get(10)!.name).toBe('Users-1.a_b');
    expect(m.vlans.get(20)!.name).toBe('Voice_phones');
    expect(m.vlans.get(30)!.name).toBeNull();
    expect(m.vlans.get(40)!.name).toBeNull();
    expect(m.vlans.get(50)!.name).toBe('x'.repeat(32));
    expect(m.vlans.get(60)!.name).toBeNull();
    expect(item(o, 'VLAN 10 Users-1.a_b').fidelity).toBe('exact');
    expect(notes(item(o, 'VLAN 20 Voice  phones'))).toEqual(['approximate:Name']);
    expect(notes(item(o, 'VLAN 30 Caf/e'))).toEqual(['unsupported:Name']);
    expect(notes(item(o, `VLAN 40 ${long}`))).toEqual(['unsupported:Name']);
    // The VLAN itself is still written, so the item is approximate, not unsupported.
    expect(item(o, 'VLAN 30 Caf/e').fidelity).toBe('approximate');
  });

  it('writes a name for neither of two VLANs that would share it, whatever the case', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'Guest Wifi' }, { vlanId: '20', name: 'guest_wifi' }, { vlanId: '30', name: 'Other' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    const m = parseIos(text(o));
    expect(m.vlans.get(10)!.name).toBeNull();
    expect(m.vlans.get(20)!.name).toBeNull();
    expect(m.vlans.get(30)!.name).toBe('Other');
    expect(notes(item(o, 'VLAN 10 Guest Wifi'))).toEqual(['unsupported:Name']);
    expect(notes(item(o, 'VLAN 20 guest_wifi'))).toEqual(['unsupported:Name']);
  });

  it('does not let a VLAN that is not written use up a name', () => {
    const o = run(makePlan([{ vlanId: '1', name: 'Users' }, { vlanId: '1003', name: 'Users' }, { vlanId: '10', name: 'Users' }]), { sections: { vlans: true, svis: false, dhcp: false } });
    expect(parseIos(text(o)).vlans.get(10)!.name).toBe('Users');
  });
});

describe('VRF placement', () => {
  const guest: VlanSpec = { vlanId: '200', name: 'Guest', vrfId: 'r2', ipv4: { network: '192.168.0.0/24', gateway: '192.168.0.1', dhcp: ['192.168.0.10 - 192.168.0.250'] } };
  const plan = makePlan([users, guest], TWO_VRFS);

  it('writes no interface and no pool until the global routing table is named', () => {
    const o = run(plan, { context: ctx({ globalVrfId: GLOBAL_UNSET, vrfNames: { r1: 'A', r2: 'B' } }) });
    const m = parseIos(text(o));
    expect([...m.vlans.keys()]).toEqual([10, 200]);
    expect(m.interfaces.size).toBe(0);
    expect(m.pools.size).toBe(0);
    expect(notes(item(o, 'VLAN 10 Users'))).toEqual(['unsupported:Gateway interface', 'unsupported:DHCP pool']);
    expect(item(o, 'VLAN 10 Users').fidelity).toBe('approximate');
  });

  it('puts the chosen global VRF in the global table and the other in its named VRF', () => {
    const o = run(plan, { context: ctx({ globalVrfId: 'r1', vrfNames: { r1: 'IGNORED', r2: 'GUEST' } }) });
    const m = parseIos(text(o));
    expect(m.interfaces.get(10)!.vrf).toBeNull();
    expect(m.interfaces.get(200)!.vrf).toBe('GUEST');
    expect(m.pools.get('VLAN10')!.vrf).toBeNull();
    expect(m.pools.get('VLAN200')!.vrf).toBe('GUEST');
    expect(m.pools.get('VLAN200')!.excluded.every(e => e.vrf === 'GUEST')).toBe(true);
    expect(text(o)).not.toContain('IGNORED');
    expect(o.manualSteps.some(s => s.includes('vrf forwarding'))).toBe(true);
    expect(text(o)).toContain('ip dhcp excluded-address vrf GUEST 192.168.0.1 192.168.0.9\n');
  });

  it('has no VRF manual step when everything is in the global table', () => {
    const o = run(makePlan([users]));
    expect(o.manualSteps.some(s => s.includes('vrf forwarding'))).toBe(false);
  });

  it('leaves out only the VRF whose device name is missing', () => {
    const o = run(plan, { context: ctx({ globalVrfId: 'r1', vrfNames: {} }) });
    const m = parseIos(text(o));
    expect(m.interfaces.has(10)).toBe(true);
    expect(m.interfaces.has(200)).toBe(false);
    expect(m.pools.has('VLAN200')).toBe(false);
    expect(notes(item(o, 'VLAN 200 Guest'))).toEqual(['unsupported:Gateway interface', 'unsupported:DHCP pool']);
  });

  it('treats every VRF as named when none is the global table', () => {
    const named = run(plan, { context: ctx({ globalVrfId: GLOBAL_NONE, vrfNames: { r1: 'CORP', r2: 'GUEST' } }) });
    const m = parseIos(text(named));
    expect(m.interfaces.get(10)!.vrf).toBe('CORP');
    expect(m.interfaces.get(200)!.vrf).toBe('GUEST');
    const missing = run(plan, { context: ctx({ globalVrfId: GLOBAL_NONE, vrfNames: { r2: 'GUEST' } }) });
    expect(parseIos(text(missing)).interfaces.has(10)).toBe(false);
    expect(parseIos(text(missing)).interfaces.get(200)!.vrf).toBe('GUEST');
  });

  it('trims a device name and refuses one that is not a valid name', () => {
    expect(parseIos(text(run(plan, { context: ctx({ vrfNames: { r2: '  GUEST  ' } }) }))).interfaces.get(200)!.vrf).toBe('GUEST');
    for (const bad of ['Guest HQ', 'a'.repeat(33), 'x;y', 'x?', `x${ch(10)}shutdown`, `G${ch(0xe9)}`, '   ']) {
      const o = run(plan, { context: ctx({ vrfNames: { r2: bad } }) });
      const m = parseIos(text(o));
      expect(m.interfaces.has(200), JSON.stringify(bad)).toBe(false);
      expect(m.pools.has('VLAN200'), JSON.stringify(bad)).toBe(false);
      expect(forbiddenLines(text(o))).toEqual([]);
    }
    expect(parseIos(text(run(plan, { context: ctx({ vrfNames: { r2: 'a'.repeat(32) } }) }))).interfaces.get(200)!.vrf).toBe('a'.repeat(32));
  });

  it('reads device names only from own properties of the map', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const tricky = makePlan([users, { ...guest, vrfId: id }], { vrfs: [TWO_VRFS.vrfs![0]!, { ...TWO_VRFS.vrfs![1]!, id }] });
      const o = run(tricky, { context: ctx({ vrfNames: {} }) });
      expect(o.ok, id).toBe(true);
      expect(parseIos(text(o)).interfaces.has(200), id).toBe(false);
      expect(notes(item(o, 'VLAN 200 Guest')), id).toEqual(['unsupported:Gateway interface', 'unsupported:DHCP pool']);
      const names = Object.create(null) as Record<string, string>;
      names[id] = 'GUEST';
      expect(parseIos(text(run(tricky, { context: ctx({ vrfNames: names }) }))).interfaces.get(200)!.vrf, id).toBe('GUEST');
    }
  });
});

describe('gateway interfaces', () => {
  const svi: IosSections = { vlans: false, svis: true, dhcp: false };

  it('writes an IPv4 gateway with its mask', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/25', gateway: '10.0.10.126' } }]), { sections: svi });
    expect(body(o)).toEqual(['interface Vlan10', ' ip address 10.0.10.126 255.255.255.128']);
    expect(item(o, 'VLAN 10 A').fidelity).toBe('exact');
    expect(o.manualSteps.some(s => s.includes('ipv6 unicast-routing'))).toBe(false);
  });

  it('writes a global IPv6 gateway with the length of its prefix', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' }, ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: '2001:DB8:0:A::1' } }]), { sections: svi });
    const itf = parseIos(text(o)).interfaces.get(10)!;
    expect(itf.ip6).toEqual([{ address: parseV6('2001:db8:0:a::1'), length: 64 }]);
    expect(item(o, 'VLAN 10 A').fidelity).toBe('exact');
    expect(o.manualSteps.some(s => s.includes('ipv6 unicast-routing'))).toBe(true);
  });

  it('writes a link-local gateway with the link-local keyword and reports the prefix it cannot configure', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: 'fe80::1' } }]), { sections: svi });
    expect(body(o)).toEqual(['interface Vlan10', ' ipv6 address fe80::1 link-local']);
    expect(notes(item(o, 'VLAN 10 A'))).toEqual(['unsupported:IPv6 prefix']);
  });

  it('notes every prefix the gateway has no address in', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv6: { prefixes: ['2001:db8:0:a::/64', '2001:db8:0:b::/64', '2001:db8:0:c::/64'], gateway: '2001:db8:0:b::1' } }]), { sections: svi });
    expect(parseIos(text(o)).interfaces.get(10)!.ip6).toEqual([{ address: parseV6('2001:db8:0:b::1'), length: 64 }]);
    const i = item(o, 'VLAN 10 A');
    expect(notes(i)).toEqual(['unsupported:IPv6 prefix', 'unsupported:IPv6 prefix']);
    expect(i.notes[0]!.detail).toContain('2001:db8:0:a::/64');
    expect(i.notes[1]!.detail).toContain('2001:db8:0:c::/64');
  });

  it('writes a /31 gateway', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.0.0/31', gateway: '10.0.0.0' } }]), { sections: svi });
    expect(parseIos(text(o)).interfaces.get(10)!.ip4).toEqual({ address: ip('10.0.0.0'), length: 31 });
  });

  it('does not put a /32 on an interface', () => {
    const o = run(makePlan([{ vlanId: '30', name: 'A', ipv4: { network: '10.0.0.5/32', gateway: '10.0.0.5' } }, users]), { sections: svi });
    expect([...parseIos(text(o)).interfaces.keys()]).toEqual([10]);
    expect(notes(item(o, 'VLAN 30 A'))).toEqual(['unsupported:Gateway interface']);
    expect(item(o, 'VLAN 30 A').fidelity).toBe('unsupported');
  });

  it('writes the IPv6 address and reports the IPv4 one when the IPv4 network is a /32', () => {
    const o = run(makePlan([{ vlanId: '20', name: 'B', ipv4: { network: '10.0.0.5/32', gateway: '10.0.0.5' }, ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: '2001:db8:0:a::1' } }]), { sections: svi });
    const itf = parseIos(text(o)).interfaces.get(20)!;
    expect(itf.ip4).toBeNull();
    expect(itf.ip6).toHaveLength(1);
    expect(notes(item(o, 'VLAN 20 B'))).toEqual(['unsupported:IPv4 address']);
  });

  it('writes nothing and remarks when the VLAN has no gateway', () => {
    const o = run(makePlan([{ vlanId: '30', name: 'A', ipv4: { network: '10.0.30.0/24' } }, { vlanId: '20', name: 'B' }, users]), { sections: svi });
    expect(parseIos(text(o)).interfaces.size).toBe(1);
    expect(o.skipped.map(s => s.subject).sort()).toEqual(['VLAN 20 B', 'VLAN 30 A']);
    expect(o.skipped.find(s => s.subject === 'VLAN 30 A')!.reason).toMatch(/gateway/);
  });

  it('writes an accepted description first, then the VRF, then the addresses', () => {
    const plan = makePlan([{ vlanId: '200', name: 'G', vrfId: 'r2', description: 'Guest access! (floor 2) #1; {x}', ipv4: { network: '192.168.0.0/24', gateway: '192.168.0.1' }, ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: '2001:db8:0:a::1' } }], TWO_VRFS);
    const o = run(plan, { sections: svi, context: ctx({ vrfNames: { r2: 'GUEST' } }) });
    expect(body(o)).toEqual([
      'interface Vlan200', ' description Guest access! (floor 2) #1; {x}', ' vrf forwarding GUEST',
      ' ip address 192.168.0.1 255.255.255.0', ' ipv6 address 2001:db8:0:a::1/64',
    ]);
    expect(item(o, 'VLAN 200 G').fidelity).toBe('exact');
  });

  it.each([
    ['a question mark', 'Is this right?'],
    ['a non-ASCII letter', `Caf${ch(0xe9)}`],
    ['a line feed', `one${ch(10)} no ip address`],
    ['a carriage return', `one${ch(13)}two`],
    ['a tab', `one${ch(9)}two`],
    ['a NUL', `one${ch(0)}two`],
    ['a line separator', `one${ch(0x2028)}two`],
    ['201 characters', 'd'.repeat(201)],
  ])('leaves out a description with %s and says so', (_what, description) => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', description, ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' } }]), { sections: svi });
    expect(body(o)).toEqual(['interface Vlan10', ' ip address 10.0.10.1 255.255.255.0']);
    expect(notes(item(o, 'VLAN 10 A'))).toEqual(['unsupported:Description']);
  });

  it('accepts a description of exactly 200 characters', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', description: 'd'.repeat(200), ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' } }]), { sections: svi });
    expect(parseIos(text(o)).interfaces.get(10)!.description).toBe('d'.repeat(200));
  });
});

describe('DHCP pools', () => {
  const dhcp: IosSections = { vlans: false, svis: false, dhcp: true };

  it('excludes everything outside the pools before the pool, with single addresses written alone', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1', dhcp: ['10.0.10.2 - 10.0.10.99', '10.0.10.101 - 10.0.10.253'] } }]), { sections: dhcp });
    expect(body(o)).toEqual([
      'ip dhcp excluded-address 10.0.10.1',
      'ip dhcp excluded-address 10.0.10.100',
      'ip dhcp excluded-address 10.0.10.254',
      'ip dhcp pool VLAN10', ' network 10.0.10.0 255.255.255.0', ' default-router 10.0.10.1',
    ]);
    const pool = parseIos(text(o)).pools.get('VLAN10')!;
    const leasable = iosLeasable(pool);
    expect(leasable.size).toBe(98 + 153);
    expect(leasable.has(ip('10.0.10.100'))).toBe(false);
    expect(leasable.has(ip('10.0.10.1'))).toBe(false);
    expect(leasable.has(ip('10.0.10.2')) && leasable.has(ip('10.0.10.253'))).toBe(true);
    expect(item(o, 'VLAN 10 A').fidelity).toBe('exact');
  });

  it('writes no exclusion when the pools cover every host', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/29', dhcp: ['10.0.10.1 - 10.0.10.6'] } }]), { sections: dhcp });
    expect(body(o)).toEqual(['ip dhcp pool VLAN10', ' network 10.0.10.0 255.255.255.248']);
    expect(item(o, 'VLAN 10 A').remarks).toHaveLength(1);
  });

  it('writes no pool for a /31, which has no host range', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'P2P', ipv4: { network: '10.0.0.0/31', dhcp: ['10.0.0.1'] } }, { ...users, vlanId: '20' }]), { sections: dhcp });
    expect([...parseIos(text(o)).pools.keys()]).toEqual(['VLAN20']);
    expect(notes(item(o, 'VLAN 10 P2P'))).toEqual(['unsupported:DHCP pool']);
  });

  it('writes DNS servers and the domain name only when given', () => {
    const plan = makePlan([users]);
    const o = run(plan, { sections: dhcp, dnsServers: ' 10.0.0.53,10.0.0.54  ', dnsDomain: ' corp.example ' });
    const pool = parseIos(text(o)).pools.get('VLAN10')!;
    expect(pool.dns).toEqual([ip('10.0.0.53'), ip('10.0.0.54')]);
    expect(pool.domain).toBe('corp.example');
    expect(pool.router).toBe(ip('10.0.10.1'));
    const bare = parseIos(text(run(plan, { sections: dhcp }))).pools.get('VLAN10')!;
    expect(bare.dns).toEqual([]);
    expect(bare.domain).toBeNull();
  });

  it('writes a pool only for VLANs that have one', () => {
    const o = run(makePlan([users, { vlanId: '20', name: 'Static', ipv4: { network: '10.0.20.0/24', gateway: '10.0.20.1' } }]), { sections: dhcp });
    expect([...parseIos(text(o)).pools.keys()]).toEqual(['VLAN10']);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 20 Static']);
  });

  it('has the DHCP manual step and assumption only with a pool', () => {
    expect(run(makePlan([users])).manualSteps.some(s => s.includes('DHCP'))).toBe(true);
    expect(run(makePlan([users]), { sections: { vlans: true, svis: true, dhcp: false } }).manualSteps.some(s => s.includes('DHCP'))).toBe(false);
  });
});

describe('sections', () => {
  const plan = makePlan([users]);
  const kinds = (o: ExportOutput) => {
    const m = parseIos(text(o));
    return { vlans: m.vlans.size, interfaces: m.interfaces.size, pools: m.pools.size };
  };
  it.each([
    [{ vlans: true, svis: false, dhcp: false }, { vlans: 1, interfaces: 0, pools: 0 }],
    [{ vlans: false, svis: true, dhcp: false }, { vlans: 0, interfaces: 1, pools: 0 }],
    [{ vlans: false, svis: false, dhcp: true }, { vlans: 0, interfaces: 0, pools: 1 }],
    [{ vlans: true, svis: true, dhcp: false }, { vlans: 1, interfaces: 1, pools: 0 }],
    [{ vlans: true, svis: false, dhcp: true }, { vlans: 1, interfaces: 0, pools: 1 }],
    [{ vlans: false, svis: true, dhcp: true }, { vlans: 0, interfaces: 1, pools: 1 }],
    [{ vlans: true, svis: true, dhcp: true }, { vlans: 1, interfaces: 1, pools: 1 }],
  ])('%j writes only its lines', (sections, expected) => {
    expect(kinds(run(plan, { sections }))).toEqual(expected);
  });

  it('writes VLANs, then interfaces, then DHCP, each under one header', () => {
    const o = run(makePlan([users, { vlanId: '20', name: 'B', ipv4: { network: '10.0.20.0/24', gateway: '10.0.20.1', dhcp: ['10.0.20.10'] } }]));
    const lines = text(o).split('\n');
    const at = (start: string) => lines.findIndex(l => l.startsWith(start));
    expect(at('vlan 10')).toBeLessThan(at('interface Vlan10'));
    expect(at('interface Vlan20')).toBeLessThan(at('ip dhcp'));
    expect(lines.filter(l => l.startsWith('! ')).length).toBe(3 + 3);
    expect(o.files).toHaveLength(1);
    expect(o.privileges).toEqual([]);
  });
});

describe('nothing the plan text contains can add or change a line', () => {
  const hostile = [
    `x${ch(10)}no ip routing`, `x${ch(13)}${ch(10)}shutdown`, `x${ch(0x2028)}reload`, `x${ch(0x2029)}reload`, `x${ch(0)}y`, `x${ch(0x85)}write erase`,
    'what?', '!comment', '"quoted"', "it's", 'back\\slash', 'semi;colon', '#hash', '{brace}', 'a b; no vlan 1',
    ' name evil', 'vlan 999', `ok${ch(10)}interface Vlan1${ch(10)} shutdown`, `${ch(0x202e)}rtl`, `tab${ch(9)}bed`, `${ch(0xff1f)}wide`,
  ];

  it('in VLAN names, descriptions, VRF device names and VRF plan names', () => {
    for (const evil of hostile) {
      const plan = makePlan([
        { vlanId: '10', name: evil, description: evil, vrfId: 'r2', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1', dhcp: ['10.0.10.100 - 10.0.10.200'] } },
        { vlanId: '20', name: 'Plain', description: 'ok', ipv4: { network: '10.0.20.0/24', gateway: '10.0.20.1' } },
      ], { vrfs: [TWO_VRFS.vrfs![0]!, { ...TWO_VRFS.vrfs![1]!, name: `V ${evil}` }] });
      const o = run(plan, { context: ctx({ vrfNames: { r2: evil } }) });
      expect(o.ok, JSON.stringify(evil)).toBe(true);
      const m = parseIos(text(o));
      expect(forbiddenLines(text(o)), JSON.stringify(evil)).toEqual([]);
      expect([...m.vlans.keys()]).toEqual([10, 20]);
      // The hostile device VRF name is refused, so VLAN 10 has no interface and no pool.
      expect([...m.interfaces.keys()]).toEqual([20]);
      expect(m.pools.size).toBe(0);
      const name = m.vlans.get(10)!.name;
      // 4 header comments + "! VLANs" + vlan 10 [+ name] + ! + vlan 20, name, ! + "! Gateway..." + 3 interface lines + !
      expect(m.lineCount, JSON.stringify(evil)).toBe(4 + 1 + (name === null ? 2 : 3) + 3 + 1 + 4);
      if (name !== null) expect(name).toMatch(/^[A-Za-z0-9_.-]{1,32}$/);
    }
  });

  it('in descriptions that reach an interface', () => {
    for (const evil of hostile) {
      const o = run(makePlan([{ vlanId: '10', name: 'A', description: evil, ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' } }]), { sections: { vlans: false, svis: true, dhcp: false } });
      const m = parseIos(text(o));
      const d = m.interfaces.get(10)!.description;
      expect(forbiddenLines(text(o))).toEqual([]);
      expect(m.lineCount, JSON.stringify(evil)).toBe(4 + 1 + (d === null ? 2 : 3) + 1);
      if (d !== null) expect(d).toBe(evil.trim());
    }
  });

  it('in the domain name and DNS servers', () => {
    for (const evil of hostile) {
      expect(run(makePlan([users]), { dnsDomain: evil }).ok, JSON.stringify(evil)).toBe(false);
      expect(run(makePlan([users]), { dnsServers: `10.0.0.1 ${evil}` }).ok, JSON.stringify(evil)).toBe(false);
    }
  });
});

describe('large selections', () => {
  it('writes 2,000 VLANs with interfaces and pools', () => {
    const vlans: VlanSpec[] = [];
    for (let i = 0; i < 2000; i++) {
      const base = `10.${Math.floor(i / 250)}.${i % 250}`;
      vlans.push({ id: `v${i + 1}`, vlanId: String(i + 2), name: `Seg${i + 2}`, ipv4: { network: `${base}.0/24`, gateway: `${base}.1`, dhcp: [`${base}.50 - ${base}.200`] } });
    }
    const started = Date.now();
    const o = run(makePlan(vlans));
    const elapsed = Date.now() - started;
    const m = parseIos(text(o));
    // IDs 2 to 2001 include the four reserved VLANs 1002 to 1005.
    expect(m.vlans.size).toBe(1996);
    expect(m.interfaces.size).toBe(1996);
    expect(m.pools.size).toBe(1996);
    expect(o.counts).toEqual({ exact: 1996, approximate: 0, unsupported: 4 });
    expect(o.manualSteps.some(s => s.includes('1006'))).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
