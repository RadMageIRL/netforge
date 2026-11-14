/**
 * The device exports against their documented line grammars.
 *
 * 1. The grammars themselves: each accepts the documented shapes and rejects everything else, so
 *    a pass means something.
 * 2. The example plan and a few hundred seeded random plans through both generators: every line
 *    must parse, and the model read back must say what the plan says (addresses compared as
 *    numbers, DHCP leasable sets compared address by address). Expected values are worked out
 *    here from the generated numbers, not by the code under test.
 * 3. The shared device helpers in devices.ts.
 *
 * No Cisco or Juniper software is involved: this is a syntax and meaning check on paper.
 */
import { describe, expect, it } from 'vitest';
import { descriptionProblem, DESCRIPTION_MAX, duplicateVlanNumbers, GLOBAL_NONE, GLOBAL_UNSET, placeVrf, vrfsInScope, type DeviceContext } from '../../src/core/infra/devices';
import { iosConfig } from '../../src/core/infra/ios';
import { junosConfig } from '../../src/core/infra/junos';
import type { ExportOutput } from '../../src/core/infra/model';
import { resolvePlan } from '../../src/core/infra/source';
import { examplePlan } from '../../src/core/plan/example';
import type { Plan } from '../../src/core/plan/model';
import { makePlan, type VlanSpec } from '../plan-helpers';
import { forbiddenLines, GrammarError, iosLeasable, maskLength, parseIos, parseJunos, parseV4, parseV6 } from './helpers/device-grammar';

const ch = (code: number) => String.fromCharCode(code);
const WHOLE = { siteId: '', vrfId: '', namespaceId: '' };

describe('address readers of the grammar', () => {
  it('reads dotted quads strictly', () => {
    expect(parseV4('10.0.10.1')).toBe(0x0a000a01n);
    expect(parseV4('255.255.255.255')).toBe(0xffffffffn);
    for (const bad of ['10.0.10', '10.0.10.256', '010.0.0.1', '10.0.0.1 ', '1.2.3.4.5', 'a.b.c.d', '']) expect(parseV4(bad), bad).toBeNull();
  });

  it('accepts only contiguous masks', () => {
    expect(maskLength('255.255.255.0')).toBe(24);
    expect(maskLength('255.255.255.254')).toBe(31);
    expect(maskLength('0.0.0.0')).toBe(0);
    expect(maskLength('255.0.255.0')).toBeNull();
    expect(maskLength('0.0.0.255')).toBeNull();
  });

  it('reads IPv6 text', () => {
    expect(parseV6('fe80::1')).toBe((0xfe80n << 112n) | 1n);
    expect(parseV6('2001:db8:0:a::1')).toBe((0x2001n << 112n) | (0xdb8n << 96n) | (0xan << 64n) | 1n);
    expect(parseV6('::')).toBe(0n);
    expect(parseV6('1:2:3:4:5:6:7:8')).not.toBeNull();
    for (const bad of ['1:2:3:4:5:6:7', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::8', 'FE80::1', '']) expect(parseV6(bad), bad).toBeNull();
  });
});

describe('the IOS grammar is strict', () => {
  const ok = ['! header', 'vlan 10', ' name Users', '!', 'interface Vlan10', ' description Users on floor 2', ' vrf forwarding CORP', ' ip address 10.0.10.1 255.255.255.0', ' ipv6 address fe80::1 link-local', ' ipv6 address 2001:db8::1/64', '!',
    'ip dhcp excluded-address vrf CORP 10.0.10.1 10.0.10.99', 'ip dhcp excluded-address vrf CORP 10.0.10.254', 'ip dhcp pool VLAN10', ' vrf CORP', ' network 10.0.10.0 255.255.255.0', ' default-router 10.0.10.1', ' dns-server 10.0.0.53 10.0.0.54', ' domain-name corp.example', '!'];
  const withLine = (index: number, replacement: string | null, insert = false) => {
    const copy = [...ok];
    if (replacement === null) copy.splice(index, 1);
    else if (insert) copy.splice(index, 0, replacement);
    else copy[index] = replacement;
    return `${copy.join('\n')}\n`;
  };

  it('accepts the documented shapes and reads them back', () => {
    const m = parseIos(`${ok.join('\n')}\n`);
    expect(m.vlans.get(10)).toEqual({ name: 'Users' });
    expect(m.interfaces.get(10)).toEqual({ description: 'Users on floor 2', vrf: 'CORP', ip4: { address: parseV4('10.0.10.1'), length: 24 }, ip6: [{ address: parseV6('fe80::1'), length: null }, { address: parseV6('2001:db8::1'), length: 64 }] });
    const pool = m.pools.get('VLAN10')!;
    expect(pool.vrf).toBe('CORP');
    expect(pool.excluded).toHaveLength(2);
    expect(iosLeasable(pool).size).toBe(254 - 99 - 1);
  });

  it.each([
    ['a no command', 1, 'no vlan 10'],
    ['shutdown under an interface', 5, ' shutdown'],
    ['a switchport line', 5, ' switchport mode trunk'],
    ['a vrf definition', 0, 'vrf definition CORP'],
    ['a global routing command', 0, 'ip routing'],
    ['end', 0, 'end'],
    ['a second space of indentation', 2, '  name Users'],
    ['a name with a space', 2, ' name Two words'],
    ['a name of 33 characters', 2, ` name ${'x'.repeat(33)}`],
    ['VLAN 0', 1, 'vlan 0'],
    ['VLAN 4095', 1, 'vlan 4095'],
    ['VLAN 1', 1, 'vlan 1'],
    ['VLAN 1003', 1, 'vlan 1003'],
    ['a leading zero', 1, 'vlan 010'],
    ['a lowercase interface name', 4, 'interface vlan10'],
    ['a physical interface', 4, 'interface GigabitEthernet1/0/1'],
    ['a question mark in a description', 5, ' description what?'],
    ['a non-contiguous mask', 7, ' ip address 10.0.10.1 255.0.255.0'],
    ['a prefix length on ip address', 7, ' ip address 10.0.10.1/24'],
    ['a bad address', 7, ' ip address 10.0.10.999 255.255.255.0'],
    ['link-local keyword on a global address', 8, ' ipv6 address 2001:db8::1 link-local'],
    ['an IPv6 length above 128', 9, ' ipv6 address 2001:db8::1/129'],
    ['an excluded range that runs backwards', 11, 'ip dhcp excluded-address vrf CORP 10.0.10.99 10.0.10.1'],
    ['an excluded range in another VRF than its pool', 11, 'ip dhcp excluded-address 10.0.10.1 10.0.10.99'],
    ['an excluded range outside the pool network', 11, 'ip dhcp excluded-address vrf CORP 10.0.11.1 10.0.11.99'],
    ['a pool name with a space', 13, 'ip dhcp pool VLAN 10'],
    ['a network with host bits', 15, ' network 10.0.10.1 255.255.255.0'],
    ['nine DNS servers', 17, ' dns-server 1.1.1.1 1.1.1.2 1.1.1.3 1.1.1.4 1.1.1.5 1.1.1.6 1.1.1.7 1.1.1.8 1.1.1.9'],
    ['a domain with a space', 18, ' domain-name corp example'],
    ['a lease line', 18, ' lease 7'],
    ['a tab', 5, ` description a${ch(9)}b`],
    ['a non-ASCII character', 5, ` description caf${ch(0xe9)}`],
  ])('rejects %s', (_what, index, line) => {
    expect(() => parseIos(withLine(index, line))).toThrow(GrammarError);
  });

  it('rejects lines in the wrong place', () => {
    expect(() => parseIos(withLine(1, null)), 'name without vlan').toThrow(GrammarError);
    expect(() => parseIos(withLine(6, null) + ' vrf forwarding CORP\n'), 'sub-command at top level after !').toThrow(GrammarError);
    expect(() => parseIos(withLine(8, ' vrf forwarding X', true)), 'vrf forwarding after an address').toThrow(GrammarError);
    expect(() => parseIos(withLine(6, ' description late', true)), 'description after vrf').toThrow(GrammarError);
    expect(() => parseIos(withLine(15, null)), 'pool without network').toThrow(GrammarError);
    expect(() => parseIos(withLine(16, ' vrf LATE', true)), 'pool vrf after network').toThrow(GrammarError);
    expect(() => parseIos(`${ok.join('\n')}\nip dhcp excluded-address 10.0.10.3\n`), 'exclusion after its pool').toThrow(GrammarError);
    expect(() => parseIos(`${ok.join('\n')}\nvlan 10\n`), 'VLAN twice').toThrow(GrammarError);
    expect(() => parseIos(`${ok.join('\n')}\ninterface Vlan10\n ip address 10.0.10.2 255.255.255.0\n`), 'interface twice').toThrow(GrammarError);
    expect(() => parseIos(ok.join('\n')), 'no final line feed').toThrow(GrammarError);
    expect(() => parseIos(`${ok.join('\r\n')}\r\n`), 'CRLF').toThrow(GrammarError);
  });

  it('finds forbidden command words at the start of a line only', () => {
    expect(forbiddenLines('vlan 10\n no shutdown\nwrite memory\nend\n description no shutdown here\n')).toEqual([' no shutdown', 'write memory', 'end']);
    expect(forbiddenLines('set vlans commit vlan-id 5\ncommit\ndelete vlans x\n')).toEqual(['commit', 'delete vlans x']);
  });
});

describe('the Junos grammar is strict', () => {
  const ok = ['set vlans Users vlan-id 10', 'set vlans Users description "Users on floor 2"', 'set vlans Users l3-interface irb.10',
    'set interfaces irb unit 10 family inet address 10.0.10.1/24', 'set interfaces irb unit 10 family inet6 address 2001:db8::1/64', 'set routing-instances CORP interface irb.10'];
  const replaced = (index: number, line: string) => `${ok.map((l, i) => (i === index ? line : l)).join('\n')}\n`;

  it('accepts the documented shapes and reads them back', () => {
    const m = parseJunos(`${ok.join('\n')}\n`);
    expect(m.vlans.get('Users')).toEqual({ id: 10, description: 'Users on floor 2', l3: 10 });
    expect(m.units.get(10)).toEqual({ inet: [{ address: parseV4('10.0.10.1'), length: 24 }], inet6: [{ address: parseV6('2001:db8::1'), length: 64 }] });
    expect(m.instances.get('CORP')).toEqual([10]);
  });

  it.each([
    ['a comment line', 0, '# preview'],
    ['an annotation', 0, '/* preview */'],
    ['commit', 5, 'commit'],
    ['commit confirmed', 5, 'commit confirmed 5'],
    ['delete', 5, 'delete vlans Users'],
    ['deactivate', 5, 'deactivate interfaces irb unit 10'],
    ['a physical interface', 5, 'set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members Users'],
    ['an instance type', 5, 'set routing-instances CORP instance-type virtual-router'],
    ['a name starting with a digit', 0, 'set vlans 9lives vlan-id 10'],
    ['a name with a space', 0, 'set vlans Two words vlan-id 10'],
    ['a quoted name', 0, 'set vlans "Users" vlan-id 10'],
    ['VLAN ID 0', 0, 'set vlans Users vlan-id 0'],
    ['VLAN ID 4095', 0, 'set vlans Users vlan-id 4095'],
    ['an unquoted description', 1, 'set vlans Users description floor 2'],
    ['a quote inside a description', 1, 'set vlans Users description "say "hi""'],
    ['a backslash inside a description', 1, 'set vlans Users description "a\\"b"'],
    ['text after the closing quote', 1, 'set vlans Users description "x" vlan-id 99'],
    ['a question mark', 1, 'set vlans Users description "why?"'],
    ['a dotted mask', 3, 'set interfaces irb unit 10 family inet address 10.0.10.1 255.255.255.0'],
    ['an IPv4 length above 32', 3, 'set interfaces irb unit 10 family inet address 10.0.10.1/33'],
    ['an address without a length', 3, 'set interfaces irb unit 10 family inet address 10.0.10.1'],
    ['uppercase IPv6', 4, 'set interfaces irb unit 10 family inet6 address 2001:DB8::1/64'],
    ['an l3-interface on another kind of interface', 2, 'set vlans Users l3-interface vlan.10'],
    ['a trailing space', 0, 'set vlans Users vlan-id 10 '],
  ])('rejects %s', (_what, index, line) => {
    expect(() => parseJunos(replaced(index, line))).toThrow(GrammarError);
  });

  it('rejects structures that would fail a commit check', () => {
    expect(() => parseJunos('set vlans A vlan-id 10\nset vlans B vlan-id 10\n'), 'two VLANs with one ID').toThrow(GrammarError);
    expect(() => parseJunos('set vlans A vlan-id 10\nset vlans A vlan-id 11\n'), 'two IDs for one VLAN').toThrow(GrammarError);
    expect(() => parseJunos('set vlans A vlan-id 10\nset vlans A l3-interface irb.10\n'), 'l3-interface without the unit').toThrow(GrammarError);
    expect(() => parseJunos('set vlans A description "x"\n'), 'description without vlan-id').toThrow(GrammarError);
    expect(() => parseJunos('set routing-instances R interface irb.10\n'), 'instance without the unit').toThrow(GrammarError);
    expect(() => parseJunos(`${ok.join('\n')}\nset routing-instances OTHER interface irb.10\n`), 'unit in two instances').toThrow(GrammarError);
    expect(() => parseJunos(`${ok.join('\n')}\nset interfaces irb unit 10 family inet address 10.0.10.2/24\n`), 'two IPv4 addresses').toThrow(GrammarError);
    expect(() => parseJunos(ok.join('\n')), 'no final line feed').toThrow(GrammarError);
  });
});

describe('the example plan', () => {
  const plan = examplePlan();
  const context: DeviceContext = { scope: { siteId: 's1', vrfId: '', namespaceId: '' }, globalVrfId: 'r1', vrfNames: { r2: 'GUEST' } };

  it('as IOS: six VLANs, five interfaces, three pools, all read back', () => {
    const o = iosConfig(plan, { context, sections: { vlans: true, svis: true, dhcp: true }, dnsServers: '10.10.30.10', dnsDomain: 'corp.example' });
    const m = parseIos(o.files[0]!.text);
    expect([...m.vlans.keys()]).toEqual([10, 20, 30, 40, 99, 200]);
    expect([...m.interfaces.keys()]).toEqual([10, 20, 30, 99, 200]);
    expect(m.interfaces.get(200)!.vrf).toBe('GUEST');
    expect(m.interfaces.get(30)!.ip4).toEqual({ address: parseV4('10.10.30.1'), length: 25 });
    expect([...m.pools.keys()]).toEqual(['VLAN10', 'VLAN20', 'VLAN200']);
    const leasable = iosLeasable(m.pools.get('VLAN10')!);
    expect(leasable.size).toBe(151);
    expect(Math.min(...[...leasable].map(Number))).toBe(Number(parseV4('10.10.10.100')));
    expect(Math.max(...[...leasable].map(Number))).toBe(Number(parseV4('10.10.10.250')));
    expect(forbiddenLines(o.files[0]!.text)).toEqual([]);
    expect(o.counts).toEqual({ exact: 4, approximate: 2, unsupported: 0 });
  });

  it('as Junos: six VLANs, five IRB units, one routing instance', () => {
    const o = junosConfig(plan, { context, sections: { vlans: true, irb: true } });
    const m = parseJunos(o.files[0]!.text);
    expect([...m.vlans.keys()]).toEqual(['Users', 'Voice', 'Servers', 'Cameras', 'Management', 'Guest']);
    expect([...m.units.keys()]).toEqual([10, 20, 30, 99, 200]);
    expect(m.instances).toEqual(new Map([['GUEST', [200]]]));
    expect(m.vlans.get('Cameras')!.l3).toBeNull();
    expect(forbiddenLines(o.files[0]!.text)).toEqual([]);
  });

  it('both sites at once: the VLAN IDs the two namespaces share are written for neither', () => {
    const all: DeviceContext = { ...context, scope: WHOLE, vrfNames: { r2: 'GUEST', r3: 'GUEST-B' } };
    const o = iosConfig(plan, { context: all, sections: { vlans: true, svis: true, dhcp: true }, dnsServers: '', dnsDomain: '' });
    const m = parseIos(o.files[0]!.text);
    expect([...m.vlans.keys()]).toEqual([30, 40, 50, 99]);
    expect(o.counts.unsupported).toBe(6);
  });
});

// ---- Seeded random plans ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Expected {
  readonly id: string;
  readonly n: number;
  readonly vrf: string;
  readonly net: { address: bigint; length: number } | null;
  readonly gateway: bigint | null;
  readonly pools: readonly (readonly [bigint, bigint])[];
  readonly v6: { prefix: bigint; gateway: 'none' | 'link-local' | 'global' } | null;
  readonly duplicate: boolean;
}

const NAMES = ['Users', 'Voice', 'Guest Wifi', 'guest_wifi', 'Lab/1', '', 'Servers', 'default', 'x'.repeat(40), 'Printers', 'Cameras 2', 'DMZ', 'mgmt', 'Wifi-Staff', 'IoT.devices'];
const DESCRIPTIONS = ['', '', 'Plain text', 'why?', 'quote "x"', 'back\\slash', 'ok (floor 2)', `line${ch(10)}break`];
const dotted = (v: bigint) => [24n, 16n, 8n, 0n].map(s => String((v >> s) & 255n)).join('.');

function randomPlan(seed: number): { plan: Plan; expected: Expected[]; context: DeviceContext } {
  const r = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(list: readonly T[]): T => list[int(0, list.length - 1)]!;
  const count = int(2, 12);
  const twoNamespaces = r() < 0.25;
  const used = new Set<number>();
  const specs: VlanSpec[] = [];
  const expected: Expected[] = [];
  for (let i = 0; i < count; i++) {
    let n: number;
    do {
      const roll = r();
      n = roll < 0.06 ? 1 : roll < 0.12 ? int(1002, 1005) : roll < 0.25 ? int(1006, 4094) : int(2, 1001);
    } while (used.has(n));
    used.add(n);
    const vrf = pick(['r1', 'r1', 'r2', 'r3']);
    const roll = r();
    const length = roll < 0.65 ? int(24, 30) : roll < 0.72 ? 31 : roll < 0.78 ? 32 : 0;
    const address = (10n << 24n) | (BigInt(i + 1) << 16n) | (BigInt(int(0, 255)) << 8n);
    const net = length === 0 ? null : { address, length };
    let gateway: bigint | null = null;
    const pools: [bigint, bigint][] = [];
    if (net) {
      const size = 1n << BigInt(32 - length);
      if (length <= 30) {
        if (r() < 0.75) gateway = address + BigInt(int(1, Number(size) - 2));
        if (r() < 0.65) {
          let open: bigint | null = null;
          for (let a = address + 1n; a <= address + size - 2n && pools.length < 3; a++) {
            if (a === gateway) { if (open !== null) { pools.push([open, a - 1n]); open = null; } continue; }
            if (open === null && r() < 0.12) open = a;
            else if (open !== null && r() < 0.1) { pools.push([open, a]); open = null; a++; }
          }
          if (open !== null && pools.length < 3) pools.push([open, address + size - 2n]);
        }
      } else if (r() < 0.7) gateway = length === 32 ? address : address + BigInt(int(0, 1));
    }
    const v6Roll = r();
    const prefix = (0x20010db8n << 96n) | (BigInt(i + 1) << 80n) | (BigInt(int(0, 0xffff)) << 64n);
    const v6: Expected['v6'] = v6Roll < 0.4 ? { prefix, gateway: pick(['none', 'link-local', 'global'] as const) } : null;
    const hex = (v: bigint) => [112n, 96n, 80n, 64n].map(s => ((v >> s) & 0xffffn).toString(16)).join(':');
    const id = `v${i + 1}`;
    specs.push({
      id, vlanId: String(n), name: pick(NAMES), description: pick(DESCRIPTIONS), vrfId: vrf, namespaceId: 'n1',
      ipv4: { network: net ? `${dotted(net.address)}/${net.length}` : '', gateway: gateway === null ? '' : dotted(gateway), dhcp: pools.map(([a, b]) => (a === b ? dotted(a) : `${dotted(a)} - ${dotted(b)}`)) },
      ipv6: v6 ? { prefixes: [`${hex(v6.prefix)}::/64`], gateway: v6.gateway === 'none' ? '' : v6.gateway === 'link-local' ? 'fe80::1' : `${hex(v6.prefix)}::1` } : {},
    });
    expected.push({ id, n, vrf, net, gateway, pools, v6, duplicate: false });
  }
  if (twoNamespaces) {
    const twin = expected[0]!;
    const id = `v${count + 1}`;
    specs.push({ id, vlanId: String(twin.n), name: 'Twin', vrfId: 'r1', namespaceId: 'n2' });
    expected[0] = { ...twin, duplicate: true };
    expected.push({ id, n: twin.n, vrf: 'r1', net: null, gateway: null, pools: [], v6: null, duplicate: true });
  }
  const plan = makePlan(specs, {
    vrfs: [
      { id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: '', notes: '' },
      { id: 'r2', name: 'Blue', siteId: '', exchangesWith: [], description: '', notes: '' },
      { id: 'r3', name: 'Red zone', siteId: '', exchangesWith: [], description: '', notes: '' },
    ],
    namespaces: [{ id: 'n1', name: 'Core', siteId: 's1', description: '' }, { id: 'n2', name: 'Lab', siteId: 's1', description: '' }],
  });
  const vrfNames: Record<string, string> = {};
  if (r() < 0.8) vrfNames.r1 = 'CORP';
  if (r() < 0.8) vrfNames.r2 = pick(['BLUE', 'blue-1', 'B_2']);
  if (r() < 0.8) vrfNames.r3 = pick(['RED', 'Red zone', 'red?', 'RED-3']);
  const context: DeviceContext = { scope: WHOLE, globalVrfId: pick([GLOBAL_UNSET, GLOBAL_NONE, 'r1', 'r1', 'r2']), vrfNames };
  return { plan, expected, context };
}

type Placement = { kind: 'global' } | { kind: 'named'; name: string } | { kind: 'unknown' };
function expectedPlacement(e: Expected, context: DeviceContext, valid: RegExp): Placement {
  if (context.globalVrfId === GLOBAL_UNSET) return { kind: 'unknown' };
  if (context.globalVrfId === e.vrf) return { kind: 'global' };
  const name = (context.vrfNames[e.vrf] ?? '').trim();
  return valid.test(name) ? { kind: 'named', name } : { kind: 'unknown' };
}
const hostBits = (e: Expected) => e.net !== null && e.net.length < 32;
const v6Address = (e: Expected): { address: bigint; linkLocal: boolean } | null =>
  e.v6 === null || e.v6.gateway === 'none' ? null : e.v6.gateway === 'link-local' ? { address: (0xfe80n << 112n) | 1n, linkLocal: true } : { address: e.v6.prefix | 1n, linkLocal: false };

function accountIsComplete(o: ExportOutput, total: number): void {
  expect(o.items.length + o.skipped.length).toBe(total);
  expect(o.counts.exact + o.counts.approximate + o.counts.unsupported).toBe(o.items.length);
  for (const item of o.items) {
    expect(item.fidelity === 'unsupported').toBe(item.written.length === 0);
    if (item.fidelity === 'exact') expect(item.notes).toEqual([]);
    if (item.fidelity === 'approximate') expect(item.notes.length).toBeGreaterThan(0);
  }
}

describe('seeded random plans', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => 1000 + i * 7919);

  it('the generator makes plans without errors', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const { plan } = randomPlan(seed);
      const resolved = resolvePlan(plan);
      expect(resolved.ok, `seed ${seed}: ${resolved.ok ? '' : resolved.refusals.join(' / ')}`).toBe(true);
    }
  });

  it('IOS output parses and says what the plan says', () => {
    let pools = 0;
    let interfaces = 0;
    for (const seed of SEEDS) {
      const { plan, expected, context } = randomPlan(seed);
      const o = iosConfig(plan, { context, sections: { vlans: true, svis: true, dhcp: true }, dnsServers: '', dnsDomain: '' });
      const where = `seed ${seed}`;
      const writable = expected.filter(e => !e.duplicate && !(e.n >= 1002 && e.n <= 1005));
      if (!o.ok) {
        expect(o.files, where).toEqual([]);
        continue;
      }
      const text = o.files[0]!.text;
      const m = parseIos(text);
      expect(forbiddenLines(text), where).toEqual([]);
      accountIsComplete(o, expected.length);
      expect([...m.vlans.keys()].sort((a, b) => a - b), where).toEqual(writable.filter(e => e.n !== 1).map(e => e.n).sort((a, b) => a - b));
      const wantInterfaces = new Map<number, Expected>();
      const wantPools = new Map<string, Expected>();
      for (const e of writable) {
        const place = expectedPlacement(e, context, /^[A-Za-z0-9_.-]{1,32}$/);
        const six = v6Address(e);
        const four = e.gateway !== null && hostBits(e);
        if ((four || six !== null) && place.kind !== 'unknown') wantInterfaces.set(e.n, e);
        if (e.pools.length > 0 && place.kind !== 'unknown') wantPools.set(`VLAN${e.n}`, e);
      }
      expect([...m.interfaces.keys()].sort((a, b) => a - b), where).toEqual([...wantInterfaces.keys()].sort((a, b) => a - b));
      expect([...m.pools.keys()].sort(), where).toEqual([...wantPools.keys()].sort());
      for (const [n, e] of wantInterfaces) {
        const itf = m.interfaces.get(n)!;
        const place = expectedPlacement(e, context, /^[A-Za-z0-9_.-]{1,32}$/);
        expect(itf.vrf, where).toBe(place.kind === 'named' ? place.name : null);
        expect(itf.ip4, where).toEqual(e.gateway !== null && hostBits(e) ? { address: e.gateway, length: e.net!.length } : null);
        const six = v6Address(e);
        expect(itf.ip6, where).toEqual(six === null ? [] : [{ address: six.address, length: six.linkLocal ? null : 64 }]);
        interfaces++;
      }
      for (const [name, e] of wantPools) {
        const pool = m.pools.get(name)!;
        const place = expectedPlacement(e, context, /^[A-Za-z0-9_.-]{1,32}$/);
        expect(pool.vrf, where).toBe(place.kind === 'named' ? place.name : null);
        expect(pool.network, where).toEqual(e.net);
        expect(pool.router, where).toBe(e.gateway);
        const want = new Set<bigint>();
        for (const [a, b] of e.pools) for (let x = a; x <= b; x++) want.add(x);
        const got = iosLeasable(pool);
        expect(got.size, where).toBe(want.size);
        for (const x of want) expect(got.has(x), `${where}: ${dotted(x)}`).toBe(true);
        pools++;
      }
    }
    expect(pools).toBeGreaterThan(150);
    expect(interfaces).toBeGreaterThan(400);
  });

  it('Junos output parses and says what the plan says', () => {
    let units = 0;
    let instances = 0;
    for (const seed of SEEDS) {
      const { plan, expected, context } = randomPlan(seed);
      const o = junosConfig(plan, { context, sections: { vlans: true, irb: true } });
      const where = `seed ${seed}`;
      if (!o.ok) {
        expect(o.files, where).toEqual([]);
        continue;
      }
      const text = o.files[0]!.text;
      const m = parseJunos(text);
      expect(forbiddenLines(text), where).toEqual([]);
      accountIsComplete(o, expected.length);
      const writable = expected.filter(e => !e.duplicate && e.n !== 1);
      const byId = new Map([...m.vlans].map(([name, v]) => [v.id!, { name, v }]));
      const unsupported = o.items.filter(i => i.fidelity === 'unsupported').length;
      // Every writable VLAN is either written or reported as unsupported (a name collision).
      expect(byId.size + unsupported, where).toBe(expected.length - o.skipped.length);
      for (const n of byId.keys()) expect(writable.some(e => e.n === n), where).toBe(true);
      for (const e of writable) {
        const got = byId.get(e.n);
        if (!got) continue;
        expect(got.name, where).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
        const place = expectedPlacement(e, context, /^[A-Za-z0-9_-]{1,64}$/);
        const six = v6Address(e);
        const four = e.gateway !== null && hostBits(e);
        const wantUnit = (four || six !== null) && place.kind !== 'unknown';
        expect(m.units.has(e.n), `${where} VLAN ${e.n}`).toBe(wantUnit);
        expect(got.v.l3, where).toBe(wantUnit ? e.n : null);
        if (!wantUnit) continue;
        const unit = m.units.get(e.n)!;
        expect(unit.inet, where).toEqual(four ? [{ address: e.gateway!, length: e.net!.length }] : []);
        expect(unit.inet6, where).toEqual(six === null ? [] : [{ address: six.address, length: 64 }]);
        const holder = [...m.instances].find(([, list]) => list.includes(e.n))?.[0] ?? null;
        expect(holder, where).toBe(place.kind === 'named' ? place.name : null);
        units++;
        if (holder !== null) instances++;
      }
      expect(m.units.size, where).toBe([...byId.values()].filter(x => x.v.l3 !== null).length);
    }
    expect(units).toBeGreaterThan(400);
    expect(instances).toBeGreaterThan(80);
  });
});

// ---- devices.ts ------------------------------------------------------------------------------

describe('device helpers', () => {
  const plan = makePlan([
    { vlanId: '10', name: 'A', vrfId: 'r1' }, { vlanId: '20', name: 'B', vrfId: 'r2' }, { vlanId: '10', name: 'C', vrfId: 'r1', namespaceId: 'n2' },
    { vlanId: '30', name: 'D', vrfId: 'r2', siteId: 's2', namespaceId: 'n3' },
  ], {
    sites: [{ id: 's1', name: 'One', description: '', notes: '', blocks: [] }, { id: 's2', name: 'Two', description: '', notes: '', blocks: [] }],
    vrfs: [
      { id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: '', notes: '' },
      { id: 'r2', name: '  Guest net ', siteId: '', exchangesWith: [], description: '', notes: '' },
      { id: 'r3', name: 'Unused', siteId: '', exchangesWith: [], description: '', notes: '' },
    ],
    namespaces: [{ id: 'n1', name: 'Core', siteId: 's1', description: '' }, { id: 'n2', name: 'Lab', siteId: 's1', description: '' }, { id: 'n3', name: 'Two', siteId: 's2', description: '' }],
  });
  const resolved = resolvePlan(plan);
  if (!resolved.ok) throw new Error(resolved.refusals.join(' / '));
  const [a, b, c, d] = resolved.value.vlans;
  const NAME = /^[A-Za-z0-9_-]+$/;
  const context = (over: Partial<DeviceContext>): DeviceContext => ({ scope: WHOLE, globalVrfId: 'r1', vrfNames: {}, ...over });

  it('places a VLAN in the global table, a named VRF, or nowhere yet', () => {
    expect(placeVrf(a!, context({}), NAME, 8, 'name')).toEqual({ kind: 'global' });
    expect(placeVrf(b!, context({ vrfNames: { r2: ' GUEST ' } }), NAME, 8, 'name')).toEqual({ kind: 'named', name: 'GUEST' });
    expect(placeVrf(b!, context({ vrfNames: { r2: '12345678' } }), NAME, 8, 'name').kind).toBe('named');
    const unknown: Partial<DeviceContext>[] = [{ globalVrfId: GLOBAL_UNSET, vrfNames: { r1: 'X', r2: 'Y' } }, {}, { vrfNames: { r2: '' } }, { vrfNames: { r2: '123456789' } }, { vrfNames: { r2: 'a b' } }, { vrfNames: { r1: 'OTHER' } }];
    for (const over of unknown) {
      const p = placeVrf(b!, context(over), NAME, 8, 'name');
      expect(p.kind, JSON.stringify(over)).toBe('unknown');
      if (p.kind === 'unknown') expect(p.reason.length).toBeGreaterThan(10);
    }
    expect(placeVrf(a!, context({ globalVrfId: GLOBAL_NONE }), NAME, 8, 'name').kind).toBe('unknown');
    expect(placeVrf(a!, context({ globalVrfId: GLOBAL_NONE, vrfNames: { r1: 'CORP' } }), NAME, 8, 'name')).toEqual({ kind: 'named', name: 'CORP' });
    expect(placeVrf(a!, context({ globalVrfId: 'r2', vrfNames: { r1: 'CORP' } }), NAME, 8, 'name')).toEqual({ kind: 'named', name: 'CORP' });
    expect(placeVrf({ ...a!, vrf: null }, context({}), NAME, 8, 'name').kind).toBe('unknown');
  });

  it('checks description text', () => {
    const none = /[\\]/;
    expect(descriptionProblem('Plain text ~!@#$%^&*()', none, 'x')).toBeNull();
    expect(descriptionProblem('d'.repeat(DESCRIPTION_MAX), none, 'x')).toBeNull();
    expect(descriptionProblem('d'.repeat(DESCRIPTION_MAX + 1), none, 'x')).not.toBeNull();
    expect(descriptionProblem('a\\b', none, 'a backslash')).toContain('a backslash');
    for (const code of [0, 9, 10, 13, 27, 127, 0x80, 0x85, 0xa0, 0xe9, 0x2028, 0x2029, 0xfeff]) expect(descriptionProblem(`a${ch(code)}b`, none, 'x'), String(code)).not.toBeNull();
  });

  it('finds VLAN IDs that appear more than once', () => {
    const twice = duplicateVlanNumbers(resolved.value.vlans);
    expect([...twice.keys()]).toEqual([10]);
    expect(twice.get(10)!.map(v => v.vlan.id)).toEqual([a!.vlan.id, c!.vlan.id]);
    expect(duplicateVlanNumbers([a!, b!, d!]).size).toBe(0);
    expect(duplicateVlanNumbers([{ ...a!, number: null }, { ...c!, number: null }]).size).toBe(0);
  });

  it('lists the VRFs a scope uses, in plan order, with trimmed names', () => {
    expect(vrfsInScope(plan, WHOLE)).toEqual([{ id: 'r1', name: 'Global' }, { id: 'r2', name: 'Guest net' }]);
    expect(vrfsInScope(plan, { ...WHOLE, siteId: 's2' })).toEqual([{ id: 'r2', name: 'Guest net' }]);
    expect(vrfsInScope(plan, { ...WHOLE, namespaceId: 'n2' })).toEqual([{ id: 'r1', name: 'Global' }]);
    expect(vrfsInScope(plan, { ...WHOLE, vrfId: 'r2', siteId: 's1' })).toEqual([{ id: 'r2', name: 'Guest net' }]);
    expect(vrfsInScope(plan, { ...WHOLE, vrfId: 'r3' })).toEqual([]);
    const unnamed = makePlan([{ vlanId: '10', name: 'A' }], { vrfs: [{ id: 'r1', name: '   ', siteId: '', exchangesWith: [], description: '', notes: '' }] });
    expect(vrfsInScope(unnamed, WHOLE)).toEqual([{ id: 'r1', name: 'r1' }]);
  });
});
