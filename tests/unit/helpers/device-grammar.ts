/**
 * Strict line grammars for the two device export targets, written from the vendors' documented
 * command syntax and independent of the generators (own address parsers, own structure rules).
 * Each parser accepts only the line shapes the exports are allowed to produce, checks where a
 * line may appear, and reads the lines back into a small model that tests compare with the plan.
 *
 * This is a documented-syntax check, not device validation: no Cisco or Juniper software has
 * read this output.
 */

export class GrammarError extends Error {
  constructor(readonly lineNumber: number, readonly line: string, why: string) {
    super(`line ${lineNumber}: ${why}: ${JSON.stringify(line)}`);
  }
}

// ---- Addresses (independent of src/core/net) ---------------------------------------------------

export function parseV4(text: string): bigint | null {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!m) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    value = value * 256n + BigInt(octet);
  }
  return value;
}

/** The prefix length of a contiguous dotted mask, or null. */
export function maskLength(text: string): number | null {
  const value = parseV4(text);
  if (value === null) return null;
  const bits = value.toString(2).padStart(32, '0');
  const m = /^(1*)(0*)$/.exec(bits);
  return m ? m[1]!.length : null;
}

/** Lowercase hex groups with at most one "::"; no embedded IPv4, no zone. */
export function parseV6(text: string): bigint | null {
  if (!/^[0-9a-f:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === '') return [];
    const list = part.split(':');
    return list.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? list : null;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || tail === null) return null;
  let all: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    all = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  } else all = head;
  if (all.length !== 8) return null;
  return all.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const TOKEN = '[A-Za-z0-9_.-]+';
const DNS_NAME = '[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*';

// ---- Cisco IOS / IOS-XE ----------------------------------------------------------------------

export interface V4Net {
  readonly address: bigint;
  readonly length: number;
}

export interface IosInterface {
  description: string | null;
  vrf: string | null;
  ip4: V4Net | null;
  /** length is null for a link-local address written with the link-local keyword. */
  ip6: { address: bigint; length: number | null }[];
}

export interface IosPool {
  vrf: string | null;
  network: V4Net | null;
  router: bigint | null;
  dns: bigint[];
  domain: string | null;
  /** The excluded-address lines written immediately before this pool. */
  excluded: { vrf: string | null; first: bigint; last: bigint }[];
}

export interface IosModel {
  readonly lineCount: number;
  readonly comments: number;
  readonly vlans: Map<number, { name: string | null }>;
  readonly interfaces: Map<number, IosInterface>;
  readonly pools: Map<string, IosPool>;
}

/** Command words that must never start a line of either export. */
const FORBIDDEN = /^\s*(no\s|no$|shutdown|write|wr\s|end$|exit$|copy|reload|erase|switchport|vrf definition|ip routing|ipv6 unicast-routing|configure|commit|delete|deactivate|rollback|request|run\s|start\s|load\s)/;

export function forbiddenLines(text: string): string[] {
  return text.split('\n').filter(line => FORBIDDEN.test(line));
}

export function parseIos(text: string): IosModel {
  if (!text.endsWith('\n')) throw new GrammarError(0, '', 'the text must end with a line feed');
  const lines = text.slice(0, -1).split('\n');
  const model: IosModel = { lineCount: lines.length, comments: 0, vlans: new Map(), interfaces: new Map(), pools: new Map() };
  type Context = { kind: 'top' } | { kind: 'vlan'; id: number } | { kind: 'interface'; value: IosInterface; addressSeen: boolean } | { kind: 'pool'; value: IosPool };
  let context: Context = { kind: 'top' };
  let pending: { vrf: string | null; first: bigint; last: bigint }[] = [];
  const closePool = (n: number, line: string) => {
    if (context.kind === 'pool' && context.value.network === null) throw new GrammarError(n, line, 'a DHCP pool ended without a network line');
  };

  lines.forEach((line, index) => {
    const n = index + 1;
    const bad = (why: string): never => { throw new GrammarError(n, line, why); };
    if (/[^ -~]/.test(line)) bad('a character outside printable ASCII');
    if (line.includes('?')) bad('a question mark (the CLI help key)');
    let m: RegExpExecArray | null;
    if (line === '!' || /^! [ -~]*$/.test(line)) {
      closePool(n, line);
      (model as { comments: number }).comments++;
      context = { kind: 'top' };
      return;
    }
    if (line.startsWith(' ')) {
      if (context.kind === 'vlan') {
        m = new RegExp(`^ name (${TOKEN})$`).exec(line);
        if (!m) bad('not a VLAN sub-command');
        if (m![1]!.length > 32) bad('a VLAN name longer than 32 characters');
        const vlan = model.vlans.get(context.id)!;
        if (vlan.name !== null) bad('a second name line');
        vlan.name = m![1]!;
        return;
      }
      if (context.kind === 'interface') {
        const itf = context.value;
        if ((m = /^ description ([ -~]+)$/.exec(line))) {
          if (itf.description !== null || itf.vrf !== null || context.addressSeen) bad('description must be the first line of the interface and appear once');
          if (m[1]!.length > 240) bad('a description longer than IOS accepts');
          itf.description = m[1]!;
          return;
        }
        if ((m = new RegExp(`^ vrf forwarding (${TOKEN})$`).exec(line))) {
          if (context.addressSeen) bad('vrf forwarding after an address line would remove the address');
          if (itf.vrf !== null) bad('a second vrf forwarding line');
          if (m[1]!.length > 32) bad('a VRF name longer than 32 characters');
          itf.vrf = m[1]!;
          return;
        }
        if ((m = /^ ip address (\S+) (\S+)$/.exec(line))) {
          const address = parseV4(m[1]!);
          const length = maskLength(m[2]!);
          if (address === null || length === null) bad('a bad IPv4 address or mask');
          if (itf.ip4 !== null) bad('a second primary IPv4 address');
          if (context.addressSeen && itf.ip6.length > 0) bad('ip address after ipv6 address');
          itf.ip4 = { address: address!, length: length! };
          context.addressSeen = true;
          return;
        }
        if ((m = /^ ipv6 address (\S+) link-local$/.exec(line))) {
          const address = parseV6(m[1]!);
          if (address === null) bad('a bad IPv6 address');
          if (address! >> 118n !== 0x3fan) bad('a link-local keyword on an address outside fe80::/10');
          if (itf.ip6.some(a => a.length === null)) bad('a second link-local address');
          itf.ip6.push({ address: address!, length: null });
          context.addressSeen = true;
          return;
        }
        if ((m = /^ ipv6 address ([^\s/]+)\/([0-9]{1,3})$/.exec(line))) {
          const address = parseV6(m[1]!);
          const length = Number(m[2]);
          if (address === null || length > 128) bad('a bad IPv6 address or prefix length');
          itf.ip6.push({ address: address!, length });
          context.addressSeen = true;
          return;
        }
        return bad('not an interface sub-command');
      }
      if (context.kind === 'pool') {
        const pool = context.value;
        if ((m = new RegExp(`^ vrf (${TOKEN})$`).exec(line))) {
          if (pool.vrf !== null || pool.network !== null) bad('vrf must come first in a pool and appear once');
          pool.vrf = m[1]!;
          return;
        }
        if ((m = /^ network (\S+) (\S+)$/.exec(line))) {
          const address = parseV4(m[1]!);
          const length = maskLength(m[2]!);
          if (address === null || length === null) bad('a bad network or mask');
          if (pool.network !== null) bad('a second network line');
          if (length! < 32 && (address! & ((1n << BigInt(32 - length!)) - 1n)) !== 0n) bad('host bits set in a pool network');
          pool.network = { address: address!, length: length! };
          return;
        }
        if (pool.network === null) bad('a pool option before the network line');
        if ((m = /^ default-router (\S+)$/.exec(line))) {
          const address = parseV4(m[1]!);
          if (address === null || pool.router !== null) bad('a bad or repeated default-router');
          pool.router = address!;
          return;
        }
        if ((m = /^ dns-server (\S+( \S+){0,7})$/.exec(line))) {
          const list = m[1]!.split(' ').map(parseV4);
          if (list.some(a => a === null) || pool.dns.length > 0) bad('a bad or repeated dns-server line');
          pool.dns = list as bigint[];
          return;
        }
        if ((m = new RegExp(`^ domain-name (${DNS_NAME})$`).exec(line))) {
          if (pool.domain !== null) bad('a second domain-name line');
          pool.domain = m[1]!;
          return;
        }
        return bad('not a DHCP pool sub-command');
      }
      return bad('an indented line outside a vlan, interface or pool');
    }
    // Top-level commands.
    closePool(n, line);
    if ((m = /^vlan ([1-9][0-9]{0,3})$/.exec(line))) {
      const id = Number(m[1]);
      if (id > 4094) bad('a VLAN ID above 4094');
      if (id === 1 || (id >= 1002 && id <= 1005)) bad('a VLAN that cannot be created on IOS');
      if (model.vlans.has(id)) bad('the VLAN is declared twice');
      model.vlans.set(id, { name: null });
      context = { kind: 'vlan', id };
      return;
    }
    if ((m = /^interface Vlan([1-9][0-9]{0,3})$/.exec(line))) {
      const id = Number(m[1]);
      if (id > 4094) bad('a VLAN interface above 4094');
      if (model.interfaces.has(id)) bad('the interface appears twice');
      const value: IosInterface = { description: null, vrf: null, ip4: null, ip6: [] };
      model.interfaces.set(id, value);
      context = { kind: 'interface', value, addressSeen: false };
      return;
    }
    if ((m = new RegExp(`^ip dhcp excluded-address(?: vrf (${TOKEN}))? (\\S+)(?: (\\S+))?$`).exec(line))) {
      const first = parseV4(m[2]!);
      const last = m[3] === undefined ? first : parseV4(m[3]);
      if (first === null || last === null) bad('a bad excluded address');
      if (m[3] !== undefined && last! <= first!) bad('an excluded range whose high address is not above its low address');
      pending.push({ vrf: m[1] ?? null, first: first!, last: last! });
      context = { kind: 'top' };
      return;
    }
    if ((m = new RegExp(`^ip dhcp pool (${TOKEN})$`).exec(line))) {
      if (model.pools.has(m[1]!)) bad('the pool appears twice');
      const value: IosPool = { vrf: null, network: null, router: null, dns: [], domain: null, excluded: pending };
      pending = [];
      model.pools.set(m[1]!, value);
      context = { kind: 'pool', value };
      return;
    }
    return bad('not a line this export may write');
  });
  closePool(lines.length, lines[lines.length - 1] ?? '');
  if (pending.length > 0) throw new GrammarError(lines.length, '', 'excluded addresses that no pool follows');
  // Each excluded range belongs to the pool that follows it: same VRF, inside the pool network.
  for (const [name, pool] of model.pools) {
    const net = pool.network!;
    const size = 1n << BigInt(32 - net.length);
    pool.excluded.forEach(e => {
      if (e.vrf !== pool.vrf) throw new GrammarError(0, name, 'an excluded range in a different VRF than its pool');
      if (e.first < net.address || e.last >= net.address + size) throw new GrammarError(0, name, 'an excluded range outside its pool network');
    });
    // No pool may lease addresses of a pool written before it whose exclusions came later.
    for (const [otherName, other] of model.pools) {
      if (otherName === name || other.vrf !== pool.vrf) continue;
      const o = other.network!;
      const oSize = 1n << BigInt(32 - o.length);
      if (net.address < o.address + oSize && o.address < net.address + size) throw new GrammarError(0, name, 'two pools in one VRF overlap');
    }
  }
  return model;
}

/** The addresses an IOS pool can lease: the network's hosts minus its excluded ranges. */
export function iosLeasable(pool: IosPool): Set<bigint> {
  const net = pool.network!;
  const size = 1n << BigInt(32 - net.length);
  const out = new Set<bigint>();
  for (let a = net.address + 1n; a < net.address + size - 1n; a++) {
    if (!pool.excluded.some(e => a >= e.first && a <= e.last)) out.add(a);
  }
  return out;
}

// ---- Juniper Junos (set commands, ELS) ---------------------------------------------------------

export interface JunosVlan {
  id: number | null;
  description: string | null;
  l3: number | null;
}

export interface JunosModel {
  readonly lineCount: number;
  readonly vlans: Map<string, JunosVlan>;
  readonly units: Map<number, { inet: V4Net[]; inet6: { address: bigint; length: number }[] }>;
  /** Routing instance name to the IRB units it holds. */
  readonly instances: Map<string, number[]>;
}

const JUNOS_VLAN = '[A-Za-z][A-Za-z0-9_-]*';
const JUNOS_INSTANCE = '[A-Za-z0-9_-]+';

export function parseJunos(text: string): JunosModel {
  if (!text.endsWith('\n')) throw new GrammarError(0, '', 'the text must end with a line feed');
  const lines = text.slice(0, -1).split('\n');
  const model: JunosModel = { lineCount: lines.length, vlans: new Map(), units: new Map(), instances: new Map() };
  const vlan = (name: string): JunosVlan => {
    let v = model.vlans.get(name);
    if (!v) { v = { id: null, description: null, l3: null }; model.vlans.set(name, v); }
    return v;
  };
  const unit = (n: number) => {
    let u = model.units.get(n);
    if (!u) { u = { inet: [], inet6: [] }; model.units.set(n, u); }
    return u;
  };
  lines.forEach((line, index) => {
    const n = index + 1;
    const bad = (why: string): never => { throw new GrammarError(n, line, why); };
    if (/[^ -~]/.test(line)) bad('a character outside printable ASCII');
    if (line.includes('?')) bad('a question mark (the CLI help key)');
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^set vlans (${JUNOS_VLAN}) vlan-id ([1-9][0-9]{0,3})$`).exec(line))) {
      const id = Number(m[2]);
      if (id > 4094) bad('a VLAN ID above 4094');
      const v = vlan(m[1]!);
      if (v.id !== null) bad('a second vlan-id for the VLAN');
      if (m[1]!.length > 255) bad('a VLAN name longer than Junos accepts');
      v.id = id;
      return;
    }
    if ((m = new RegExp(`^set vlans (${JUNOS_VLAN}) description "([^"\\\\]*)"$`).exec(line))) {
      const v = vlan(m[1]!);
      if (v.id === null) bad('a description before the vlan-id line');
      if (v.description !== null) bad('a second description');
      if (m[2] === '') bad('an empty description');
      v.description = m[2]!;
      return;
    }
    if ((m = new RegExp(`^set vlans (${JUNOS_VLAN}) l3-interface irb\\.([1-9][0-9]{0,4})$`).exec(line))) {
      const v = vlan(m[1]!);
      if (v.id === null) bad('an l3-interface before the vlan-id line');
      if (v.l3 !== null) bad('a second l3-interface');
      v.l3 = Number(m[2]);
      return;
    }
    if ((m = /^set interfaces irb unit ([1-9][0-9]{0,4}) family inet address ([^\s/]+)\/([0-9]{1,2})$/.exec(line))) {
      const address = parseV4(m[2]!);
      const length = Number(m[3]);
      if (address === null || length > 32) bad('a bad IPv4 address or prefix length');
      unit(Number(m[1])).inet.push({ address: address!, length });
      return;
    }
    if ((m = /^set interfaces irb unit ([1-9][0-9]{0,4}) family inet6 address ([^\s/]+)\/([0-9]{1,3})$/.exec(line))) {
      const address = parseV6(m[2]!);
      const length = Number(m[3]);
      if (address === null || length > 128) bad('a bad IPv6 address or prefix length');
      unit(Number(m[1])).inet6.push({ address: address!, length });
      return;
    }
    if ((m = new RegExp(`^set routing-instances (${JUNOS_INSTANCE}) interface irb\\.([1-9][0-9]{0,4})$`).exec(line))) {
      const list = model.instances.get(m[1]!) ?? [];
      list.push(Number(m[2]));
      model.instances.set(m[1]!, list);
      return;
    }
    return bad('not a line this export may write');
  });
  const ids = new Map<number, string>();
  for (const [name, v] of model.vlans) {
    if (v.id === null) throw new GrammarError(0, name, 'a VLAN without a vlan-id');
    if (ids.has(v.id)) throw new GrammarError(0, name, 'two VLANs share a vlan-id');
    ids.set(v.id, name);
    if (v.l3 !== null && !model.units.has(v.l3)) throw new GrammarError(0, name, 'an l3-interface whose IRB unit is not configured');
  }
  const l3Units = [...model.vlans.values()].map(v => v.l3).filter((u): u is number => u !== null);
  if (new Set(l3Units).size !== l3Units.length) throw new GrammarError(0, '', 'two VLANs share an IRB unit');
  const placed = new Set<number>();
  for (const [name, list] of model.instances) {
    for (const u of list) {
      if (!model.units.has(u)) throw new GrammarError(0, name, 'a routing instance holds an IRB unit that is not configured');
      if (placed.has(u)) throw new GrammarError(0, name, 'an IRB unit is in two routing instances');
      placed.add(u);
    }
  }
  for (const [n, u] of model.units) {
    if (u.inet.length > 1) throw new GrammarError(0, String(n), 'more than one IPv4 address on a unit');
    if (u.inet.length + u.inet6.length === 0) throw new GrammarError(0, String(n), 'a unit without an address');
  }
  return model;
}
