/**
 * Validation of a whole network plan.
 *
 * Every finding has a severity: an error blocks a correct deployment (a duplicate VLAN ID in one
 * namespace, overlapping networks in one routing domain, a gateway outside its network); a warning
 * is legal but probably unintended (an IPv6 LAN prefix that is not a /64); info is worth knowing
 * and needs no action (a network reused in an independent VRF, a VLAN still waiting for a network).
 *
 * Overlap rules follow routing domains, never sites: networks in the same VRF, or in two VRFs that
 * exchange routes, must not overlap. The same network in VRFs that do not exchange routes is legal
 * reuse and is reported as info, with the VRFs named. Every overlap finding carries its scope.
 *
 * VLAN ID rules follow VLAN namespaces, never VRFs or sites: an ID must be unique in its namespace.
 */
import { formatInteger } from '../format';
import { detectFamily, formatAddress, formatPrefix, formatRange, parseAddress, parsePrefixText, prefixToRange, type IpPrefix, type IpRange } from '../net/address';
import { parseNetworkItem } from '../net/list';
import { hostCapacity, MAX_HOSTS, prefixForHosts } from '../net/vlsm';
import type { Plan, ReservedEntry, Vlan } from './model';

export type Severity = 'error' | 'warning' | 'info';
export type TargetKind = 'plan' | 'site' | 'block' | 'vrf' | 'namespace' | 'vlan';

export interface IssueTarget {
  readonly kind: TargetKind;
  readonly id: string;
  /** For a parent block: the site it belongs to. */
  readonly siteId?: string;
}

export type ScopeKind = 'same-vrf' | 'exchanging-vrfs' | 'independent-vrfs';

/** Which routing domains an overlap finding is about. */
export interface OverlapScope {
  readonly kind: ScopeKind;
  readonly vrfIds: readonly string[];
  /** "VRF Global", "VRFs Corp and Shared (they exchange routes)", ... */
  readonly text: string;
}

export interface PlanIssue {
  readonly severity: Severity;
  readonly code: string;
  readonly target: IssueTarget;
  /** The field the issue is about: 'vlanId', 'ipv4.network', 'ipv4.dhcp', 'reserved', 'blocks.network', ... */
  readonly field: string | null;
  /** For a list field, the 0-based entry. */
  readonly line: number | null;
  /** The problem, without its location (the UI shows the location next to it). */
  readonly message: string;
  readonly related: readonly IssueTarget[];
  readonly scope: OverlapScope | null;
}

export interface ParsedVlan {
  readonly vlanNumber: number | null;
  readonly hosts: number | null;
  readonly ipv4: IpPrefix | null;
  /** The valid IPv6 prefixes, in entry order. */
  readonly ipv6: readonly IpPrefix[];
  /** True when every non-empty IPv6 entry parsed. */
  readonly ipv6Complete: boolean;
}

export interface PlanValidation {
  readonly issues: readonly PlanIssue[];
  readonly counts: Readonly<Record<Severity, number>>;
  readonly parsed: ReadonlyMap<string, ParsedVlan>;
  forTarget(kind: TargetKind, id: string): readonly PlanIssue[];
}

/** Overlap findings listed per network before the rest are counted in one more finding. */
export const OVERLAPS_LISTED = 5;
/** VRF names listed in a reuse finding. */
const REUSE_LISTED = 3;

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function block(text: string): IpPrefix {
  const p = parsePrefixText(text);
  if (!p.ok) throw new Error(`bad built-in block ${text}`);
  return p.value.prefix;
}

/** Space that cannot be a VLAN's network. */
const NOT_ASSIGNABLE: readonly { prefix: IpPrefix; why: string }[] = [
  { prefix: block('0.0.0.0/8'), why: 'is "this network" space (RFC 791), which cannot be assigned' },
  { prefix: block('127.0.0.0/8'), why: 'is loopback space (RFC 1122)' },
  { prefix: block('224.0.0.0/4'), why: 'is multicast space (RFC 5771)' },
  { prefix: block('240.0.0.0/4'), why: 'is reserved space (RFC 1112), which includes the limited broadcast address' },
  { prefix: block('::/128'), why: 'includes the unspecified address ::' },
  { prefix: block('::1/128'), why: 'includes the loopback address ::1' },
  { prefix: block('::ffff:0:0/96'), why: 'is IPv4-mapped address space (RFC 4291)' },
  { prefix: block('fe80::/10'), why: 'is link-local space, which every interface configures by itself' },
  { prefix: block('ff00::/8'), why: 'is multicast space (RFC 4291)' },
];
const IPV4_LINK_LOCAL = prefixToRange(block('169.254.0.0/16'));
const IPV6_LINK_LOCAL = prefixToRange(block('fe80::/10'));

const overlaps = (a: IpRange, b: IpRange) => a.family === b.family && a.first <= b.last && b.first <= a.last;
const inside = (outer: IpRange, inner: IpRange) => outer.family === inner.family && outer.first <= inner.first && inner.last <= outer.last;
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

interface NetItem {
  readonly vlan: Vlan;
  readonly index: number;
  readonly prefix: IpPrefix;
  readonly range: IpRange;
  readonly field: 'ipv4.network' | 'ipv6.prefixes';
  readonly line: number | null;
}

interface BlockItem {
  readonly siteId: string;
  readonly blockId: string;
  readonly vrfId: string;
  readonly prefix: IpPrefix;
  readonly range: IpRange;
}

/** "VLAN 10 Users at HQ", "VLAN 10 at HQ", "an unnamed VLAN at HQ". */
export function describeVlan(plan: Plan, v: Vlan): string {
  const site = plan.sites.find(s => s.id === v.siteId);
  const id = v.vlanId.trim();
  const name = v.name.trim();
  const base = id ? `VLAN ${id}${name ? ` ${name}` : ''}` : name ? `VLAN "${name}"` : 'an unnamed VLAN';
  return site ? `${base} at ${site.name.trim() || 'an unnamed site'}` : base;
}

export function validatePlan(plan: Plan): PlanValidation {
  const issues: PlanIssue[] = [];
  const add = (severity: Severity, code: string, target: IssueTarget, field: string | null, message: string, extra: { line?: number | null; related?: IssueTarget[]; scope?: OverlapScope | null } = {}) => {
    issues.push({ severity, code, target, field, message, line: extra.line ?? null, related: extra.related ?? [], scope: extra.scope ?? null });
  };

  const sites = new Map(plan.sites.map(s => [s.id, s]));
  const vrfs = new Map(plan.vrfs.map(v => [v.id, v]));
  const namespaces = new Map(plan.namespaces.map(n => [n.id, n]));
  const siteName = (id: string) => (sites.get(id)?.name.trim() || id || 'no site');
  const vrfName = (id: string) => (vrfs.get(id)?.name.trim() || id || 'no VRF');

  // Route exchange is symmetric: either VRF listing the other is enough.
  const exchanging = new Set<string>();
  for (const v of plan.vrfs) for (const other of v.exchangesWith) {
    if (other === v.id) continue;
    exchanging.add(`${v.id}|${other}`);
    exchanging.add(`${other}|${v.id}`);
  }
  const scopeOf = (a: string, b: string): OverlapScope => {
    if (a === b) return { kind: 'same-vrf', vrfIds: [a], text: `VRF "${vrfName(a)}"` };
    if (exchanging.has(`${a}|${b}`)) return { kind: 'exchanging-vrfs', vrfIds: [a, b], text: `VRFs "${vrfName(a)}" and "${vrfName(b)}", which exchange routes` };
    return { kind: 'independent-vrfs', vrfIds: [a, b], text: `VRFs "${vrfName(a)}" and "${vrfName(b)}", which are independent` };
  };

  // ---- Names: unique among things visible at the same site ----------------------------------
  const scopedNames = <T extends { id: string; name: string; siteId?: string }>(kind: TargetKind, items: readonly T[], noun: string) => {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const name = item.name.trim();
      if (name === '') {
        add('error', 'name-empty', { kind, id: item.id }, 'name', `Give the ${noun} a name.`);
        continue;
      }
      const key = name.toLowerCase();
      push(groups, key, item);
    }
    for (const group of groups.values()) {
      group.forEach((item, i) => {
        const clash = group.slice(0, i).find(o => {
          const a = o.siteId ?? '';
          const b = item.siteId ?? '';
          return a === '' || b === '' || a === b;
        });
        if (clash) add('error', 'name-duplicate', { kind, id: item.id }, 'name', `Another ${noun} visible at the same site is already named "${clash.name.trim()}".`, { related: [{ kind, id: clash.id }] });
      });
    }
  };
  scopedNames('site', plan.sites, 'site');
  scopedNames('vrf', plan.vrfs, 'VRF');
  scopedNames('namespace', plan.namespaces, 'VLAN namespace');

  // ---- VRFs and namespaces --------------------------------------------------------------------
  for (const v of plan.vrfs) {
    const t: IssueTarget = { kind: 'vrf', id: v.id };
    if (v.siteId !== '' && !sites.has(v.siteId)) add('error', 'site-missing', t, 'siteId', `Site "${v.siteId}" does not exist in this plan.`);
    for (const other of v.exchangesWith) {
      if (other === v.id) add('warning', 'exchange-self', t, 'exchangesWith', 'A VRF always shares routes with itself; remove it from its own list.');
      else if (!vrfs.has(other)) add('error', 'vrf-missing', t, 'exchangesWith', `VRF "${other}" does not exist in this plan.`);
    }
  }
  for (const n of plan.namespaces) {
    if (n.siteId !== '' && !sites.has(n.siteId)) add('error', 'site-missing', { kind: 'namespace', id: n.id }, 'siteId', `Site "${n.siteId}" does not exist in this plan.`);
  }

  // ---- Parent blocks --------------------------------------------------------------------------
  const blockItems: BlockItem[] = [];
  const blocksFor = new Map<string, BlockItem[]>();
  for (const site of plan.sites) {
    for (const b of site.blocks) {
      const t: IssueTarget = { kind: 'block', id: b.id, siteId: site.id };
      const vrf = vrfs.get(b.vrfId);
      if (!vrf) add('error', 'vrf-missing', t, 'vrfId', b.vrfId ? `VRF "${b.vrfId}" does not exist in this plan.` : 'Choose the VRF this block belongs to.');
      else if (vrf.siteId !== '' && vrf.siteId !== site.id) add('error', 'vrf-site', t, 'vrfId', `VRF "${vrfName(vrf.id)}" exists only at site "${siteName(vrf.siteId)}".`);
      const text = b.network.trim();
      let prefix: IpPrefix | null = null;
      if (text === '') add('error', 'block-network-empty', t, 'network', 'Enter the block in CIDR notation, such as 10.40.0.0/16 or 2001:db8:40::/48.');
      else {
        const p = parsePrefixText(text);
        if (!p.ok) add('error', 'block-network-invalid', t, 'network', p.error.message);
        else if (p.value.hostBitsSet) add('error', 'block-host-bits', t, 'network', `${text} has host bits set. Did you mean ${formatPrefix(p.value.prefix)}?`);
        else prefix = p.value.prefix;
      }
      const range = prefix ? prefixToRange(prefix) : null;
      b.reserved.forEach((entry, line) => {
        const parsed = checkRange(entry.range);
        if (typeof parsed === 'string') add('error', 'reserved-invalid', t, 'reserved', `Reserved entry ${line + 1}: ${parsed}`, { line });
        else if (range && !inside(range, parsed)) add('error', 'reserved-outside', t, 'reserved', `Reserved entry ${line + 1} (${formatRange(parsed)}) is not inside ${formatPrefix(prefix!)}.`, { line });
      });
      if (prefix && range && vrf) {
        const item = { siteId: site.id, blockId: b.id, vrfId: b.vrfId, prefix, range };
        blockItems.push(item);
        const key = `${site.id}|${b.vrfId}|${prefix.family}`;
        push(blocksFor, key, item);
      }
    }
  }
  sweep(blockItems, (a, b) => {
    const scope = scopeOf(a.vrfId, b.vrfId);
    if (scope.kind === 'independent-vrfs') return;
    for (const [me, other] of [[a, b], [b, a]] as const) {
      const same = me.range.first === other.range.first && me.range.last === other.range.last;
      add('error', 'block-overlap', { kind: 'block', id: me.blockId, siteId: me.siteId }, 'network',
        `${formatPrefix(me.prefix)} ${same ? 'is the same block as' : 'overlaps'} ${formatPrefix(other.prefix)} of site "${siteName(other.siteId)}" in ${scope.text}.`,
        { related: [{ kind: 'block', id: other.blockId, siteId: other.siteId }], scope });
    }
  });

  // ---- VLANs ----------------------------------------------------------------------------------
  const parsed = new Map<string, ParsedVlan>();
  const netItems: NetItem[] = [];
  const byNamespaceId = new Map<string, { vlan: Vlan; n: number }[]>();

  plan.vlans.forEach((v, index) => {
    const t: IssueTarget = { kind: 'vlan', id: v.id };

    // VLAN ID
    const idText = v.vlanId.trim();
    let vlanNumber: number | null = null;
    if (idText === '') add('error', 'vlan-id-empty', t, 'vlanId', 'Enter a VLAN ID from 1 to 4094.');
    else if (!/^[0-9]+$/.test(idText)) add('error', 'vlan-id-invalid', t, 'vlanId', `"${idText}" is not a VLAN ID. Use a whole number from 1 to 4094.`);
    else {
      const n = idText.length > 5 ? Number.POSITIVE_INFINITY : Number(idText);
      if (n === 0 || n === 4095) add('error', 'vlan-id-reserved', t, 'vlanId', `VLAN ${n} is reserved by IEEE 802.1Q and cannot be assigned. Use 1 to 4094.`);
      else if (n > 4095) add('error', 'vlan-id-range', t, 'vlanId', `${idText} is out of range: VLAN IDs are 1 to 4094.`);
      else {
        vlanNumber = n;
        if (n === 1) add('info', 'vlan-id-default', t, 'vlanId', 'VLAN 1 is the default VLAN on most switches, and many networks keep user traffic off it.');
        if (n >= 1002 && n <= 1005) add('warning', 'vlan-id-legacy', t, 'vlanId', `VLAN ${n} is reserved on many Cisco switches (legacy FDDI and Token Ring VLANs 1002 to 1005).`);
      }
    }
    if (v.name.trim() === '') add('warning', 'vlan-name-empty', t, 'name', 'Give the VLAN a name.');

    // References
    const site = sites.get(v.siteId);
    if (!site) add('error', 'site-missing', t, 'siteId', v.siteId ? `Site "${v.siteId}" does not exist in this plan.` : 'Choose a site.');
    const ns = namespaces.get(v.namespaceId);
    if (!ns) add('error', 'namespace-missing', t, 'namespaceId', v.namespaceId ? `VLAN namespace "${v.namespaceId}" does not exist in this plan.` : 'Choose a VLAN namespace.');
    else if (site && ns.siteId !== '' && ns.siteId !== v.siteId) add('error', 'namespace-site', t, 'namespaceId', `VLAN namespace "${ns.name.trim()}" belongs to site "${siteName(ns.siteId)}", not to this VLAN's site.`);
    const vrf = vrfs.get(v.vrfId);
    if (!vrf) add('error', 'vrf-missing', t, 'vrfId', v.vrfId ? `VRF "${v.vrfId}" does not exist in this plan.` : 'Choose a VRF.');
    else if (site && vrf.siteId !== '' && vrf.siteId !== v.siteId) add('error', 'vrf-site', t, 'vrfId', `VRF "${vrfName(vrf.id)}" exists only at site "${siteName(vrf.siteId)}".`);
    if (ns && vlanNumber !== null) push(byNamespaceId, ns.id, { vlan: v, n: vlanNumber });

    // IPv4 network
    const net4Text = v.ipv4.network.trim();
    let net4: IpPrefix | null = null;
    if (net4Text !== '') {
      if (detectFamily(net4Text) === 6) add('error', 'ipv4-network-family', t, 'ipv4.network', 'This is an IPv6 prefix. Enter IPv6 prefixes in the IPv6 section.');
      else {
        const p = parsePrefixText(net4Text, 4);
        if (!p.ok) add('error', 'ipv4-network-invalid', t, 'ipv4.network', p.error.message);
        else if (p.value.hostBitsSet) add('error', 'ipv4-host-bits', t, 'ipv4.network', `${net4Text} has host bits set. Did you mean ${formatPrefix(p.value.prefix)}?`);
        else net4 = p.value.prefix;
      }
    }
    if (net4) {
      const range = prefixToRange(net4);
      const bad = NOT_ASSIGNABLE.find(b => overlaps(prefixToRange(b.prefix), range));
      if (bad) {
        add('error', 'not-assignable', t, 'ipv4.network', `${formatPrefix(net4)} ${inside(prefixToRange(bad.prefix), range) ? '' : `overlaps ${formatPrefix(bad.prefix)}, which `}${bad.why}.`);
      } else {
        if (overlaps(IPV4_LINK_LOCAL, range)) add('warning', 'link-local', t, 'ipv4.network', `${formatPrefix(net4)} is in 169.254.0.0/16, the link-local range hosts give themselves when DHCP fails (RFC 3927).`);
        if (net4.length === 32) add('warning', 'ipv4-single-address', t, 'ipv4.network', 'A /32 is a single address, with no room for a gateway and hosts.');
        else if (net4.length === 31) add('warning', 'ipv4-point-to-point', t, 'ipv4.network', 'A /31 is a point-to-point link (RFC 3021): two addresses and no broadcast. Most VLANs need room for a gateway and hosts.');
        netItems.push({ vlan: v, index, prefix: net4, range, field: 'ipv4.network', line: null });
      }
    }
    const net4Range = net4 ? prefixToRange(net4) : null;
    const standard4 = net4 !== null && net4.length <= 30;

    // Host target
    const hostsText = v.hosts.trim();
    let hosts: number | null = null;
    if (hostsText !== '') {
      if (!/^[0-9]+$/.test(hostsText) || Number(hostsText) < 1) add('error', 'hosts-invalid', t, 'hosts', 'Enter the number of usable IPv4 addresses the VLAN needs (including its gateway), as a whole number of at least 1.');
      else if (Number(hostsText) > MAX_HOSTS) add('error', 'hosts-too-many', t, 'hosts', `${fmt(BigInt(hostsText))} is more addresses than any IPv4 network holds (${fmt(MAX_HOSTS)}).`);
      else hosts = Number(hostsText);
    }
    if (hosts !== null) {
      if (net4) {
        const capacity = hostCapacity(net4.length);
        if (capacity < BigInt(hosts)) {
          add('error', 'capacity', t, 'hosts', `Needs ${fmt(hosts)} usable addresses, but ${formatPrefix(net4)} has ${fmt(capacity)}. The smallest network that fits is a /${prefixForHosts(hosts)}.`);
        }
      } else if (net4Text === '') {
        add('info', 'unallocated', t, 'hosts', `Needs ${fmt(hosts)} usable IPv4 addresses and has no network yet. The Allocate tab can assign one.`);
      }
    }

    // IPv4 gateway
    const gw4Text = v.ipv4.gateway.trim();
    let gw4: bigint | null = null;
    if (gw4Text !== '') {
      const a = parseAddress(gw4Text, 4);
      if (!a.ok) add('error', 'gateway-invalid', t, 'ipv4.gateway', a.error.message);
      else {
        gw4 = a.value.value;
        const shown = formatAddress(4, gw4);
        if (net4Range) {
          if (gw4 < net4Range.first || gw4 > net4Range.last) add('error', 'gateway-outside', t, 'ipv4.gateway', `${shown} is not in ${formatPrefix(net4!)} (${formatAddress(4, net4Range.first)} to ${formatAddress(4, net4Range.last)}).`);
          else if (standard4 && gw4 === net4Range.first) add('error', 'gateway-network', t, 'ipv4.gateway', `${shown} is the network address of ${formatPrefix(net4!)}; a gateway needs a host address.`);
          else if (standard4 && gw4 === net4Range.last) add('error', 'gateway-broadcast', t, 'ipv4.gateway', `${shown} is the broadcast address of ${formatPrefix(net4!)}; a gateway needs a host address.`);
        } else if (net4Text === '') add('error', 'gateway-no-network', t, 'ipv4.gateway', 'There is no IPv4 network to check the gateway against. Enter the network first.');
      }
    }

    // IPv6 prefixes (before reservations, which may be IPv6)
    const v6: { prefix: IpPrefix; range: IpRange; line: number }[] = [];
    let v6Complete = true;
    v.ipv6.prefixes.forEach((raw, line) => {
      const text = raw.trim();
      const label = `Prefix ${line + 1}`;
      if (text === '') {
        v6Complete = false;
        add('error', 'ipv6-invalid', t, 'ipv6.prefixes', `${label} is empty. Enter an IPv6 prefix such as 2001:db8:10::/64.`, { line });
        return;
      }
      if (!text.includes(':')) {
        v6Complete = false;
        add('error', 'ipv6-family', t, 'ipv6.prefixes', `${label} (${text}) is not an IPv6 prefix. Enter IPv4 networks in the IPv4 section.`, { line });
        return;
      }
      const p = parsePrefixText(text, 6);
      if (!p.ok) {
        v6Complete = false;
        add('error', 'ipv6-invalid', t, 'ipv6.prefixes', `${label} (${text}): ${p.error.message}`, { line });
        return;
      }
      if (p.value.hostBitsSet) {
        v6Complete = false;
        add('error', 'ipv6-host-bits', t, 'ipv6.prefixes', `${label} (${text}) has host bits set. Did you mean ${formatPrefix(p.value.prefix)}?`, { line });
        return;
      }
      const prefix = p.value.prefix;
      const range = prefixToRange(prefix);
      const shown = formatPrefix(prefix);
      const bad = NOT_ASSIGNABLE.find(b => overlaps(prefixToRange(b.prefix), range));
      if (bad) {
        add('error', 'not-assignable', t, 'ipv6.prefixes', `${label} (${shown}) ${inside(prefixToRange(bad.prefix), range) ? '' : `overlaps ${formatPrefix(bad.prefix)}, which `}${bad.why}.`, { line });
        return;
      }
      const same = v6.find(o => o.range.first === range.first && o.range.last === range.last);
      if (same) {
        add('error', 'ipv6-duplicate', t, 'ipv6.prefixes', `${label} (${shown}) is listed twice (also prefix ${same.line + 1}).`, { line });
        return;
      }
      const clash = v6.find(o => overlaps(o.range, range));
      if (clash) {
        add('error', 'ipv6-self-overlap', t, 'ipv6.prefixes', `${label} (${shown}) overlaps prefix ${clash.line + 1} (${formatPrefix(clash.prefix)}) of the same VLAN.`, { line });
        return;
      }
      if (prefix.length !== 64) {
        add('warning', 'ipv6-not-64', t, 'ipv6.prefixes', `${label} (${shown}) is a /${prefix.length}. A LAN segment is normally exactly a /64: SLAAC and many hosts need it (RFC 4291, RFC 7421).`, { line });
      }
      v6.push({ prefix, range, line });
      netItems.push({ vlan: v, index, prefix, range, field: 'ipv6.prefixes', line });
    });

    // IPv6 gateway
    const gw6Text = v.ipv6.gateway.trim();
    if (gw6Text !== '') {
      const a = parseAddress(gw6Text, 6);
      if (!a.ok) add('error', 'gateway6-invalid', t, 'ipv6.gateway', a.error.message);
      else {
        const gw = a.value.value;
        const shown = formatAddress(6, gw);
        const linkLocal = IPV6_LINK_LOCAL.first <= gw && gw <= IPV6_LINK_LOCAL.last;
        if (!linkLocal) {
          const home = v6.find(o => o.range.first <= gw && gw <= o.range.last);
          if (v6.length === 0) {
            if (v.ipv6.prefixes.length === 0) add('error', 'gateway6-no-network', t, 'ipv6.gateway', 'There is no IPv6 prefix to check the gateway against. Enter a prefix, or use a link-local gateway such as fe80::1.');
          } else if (!home) add('error', 'gateway6-outside', t, 'ipv6.gateway', `${shown} is not in any of this VLAN's IPv6 prefixes (${v6.map(o => formatPrefix(o.prefix)).join(', ')}).`);
          else if (gw === home.range.first && home.prefix.length < 127) add('error', 'gateway6-anycast', t, 'ipv6.gateway', `${shown} is the Subnet-Router anycast address of ${formatPrefix(home.prefix)} (RFC 4291 section 2.6.1). Use another address for the gateway.`);
        }
      }
    }

    // Reserved addresses (either family)
    const reserved: { range: IpRange; line: number; entry: ReservedEntry }[] = [];
    v.reserved.forEach((entry, line) => {
      const r = checkRange(entry.range);
      const label = `Reserved entry ${line + 1}${entry.label.trim() ? ` (${entry.label.trim()})` : ''}`;
      if (typeof r === 'string') {
        add('error', 'reserved-invalid', t, 'reserved', `${label}: ${r}`, { line });
        return;
      }
      if (r.family === 4) {
        if (!net4Range) {
          if (net4Text === '') add('error', 'reserved-no-network', t, 'reserved', `${label} is IPv4, but the VLAN has no IPv4 network.`, { line });
          return;
        }
        if (!inside(net4Range, r)) {
          add('error', 'reserved-outside', t, 'reserved', `${label}: ${formatRange(r)} is not inside ${formatPrefix(net4!)}.`, { line });
          return;
        }
      } else if (!v6.some(o => inside(o.range, r))) {
        if (v6.length === 0 && v.ipv6.prefixes.length === 0) add('error', 'reserved-no-network', t, 'reserved', `${label} is IPv6, but the VLAN has no IPv6 prefix.`, { line });
        else if (v6.length > 0) add('error', 'reserved-outside', t, 'reserved', `${label}: ${formatRange(r)} is not inside any of this VLAN's IPv6 prefixes.`, { line });
        return;
      }
      const clash = reserved.find(o => overlaps(o.range, r));
      if (clash) add('warning', 'reserved-overlap', t, 'reserved', `${label}: ${formatRange(r)} overlaps reserved entry ${clash.line + 1} (${formatRange(clash.range)}).`, { line });
      reserved.push({ range: r, line, entry });
    });

    // DHCP pools
    const pools: { range: IpRange; line: number }[] = [];
    v.ipv4.dhcp.forEach((raw, line) => {
      const label = `DHCP pool ${line + 1}`;
      const r = checkRange(raw);
      if (typeof r === 'string') {
        add('error', 'dhcp-invalid', t, 'ipv4.dhcp', `${label}: ${r}`, { line });
        return;
      }
      const shown = formatRange(r);
      if (r.family === 6) {
        add('error', 'dhcp-family', t, 'ipv4.dhcp', `${label} (${shown}) is IPv6. These pools are IPv4 DHCP; DHCPv6 pools are not part of the plan yet.`, { line });
        return;
      }
      if (!net4Range) {
        if (net4Text === '') add('error', 'dhcp-no-network', t, 'ipv4.dhcp', `${label} (${shown}) has no IPv4 network to belong to. Enter the network first.`, { line });
        return;
      }
      if (!inside(net4Range, r)) {
        add('error', 'dhcp-outside', t, 'ipv4.dhcp', `${label} (${shown}) is not inside ${formatPrefix(net4!)}.`, { line });
        return;
      }
      if (standard4 && r.first === net4Range.first) {
        add('error', 'dhcp-network', t, 'ipv4.dhcp', `${label} (${shown}) includes the network address ${formatAddress(4, net4Range.first)}.`, { line });
        return;
      }
      if (standard4 && r.last === net4Range.last) {
        add('error', 'dhcp-broadcast', t, 'ipv4.dhcp', `${label} (${shown}) includes the broadcast address ${formatAddress(4, net4Range.last)}.`, { line });
        return;
      }
      if (gw4 !== null && r.first <= gw4 && gw4 <= r.last) add('error', 'dhcp-gateway', t, 'ipv4.dhcp', `${label} (${shown}) includes the gateway ${formatAddress(4, gw4)}, so a client could be leased the gateway's address.`, { line });
      for (const res of reserved) {
        if (overlaps(res.range, r)) add('error', 'dhcp-reserved', t, 'ipv4.dhcp', `${label} (${shown}) overlaps reserved entry ${res.line + 1}${res.entry.label.trim() ? ` (${res.entry.label.trim()})` : ''}: ${formatRange(res.range)}.`, { line });
      }
      const clash = pools.find(o => overlaps(o.range, r));
      if (clash) add('error', 'dhcp-overlap', t, 'ipv4.dhcp', `${label} (${shown}) overlaps DHCP pool ${clash.line + 1} (${formatRange(clash.range)}).`, { line });
      pools.push({ range: r, line });
    });

    const nothing = net4Text === '' && hostsText === '' && gw4Text === '' && gw6Text === '' && v.ipv6.prefixes.length === 0 && v.ipv4.dhcp.length === 0 && v.reserved.length === 0;
    if (nothing) add('info', 'no-network', t, null, 'No network assigned: a layer 2 only VLAN.');

    parsed.set(v.id, { vlanNumber, hosts, ipv4: net4, ipv6: v6.map(o => o.prefix), ipv6Complete: v6Complete });
  });

  // Duplicate VLAN IDs, per namespace.
  for (const [nsId, list] of byNamespaceId) {
    const byNumber = new Map<number, Vlan[]>();
    for (const { vlan, n } of list) push(byNumber, n, vlan);
    for (const [n, group] of byNumber) {
      if (group.length < 2) continue;
      for (const v of group) {
        const others = group.filter(o => o !== v);
        const named = others.slice(0, 3).map(o => describeVlan(plan, o)).join('; ');
        const more = others.length > 3 ? ` and ${others.length - 3} more` : '';
        add('error', 'vlan-id-duplicate', { kind: 'vlan', id: v.id }, 'vlanId', `VLAN ${n} is also used in VLAN namespace "${namespaces.get(nsId)!.name.trim()}" by ${named}${more}.`, { related: others.map(o => ({ kind: 'vlan' as const, id: o.id })) });
      }
    }
  }

  // Parent blocks of the VLAN's site, for its VRF and family.
  for (const item of netItems) {
    const v = item.vlan;
    if (!sites.has(v.siteId) || !vrfs.has(v.vrfId)) continue;
    const blocks = blocksFor.get(`${v.siteId}|${v.vrfId}|${item.prefix.family}`);
    if (!blocks || blocks.some(b => inside(b.range, item.range))) continue;
    add('error', 'outside-parent', { kind: 'vlan', id: v.id }, item.field,
      `${formatPrefix(item.prefix)} is outside the parent blocks of site "${siteName(v.siteId)}" for VRF "${vrfName(v.vrfId)}": ${blocks.map(b => formatPrefix(b.prefix)).join(', ')}.`,
      { line: item.line, related: blocks.map(b => ({ kind: 'block' as const, id: b.blockId, siteId: b.siteId })) });
  }

  // Overlaps between VLAN networks, scoped by routing domain.
  const conflicts = new Map<NetItem, { other: NetItem; scope: OverlapScope }[]>();
  const reuse = new Map<NetItem, Map<string, number>>();
  sweep(netItems, (a, b) => {
    if (a.vlan === b.vlan) return; // overlapping prefixes of one VLAN are reported above
    const scope = scopeOf(a.vlan.vrfId, b.vlan.vrfId);
    if (scope.kind === 'independent-vrfs') {
      for (const [me, other] of [[a, b], [b, a]] as const) {
        const m = reuse.get(me) ?? new Map<string, number>();
        m.set(other.vlan.vrfId, (m.get(other.vlan.vrfId) ?? 0) + 1);
        reuse.set(me, m);
      }
      return;
    }
    push(conflicts, a, { other: b, scope });
    push(conflicts, b, { other: a, scope: scopeOf(b.vlan.vrfId, a.vlan.vrfId) });
  });
  for (const [item, list] of conflicts) {
    const shown = formatPrefix(item.prefix);
    list.sort((x, y) => x.other.index - y.other.index);
    for (const { other, scope } of list.slice(0, OVERLAPS_LISTED)) {
      const otherShown = formatPrefix(other.prefix);
      const same = other.range.first === item.range.first && other.range.last === item.range.last;
      const relation = same ? 'is also assigned to' : inside(other.range, item.range) ? `is inside ${otherShown} of` : inside(item.range, other.range) ? `contains ${otherShown} of` : `overlaps ${otherShown} of`;
      add('error', same ? 'duplicate-network' : 'overlap', { kind: 'vlan', id: item.vlan.id }, item.field, `${shown} ${relation} ${describeVlan(plan, other.vlan)}, in ${scope.text}.`,
        { line: item.line, related: [{ kind: 'vlan', id: other.vlan.id }], scope });
    }
    if (list.length > OVERLAPS_LISTED) {
      const rest = list.slice(OVERLAPS_LISTED);
      add('error', 'overlap-more', { kind: 'vlan', id: item.vlan.id }, item.field, `${shown} overlaps ${rest.length} more ${rest.length === 1 ? 'network' : 'networks'} in the same routing domain.`,
        { line: item.line, related: rest.map(r => ({ kind: 'vlan' as const, id: r.other.vlan.id })), scope: list[0].scope });
    }
  }
  for (const [item, others] of reuse) {
    const ids = [...others.keys()].sort((x, y) => vrfName(x).localeCompare(vrfName(y)) || x.localeCompare(y));
    const total = [...others.values()].reduce((s, n) => s + n, 0);
    const names = ids.slice(0, REUSE_LISTED).map(id => `"${vrfName(id)}"`).join(', ') + (ids.length > REUSE_LISTED ? ` and ${ids.length - REUSE_LISTED} more` : '');
    const scope: OverlapScope = { kind: 'independent-vrfs', vrfIds: [item.vlan.vrfId, ...ids], text: `VRF "${vrfName(item.vlan.vrfId)}" and the independent ${ids.length === 1 ? 'VRF' : 'VRFs'} ${names}` };
    add('info', 'reuse-independent', { kind: 'vlan', id: item.vlan.id }, item.field,
      `${formatPrefix(item.prefix)} overlaps ${total} ${total === 1 ? 'network' : 'networks'} in ${ids.length === 1 ? 'VRF' : 'VRFs'} ${names}, which ${ids.length === 1 ? 'does' : 'do'} not exchange routes with VRF "${vrfName(item.vlan.vrfId)}". Reuse across independent routing domains is allowed.`,
      { line: item.line, scope });
  }

  // Order: severity, then the order things appear in the plan.
  const order = new Map<string, number>();
  let n = 0;
  order.set('plan:', n++);
  for (const s of plan.sites) {
    order.set(`site:${s.id}`, n++);
    for (const b of s.blocks) order.set(`block:${b.id}`, n++);
  }
  for (const v of plan.vrfs) order.set(`vrf:${v.id}`, n++);
  for (const ns of plan.namespaces) order.set(`namespace:${ns.id}`, n++);
  for (const v of plan.vlans) order.set(`vlan:${v.id}`, n++);
  const rank = (i: PlanIssue) => order.get(`${i.target.kind}:${i.target.id}`) ?? n;
  const sorted = issues.map((issue, i) => ({ issue, i })).sort((a, b) => SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || rank(a.issue) - rank(b.issue) || a.i - b.i).map(x => x.issue);

  const byTarget = new Map<string, PlanIssue[]>();
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of sorted) {
    counts[issue.severity]++;
    const key = `${issue.target.kind}:${issue.target.id}`;
    const list = byTarget.get(key);
    if (list) list.push(issue);
    else byTarget.set(key, [issue]);
  }
  return { issues: sorted, counts, parsed, forTarget: (kind, id) => byTarget.get(`${kind}:${id}`) ?? [] };
}

/** An address, range or CIDR block, or the reason it is not one. CIDR text with host bits set is refused. */
function checkRange(text: string): IpRange | string {
  const item = parseNetworkItem(text, true);
  if ('message' in item) return item.message;
  if (item.hostBitsSet && item.prefix) return `${text.trim()} has host bits set. Did you mean ${formatPrefix(item.prefix)}?`;
  return { family: item.family, first: item.first, last: item.last };
}

/** Calls `visit` once for every overlapping pair (same family), by one sorted sweep. */
function sweep<T extends { range: IpRange }>(items: readonly T[], visit: (a: T, b: T) => void): void {
  const sorted = [...items].sort((a, b) => a.range.family - b.range.family || cmp(a.range.first, b.range.first) || cmp(b.range.last, a.range.last));
  let active: T[] = [];
  for (const item of sorted) {
    active = active.filter(a => a.range.family === item.range.family && a.range.last >= item.range.first);
    for (const a of active) visit(a, item);
    active.push(item);
  }
}
