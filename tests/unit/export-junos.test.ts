/**
 * Juniper Junos export (set commands, ELS). Every generated text is read by the strict line
 * grammar in helpers/device-grammar.ts (documented syntax, not a device), and the model it reads
 * back is compared with the plan. Assertions are on structure, labels and fields, not wording.
 */
import { describe, expect, it } from 'vitest';
import { GLOBAL_NONE, GLOBAL_UNSET, type DeviceContext } from '../../src/core/infra/devices';
import { junosConfig, type JunosOptions, type JunosSections } from '../../src/core/infra/junos';
import type { ExportItem, ExportOutput } from '../../src/core/infra/model';
import type { Plan } from '../../src/core/plan/model';
import { makePlan, type VlanSpec } from '../plan-helpers';
import { forbiddenLines, parseJunos, parseV4, parseV6 } from './helpers/device-grammar';

const ch = (code: number) => String.fromCharCode(code);
const WHOLE = { siteId: '', vrfId: '', namespaceId: '' };
const BOTH: JunosSections = { vlans: true, irb: true };
const ctx = (over: Partial<DeviceContext> = {}): DeviceContext => ({ scope: WHOLE, globalVrfId: 'r1', vrfNames: {}, ...over });
const run = (plan: Plan, over: Partial<JunosOptions> = {}): ExportOutput => junosConfig(plan, { context: ctx(), sections: BOTH, ...over });
const text = (o: ExportOutput): string => o.files[0]!.text;
const lines = (o: ExportOutput): string[] => text(o).slice(0, -1).split('\n');
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
const users: VlanSpec = { vlanId: '10', name: 'Users', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' } };

describe('refusals', () => {
  it('refuses a plan with errors, a bad scope, no sections and an empty selection', () => {
    expect(run(makePlan([users, { ...users, name: 'Twin' }])).ok).toBe(false);
    expect(run(makePlan([{ ...users, vlanId: '' }])).ok).toBe(false);
    for (const scope of [{ ...WHOLE, siteId: 'nope' }, { ...WHOLE, vrfId: 'nope' }, { ...WHOLE, namespaceId: 'nope' }]) {
      expect(run(makePlan([users]), { context: ctx({ scope }) }).ok).toBe(false);
    }
    const none = run(makePlan([users]), { sections: { vlans: false, irb: false } });
    expect(none.ok).toBe(false);
    expect(none.refusals).toHaveLength(1);
    expect(none.refusals[0]).toMatch(/section/i);
    expect(none.skipped).toEqual([]);
    expect(none.files).toEqual([]);
    const plan = makePlan([users], { sites: [{ id: 's1', name: 'One', description: '', notes: '', blocks: [] }, { id: 's2', name: 'Two', description: '', notes: '', blocks: [] }] });
    expect(run(plan, { context: ctx({ scope: { ...WHOLE, siteId: 's2' } }) }).ok).toBe(false);
  });

  it('refuses when nothing can be written, and still explains each VLAN', () => {
    const o = run(makePlan([{ vlanId: '1', name: 'Native', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }]));
    expect(o.ok).toBe(false);
    expect(o.items.map(i => i.fidelity)).toEqual(['unsupported']);
    expect(notes(o.items[0]!)).toEqual(['unsupported:VLAN']);
  });
});

describe('VLANs and names', () => {
  const only: JunosSections = { vlans: true, irb: false };

  it('writes a vlan-id line per VLAN, in ID order, with no comment lines', () => {
    const o = run(makePlan([{ vlanId: '300', name: 'c' }, { vlanId: '20', name: 'a-1_x' }, { vlanId: '4094', name: 'Z9' }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans a-1_x vlan-id 20', 'set vlans c vlan-id 300', 'set vlans Z9 vlan-id 4094']);
    expect(o.counts).toEqual({ exact: 3, approximate: 0, unsupported: 0 });
    expect(lines(o).every(l => l.startsWith('set '))).toBe(true);
  });

  it('writes nothing for VLAN ID 1 and keeps the others', () => {
    const o = run(makePlan([{ vlanId: '1', name: 'Native', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }, users]));
    const m = parseJunos(text(o));
    expect([...m.vlans.values()].map(v => v.id)).toEqual([10]);
    expect([...m.units.keys()]).toEqual([10]);
    expect(item(o, 'VLAN 1 Native').fidelity).toBe('unsupported');
  });

  it('writes nothing for either VLAN when an ID appears in two namespaces of the selection', () => {
    const plan = makePlan([
      { ...users, namespaceId: 'n1' },
      { vlanId: '10', name: 'Lab', namespaceId: 'n2', ipv4: { network: '10.0.50.0/24', gateway: '10.0.50.1' } },
      { vlanId: '20', name: 'Voice', namespaceId: 'n1' },
    ], TWO_NAMESPACES);
    const o = run(plan);
    const m = parseJunos(text(o));
    expect([...m.vlans.keys()]).toEqual(['Voice']);
    expect(m.units.size).toBe(0);
    expect(o.items.filter(i => i.fidelity === 'unsupported').map(i => i.subject).sort()).toEqual(['VLAN 10 Lab', 'VLAN 10 Users']);
    const one = parseJunos(text(run(plan, { context: ctx({ scope: { ...WHOLE, namespaceId: 'n2' } }) })));
    expect([...one.vlans.keys()]).toEqual(['Lab']);
  });

  it('keeps a fitting name, joins spaces with hyphens and replaces what does not fit with VLAN<id>', () => {
    const o = run(makePlan([
      { vlanId: '10', name: 'Users_1-a' },
      { vlanId: '20', name: 'Voice  phones' },
      { vlanId: '30', name: 'Caf/e' },
      { vlanId: '40', name: '9lives' },
      { vlanId: '50', name: 'a'.repeat(65) },
      { vlanId: '60', name: 'a'.repeat(64) },
      { vlanId: '70', name: '' },
      { vlanId: '80', name: 'dotted.name' },
      { vlanId: '90', name: `Z${ch(0xfc)}rich` },
    ]), { sections: only });
    const m = parseJunos(text(o));
    const nameOf = (id: number) => [...m.vlans].find(([, v]) => v.id === id)![0];
    expect(nameOf(10)).toBe('Users_1-a');
    expect(nameOf(20)).toBe('Voice-phones');
    expect(nameOf(30)).toBe('VLAN30');
    expect(nameOf(40)).toBe('VLAN40');
    expect(nameOf(50)).toBe('VLAN50');
    expect(nameOf(60)).toBe('a'.repeat(64));
    expect(nameOf(70)).toBe('VLAN70');
    expect(nameOf(80)).toBe('VLAN80');
    expect(nameOf(90)).toBe('VLAN90');
    expect(item(o, 'VLAN 10 Users_1-a').fidelity).toBe('exact');
    for (const subject of ['VLAN 20 Voice  phones', 'VLAN 30 Caf/e', 'VLAN 40 9lives', 'VLAN 70', 'VLAN 80 dotted.name']) {
      expect(notes(item(o, subject)), subject).toEqual(['approximate:Name']);
      expect(item(o, subject).fidelity, subject).toBe('approximate');
    }
  });

  it.each(['default', 'Default', 'ALL', 'all'])('does not use the reserved name %s', name => {
    const o = run(makePlan([{ vlanId: '10', name }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans VLAN10 vlan-id 10']);
    expect(notes(item(o, `VLAN 10 ${name}`))).toEqual(['approximate:Name']);
  });

  it('gives VLAN<id> to every VLAN whose name another VLAN would share', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'Guest Wifi' }, { vlanId: '20', name: 'Guest-Wifi' }, { vlanId: '30', name: 'Other' }, { vlanId: '40', name: 'guest-wifi' }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans VLAN10 vlan-id 10', 'set vlans VLAN20 vlan-id 20', 'set vlans Other vlan-id 30', 'set vlans guest-wifi vlan-id 40']);
    expect(notes(item(o, 'VLAN 20 Guest-Wifi'))).toEqual(['approximate:Name']);
  });

  it('renames the VLAN whose plan name is the replacement name of another', () => {
    // VLAN 20 has no name and becomes VLAN20, which is the name VLAN 30 asks for.
    const o = run(makePlan([{ vlanId: '20', name: '' }, { vlanId: '30', name: 'VLAN20' }, { vlanId: '40', name: 'Fine' }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans VLAN20 vlan-id 20', 'set vlans VLAN30 vlan-id 30', 'set vlans Fine vlan-id 40']);
    expect(notes(item(o, 'VLAN 30 VLAN20'))).toEqual(['approximate:Name']);
  });

  it('writes neither VLAN when a replacement name is still taken', () => {
    // VLAN 30 is renamed VLAN30 as above, which is the plan's own name of VLAN 40.
    const o = run(makePlan([{ vlanId: '20', name: '' }, { vlanId: '30', name: 'VLAN20' }, { vlanId: '40', name: 'VLAN30' }, { vlanId: '50', name: 'Fine' }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans VLAN20 vlan-id 20', 'set vlans Fine vlan-id 50']);
    expect(item(o, 'VLAN 30 VLAN20').fidelity).toBe('unsupported');
    expect(item(o, 'VLAN 40 VLAN30').fidelity).toBe('unsupported');
    expect(notes(item(o, 'VLAN 40 VLAN30'))).toEqual(['unsupported:VLAN']);
  });

  it('does not let a VLAN that is not written use up a name', () => {
    const plan = makePlan([
      { vlanId: '1', name: 'Users' }, { vlanId: '10', name: 'Users' },
      { vlanId: '20', name: 'Lab', namespaceId: 'n1' }, { vlanId: '20', name: 'Lab', namespaceId: 'n2' }, { vlanId: '30', name: 'Lab' },
    ], TWO_NAMESPACES);
    const o = run(plan, { sections: only });
    expect(lines(o)).toEqual(['set vlans Users vlan-id 10', 'set vlans Lab vlan-id 30']);
    expect(item(o, 'VLAN 10 Users').fidelity).toBe('exact');
  });

  it('writes an accepted description in quotes', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', description: "  Guest access! (floor 2) #1; {x} it's  " }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans A vlan-id 10', 'set vlans A description "Guest access! (floor 2) #1; {x} it\'s"']);
    expect(item(o, 'VLAN 10 A').fidelity).toBe('exact');
  });

  it.each([
    ['a double quote', 'say "hi"'],
    ['a backslash', 'a\\b'],
    ['a question mark', 'why?'],
    ['a non-ASCII letter', `Caf${ch(0xe9)}`],
    ['a line feed', `one${ch(10)}set system root-authentication plain-text-password`],
    ['a carriage return', `one${ch(13)}two`],
    ['a NUL', `one${ch(0)}two`],
    ['a line separator', `one${ch(0x2028)}two`],
    ['201 characters', 'd'.repeat(201)],
  ])('leaves out a description with %s and says so', (_what, description) => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', description }]), { sections: only });
    expect(lines(o)).toEqual(['set vlans A vlan-id 10']);
    expect(notes(item(o, 'VLAN 10 A'))).toEqual(['unsupported:Description']);
  });

  it('accepts a description of exactly 200 characters', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', description: 'd'.repeat(200) }]), { sections: only });
    expect(parseJunos(text(o)).vlans.get('A')!.description).toBe('d'.repeat(200));
  });

  it('reports DHCP pools as not written', () => {
    const o = run(makePlan([{ ...users, ipv4: { ...users.ipv4, dhcp: ['10.0.10.100 - 10.0.10.200', '10.0.10.210'] } }]));
    expect(notes(item(o, 'VLAN 10 Users'))).toEqual(['unsupported:DHCP pools']);
    expect(text(o)).not.toMatch(/dhcp|10\.0\.10\.100/);
  });
});

describe('IRB interfaces and routing instances', () => {
  const guest: VlanSpec = { vlanId: '200', name: 'Guest', vrfId: 'r2', ipv4: { network: '192.168.0.0/24', gateway: '192.168.0.1' } };
  const plan = makePlan([users, guest], TWO_VRFS);

  it('writes the gateway on irb.<id>, ties it to the VLAN and adds named instances last', () => {
    const o = run(plan, { context: ctx({ vrfNames: { r1: 'IGNORED', r2: 'GUEST-1' } }) });
    expect(lines(o)).toEqual([
      'set vlans Users vlan-id 10', 'set vlans Users l3-interface irb.10',
      'set vlans Guest vlan-id 200', 'set vlans Guest l3-interface irb.200',
      'set interfaces irb unit 10 family inet address 10.0.10.1/24',
      'set interfaces irb unit 200 family inet address 192.168.0.1/24',
      'set routing-instances GUEST-1 interface irb.200',
    ]);
    const m = parseJunos(text(o));
    expect(m.instances.get('GUEST-1')).toEqual([200]);
    expect(o.counts).toEqual({ exact: 2, approximate: 0, unsupported: 0 });
    expect(o.manualSteps.some(s => s.includes('routing instance'))).toBe(true);
    expect(run(makePlan([users])).manualSteps.some(s => s.includes('routing instance'))).toBe(false);
  });

  it('writes no IRB unit and no l3-interface until the global routing table is named', () => {
    const o = run(plan, { context: ctx({ globalVrfId: GLOBAL_UNSET, vrfNames: { r1: 'A', r2: 'B' } }) });
    expect(lines(o)).toEqual(['set vlans Users vlan-id 10', 'set vlans Guest vlan-id 200']);
    expect(notes(item(o, 'VLAN 10 Users'))).toEqual(['unsupported:IRB interface']);
    expect(item(o, 'VLAN 10 Users').fidelity).toBe('approximate');
  });

  it('leaves out only the VRF whose device name is missing or invalid', () => {
    for (const bad of [undefined, '', '   ', 'Guest HQ', 'a'.repeat(65), 'x.y', 'x;y', `x${ch(10)}set system`, 'x?']) {
      const o = run(plan, { context: ctx({ vrfNames: bad === undefined ? {} : { r2: bad } }) });
      const m = parseJunos(text(o));
      expect([...m.units.keys()], JSON.stringify(bad)).toEqual([10]);
      expect(m.instances.size).toBe(0);
      expect(m.vlans.get('Guest')!.l3).toBeNull();
      expect(m.vlans.get('Users')!.l3).toBe(10);
      expect(notes(item(o, 'VLAN 200 Guest'))).toEqual(['unsupported:IRB interface']);
    }
    expect(parseJunos(text(run(plan, { context: ctx({ vrfNames: { r2: ` ${'a'.repeat(64)} ` } }) }))).instances.has('a'.repeat(64))).toBe(true);
  });

  it('treats every VRF as a routing instance when none is the global table', () => {
    const m = parseJunos(text(run(plan, { context: ctx({ globalVrfId: GLOBAL_NONE, vrfNames: { r1: 'CORP', r2: 'GUEST' } }) })));
    expect(m.instances.get('CORP')).toEqual([10]);
    expect(m.instances.get('GUEST')).toEqual([200]);
  });

  it('reads device names only from own properties of the map', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const tricky = makePlan([users, { ...guest, vrfId: id }], { vrfs: [TWO_VRFS.vrfs![0]!, { ...TWO_VRFS.vrfs![1]!, id }] });
      const o = run(tricky, { context: ctx({ vrfNames: {} }) });
      expect(o.ok, id).toBe(true);
      expect([...parseJunos(text(o)).units.keys()], id).toEqual([10]);
    }
  });

  it('writes IPv6 gateways: global with its prefix length, link-local as a /64', () => {
    const o = run(makePlan([
      { vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' }, ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: '2001:DB8:0:A::1' } },
      { vlanId: '20', name: 'B', ipv6: { prefixes: ['2001:db8:0:b::/64'], gateway: 'fe80::1' } },
      { vlanId: '30', name: 'C', ipv6: { prefixes: ['2001:db8:0:c::/64', '2001:db8:0:d::/64', '2001:db8:0:e::/64'], gateway: '2001:db8:0:d::5' } },
    ]));
    const m = parseJunos(text(o));
    expect(m.units.get(10)).toEqual({ inet: [{ address: ip('10.0.10.1'), length: 24 }], inet6: [{ address: parseV6('2001:db8:0:a::1'), length: 64 }] });
    expect(m.units.get(20)).toEqual({ inet: [], inet6: [{ address: parseV6('fe80::1'), length: 64 }] });
    expect(m.units.get(30)!.inet6).toEqual([{ address: parseV6('2001:db8:0:d::5'), length: 64 }]);
    expect(item(o, 'VLAN 10 A').fidelity).toBe('exact');
    expect(notes(item(o, 'VLAN 20 B'))).toEqual(['unsupported:IPv6 prefix']);
    expect(notes(item(o, 'VLAN 30 C'))).toEqual(['unsupported:IPv6 prefix', 'unsupported:IPv6 prefix']);
  });

  it('writes a /31 gateway and refuses a /32', () => {
    const o = run(makePlan([
      { vlanId: '10', name: 'P2P', ipv4: { network: '10.0.0.0/31', gateway: '10.0.0.1' } },
      { vlanId: '20', name: 'Host', ipv4: { network: '10.0.0.5/32', gateway: '10.0.0.5' } },
    ]));
    const m = parseJunos(text(o));
    expect(m.units.get(10)!.inet).toEqual([{ address: ip('10.0.0.1'), length: 31 }]);
    expect(m.units.has(20)).toBe(false);
    expect(m.vlans.get('Host')).toEqual({ id: 20, description: null, l3: null });
    expect(notes(item(o, 'VLAN 20 Host'))).toEqual(['unsupported:IRB interface']);
  });

  it('writes the IPv6 address and reports the IPv4 one when the IPv4 network is a /32', () => {
    const o = run(makePlan([{ vlanId: '20', name: 'Host', ipv4: { network: '10.0.0.5/32', gateway: '10.0.0.5' }, ipv6: { prefixes: ['2001:db8:0:a::/64'], gateway: '2001:db8:0:a::1' } }]));
    const m = parseJunos(text(o));
    expect(m.units.get(20)).toEqual({ inet: [], inet6: [{ address: parseV6('2001:db8:0:a::1'), length: 64 }] });
    expect(m.vlans.get('Host')!.l3).toBe(20);
    expect(notes(item(o, 'VLAN 20 Host'))).toEqual(['unsupported:IPv4 address']);
  });

  it('writes no IRB unit without a gateway, with a remark when the VLAN has a network', () => {
    const o = run(makePlan([{ vlanId: '10', name: 'A', ipv4: { network: '10.0.10.0/24' } }, { vlanId: '20', name: 'B' }]));
    expect(lines(o)).toEqual(['set vlans A vlan-id 10', 'set vlans B vlan-id 20']);
    expect(item(o, 'VLAN 10 A').remarks).toHaveLength(1);
    expect(item(o, 'VLAN 20 B').remarks).toHaveLength(0);
    expect(o.manualSteps.some(s => s.includes('IRB interface comes up'))).toBe(false);
  });
});

describe('sections', () => {
  const plan = makePlan([users, { vlanId: '20', name: 'NoGw', description: 'no gateway', ipv4: { network: '10.0.20.0/24' } }]);

  it('VLAN section only: no IRB lines and no l3-interface', () => {
    const o = run(plan, { sections: { vlans: true, irb: false } });
    expect(lines(o)).toEqual(['set vlans Users vlan-id 10', 'set vlans NoGw vlan-id 20', 'set vlans NoGw description "no gateway"']);
  });

  it('IRB section only: units without vlans lines, a remark, and VLANs without a gateway skipped', () => {
    const o = run(plan, { sections: { vlans: false, irb: true } });
    expect(lines(o)).toEqual(['set interfaces irb unit 10 family inet address 10.0.10.1/24']);
    expect(item(o, 'VLAN 10 Users').remarks).toHaveLength(1);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 20 NoGw']);
  });

  it('IRB section only with the global table unanswered: every VLAN with a gateway is an unsupported item, not a skipped one', () => {
    const o = run(plan, { sections: { vlans: false, irb: true }, context: ctx({ globalVrfId: GLOBAL_UNSET }) });
    expect(o.ok).toBe(false);
    expect(o.items.map(i => [i.subject, i.fidelity])).toEqual([['VLAN 10 Users', 'unsupported']]);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 20 NoGw']);
  });

  it('both: the l3-interface line appears exactly for the units that are written', () => {
    const m = parseJunos(text(run(plan)));
    expect(m.vlans.get('Users')!.l3).toBe(10);
    expect(m.vlans.get('NoGw')!.l3).toBeNull();
    expect([...m.units.keys()]).toEqual([10]);
  });

  it('returns one text file and needs no privileges', () => {
    const o = run(plan);
    expect(o.files.map(f => f.name)).toEqual(['netforge-junos.txt']);
    expect(o.privileges).toEqual([]);
    expect(text(o).endsWith('\n')).toBe(true);
  });
});

describe('nothing the plan text contains can add or change a line', () => {
  const hostile = [
    `x${ch(10)}set system root-authentication plain-text-password`, `x${ch(13)}${ch(10)}delete interfaces`, `x${ch(0x2028)}commit`, `x${ch(0x2029)}commit`,
    `x${ch(0)}y`, `x${ch(0x85)}commit`, 'what?', '!bang', '"quoted" set vlans', "it's", 'back\\slash', 'trailing\\', 'semi;colon', '#hash', '{brace}',
    'A vlan-id 99', 'x" vlan-id 99', `ok${ch(10)}commit`, `${ch(0x202e)}rtl`, `tab${ch(9)}bed`, 'commit', 'delete',
  ];

  it('in VLAN names, descriptions and routing-instance names', () => {
    for (const evil of hostile) {
      const plan = makePlan([
        { vlanId: '10', name: evil, description: evil, vrfId: 'r2', ipv4: { network: '10.0.10.0/24', gateway: '10.0.10.1' } },
        { vlanId: '20', name: 'Plain', ipv4: { network: '10.0.20.0/24', gateway: '10.0.20.1' } },
      ], { vrfs: [TWO_VRFS.vrfs![0]!, { ...TWO_VRFS.vrfs![1]!, name: `V ${evil}` }] });
      const o = run(plan, { context: ctx({ vrfNames: { r2: evil } }) });
      expect(o.ok, JSON.stringify(evil)).toBe(true);
      const m = parseJunos(text(o));
      const all = lines(o);
      const first = [...m.vlans].find(([, v]) => v.id === 10)!;
      const instanceOk = /^[A-Za-z0-9_-]{1,64}$/.test(evil.trim());
      // vlan-id for both, [description], [l3 + irb + instance when the device name is valid], l3 + irb for VLAN 20.
      expect(all.length, JSON.stringify(evil)).toBe(2 + (first[1].description === null ? 0 : 1) + (instanceOk ? 3 : 0) + 2);
      expect(all.every(l => l.startsWith('set vlans ') || l.startsWith('set interfaces irb unit ') || l.startsWith('set routing-instances '))).toBe(true);
      expect(first[0]).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
      if (first[1].description !== null) expect(first[1].description).toBe(evil.trim());
      expect(m.vlans.size).toBe(2);
      expect([...m.vlans.values()].map(v => v.id).sort()).toEqual([10, 20]);
      // "commit" and "delete" are legal names; as names they never start a line.
      expect(forbiddenLines(text(o)), JSON.stringify(evil)).toEqual([]);
    }
  });
});

describe('large selections', () => {
  it('writes 2,000 VLANs with IRB units', () => {
    const vlans: VlanSpec[] = [];
    for (let i = 0; i < 2000; i++) {
      const base = `10.${Math.floor(i / 250)}.${i % 250}`;
      vlans.push({ id: `v${i + 1}`, vlanId: String(i + 2), name: `Seg${i + 2}`, ipv4: { network: `${base}.0/24`, gateway: `${base}.1` } });
    }
    const started = Date.now();
    const o = run(makePlan(vlans));
    const elapsed = Date.now() - started;
    const m = parseJunos(text(o));
    expect(m.vlans.size).toBe(2000);
    expect(m.units.size).toBe(2000);
    expect(m.lineCount).toBe(6000);
    expect(o.counts).toEqual({ exact: 2000, approximate: 0, unsupported: 0 });
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);
});
