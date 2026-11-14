/**
 * The provider-neutral export: the plan as plain structured data, with every network, gateway and
 * range written in canonical form from the parsed values. It is the plan's own model, so every
 * item is exact. The JSON document carries a format name and version so a reader can check them.
 */
import { formatInteger } from '../format';
import { parsePrefixText, type IpRange } from '../net/address';
import { parseNetworkItem } from '../net/list';
import { toJsonText } from '../export/files';
import type { Plan } from '../plan/model';
import { ItemBuilder, output, refused, type ExportItem, type ExportOutput } from './model';
import { cidr, inScope, ip4, ip6, mask4, resolvePlan, scopeProblem, type ExportScope, type ResolvedPlan, type ResolvedVlan } from './source';

export const NEUTRAL_FORMAT = 'netforge-network-export';
export const NEUTRAL_VERSION = 1;

export interface NeutralRange {
  readonly first: string;
  readonly last: string;
}

export interface NeutralReserved extends NeutralRange {
  readonly family: 4 | 6;
  readonly label: string;
}

export interface NeutralBlock {
  readonly id: string;
  readonly network: string;
  readonly family: 4 | 6;
  readonly vrf: string;
  readonly description: string;
  readonly reserved: readonly NeutralReserved[];
}

export interface NeutralSite {
  readonly name: string;
  readonly description: string;
  readonly notes: string;
  readonly parent_blocks: readonly NeutralBlock[];
}

export interface NeutralVrf {
  readonly name: string;
  /** The site the VRF exists at; null when it is available at every site. */
  readonly site: string | null;
  readonly exchanges_routes_with: readonly string[];
  readonly description: string;
  readonly notes: string;
}

export interface NeutralNamespace {
  readonly name: string;
  /** The site the namespace belongs to; null when it spans sites. */
  readonly site: string | null;
  readonly description: string;
}

export interface NeutralVlan {
  readonly vlan_id: number | null;
  readonly name: string;
  readonly site: string;
  readonly vrf: string;
  readonly vlan_namespace: string;
  readonly description: string;
  readonly notes: string;
  readonly hosts_target: number | null;
  readonly ipv4_network: string | null;
  readonly ipv4_netmask: string | null;
  readonly ipv4_gateway: string | null;
  readonly ipv4_dhcp_pools: readonly NeutralRange[];
  readonly ipv6_prefixes: readonly string[];
  readonly ipv6_gateway: string | null;
  readonly reserved: readonly NeutralReserved[];
}

/** Maps are keyed by the plan's own ids, which are unique and never change when something is renamed. */
export interface NeutralData {
  readonly sites: Readonly<Record<string, NeutralSite>>;
  readonly vrfs: Readonly<Record<string, NeutralVrf>>;
  readonly vlan_namespaces: Readonly<Record<string, NeutralNamespace>>;
  readonly vlans: Readonly<Record<string, NeutralVlan>>;
}

const reserved = (family: 4 | 6, range: IpRange, label: string): NeutralReserved => {
  const show = family === 4 ? ip4 : ip6;
  return { family, first: show(range.first), last: show(range.last), label };
};

function neutralVlan(v: ResolvedVlan): NeutralVlan {
  return {
    vlan_id: v.number, name: v.name, site: v.vlan.siteId, vrf: v.vlan.vrfId, vlan_namespace: v.vlan.namespaceId,
    description: v.vlan.description.trim(), notes: v.vlan.notes.trim(),
    hosts_target: /^[0-9]{1,15}$/.test(v.vlan.hosts.trim()) ? Number(v.vlan.hosts.trim()) : null,
    ipv4_network: v.net4 ? cidr(v.net4) : null,
    ipv4_netmask: v.net4 ? mask4(v.net4.length) : null,
    ipv4_gateway: v.gateway4 === null ? null : ip4(v.gateway4),
    ipv4_dhcp_pools: v.pools.map(p => ({ first: ip4(p.first), last: ip4(p.last) })),
    ipv6_prefixes: v.net6.map(cidr),
    ipv6_gateway: v.gateway6 ? ip6(v.gateway6.value) : null,
    reserved: [...v.reserved4.map(r => reserved(4, r.range, r.label)), ...v.reserved6.map(r => reserved(6, r.range, r.label))],
  };
}

/** The plan's data for a scope. A site, VRF or namespace is included when the scope names it or a VLAN in scope uses it. */
export function neutralData(r: ResolvedPlan, scope: ExportScope): NeutralData {
  const plan = r.plan;
  const vlans = r.vlans.filter(v => inScope(v, scope));
  const whole = scope.siteId === '' && scope.vrfId === '' && scope.namespaceId === '';
  const siteIds = new Set(vlans.map(v => v.vlan.siteId));
  const vrfIds = new Set(vlans.map(v => v.vlan.vrfId));
  const nsIds = new Set(vlans.map(v => v.vlan.namespaceId));
  if (scope.siteId !== '') siteIds.add(scope.siteId);
  if (scope.vrfId !== '') vrfIds.add(scope.vrfId);
  if (scope.namespaceId !== '') nsIds.add(scope.namespaceId);
  const sites: Record<string, NeutralSite> = {};
  for (const s of plan.sites) {
    if (!whole && !siteIds.has(s.id)) continue;
    const blocks: NeutralBlock[] = [];
    for (const b of s.blocks) {
      if (scope.vrfId !== '' && b.vrfId !== scope.vrfId) continue;
      const parsed = parseBlock(b.network);
      if (!parsed) continue;
      blocks.push({
        id: b.id, network: parsed.text, family: parsed.family, vrf: b.vrfId, description: b.description.trim(),
        reserved: b.reserved.flatMap(e => { const range = parseRange(e.range); return range ? [reserved(range.family, range, e.label.trim())] : []; }),
      });
    }
    sites[s.id] = { name: s.name.trim(), description: s.description.trim(), notes: s.notes.trim(), parent_blocks: blocks };
  }
  const vrfs: Record<string, NeutralVrf> = {};
  for (const v of plan.vrfs) {
    if (!whole && !vrfIds.has(v.id)) continue;
    vrfs[v.id] = { name: v.name.trim(), site: v.siteId === '' ? null : v.siteId, exchanges_routes_with: [...v.exchangesWith], description: v.description.trim(), notes: v.notes.trim() };
  }
  const namespaces: Record<string, NeutralNamespace> = {};
  for (const n of plan.namespaces) {
    if (!whole && !nsIds.has(n.id)) continue;
    namespaces[n.id] = { name: n.name.trim(), site: n.siteId === '' ? null : n.siteId, description: n.description.trim() };
  }
  const outVlans: Record<string, NeutralVlan> = {};
  for (const v of vlans) outVlans[v.vlan.id] = neutralVlan(v);
  return { sites, vrfs, vlan_namespaces: namespaces, vlans: outVlans };
}

function parseBlock(text: string): { text: string; family: 4 | 6 } | null {
  const p = parsePrefixText(text.trim());
  return p.ok ? { text: cidr(p.value.prefix), family: p.value.prefix.family } : null;
}

function parseRange(text: string): IpRange | null {
  const r = parseNetworkItem(text);
  return 'message' in r ? null : { family: r.family, first: r.first, last: r.last };
}

export function neutralItems(data: NeutralData): ExportItem[] {
  const items: ExportItem[] = [];
  for (const s of Object.values(data.sites)) items.push(new ItemBuilder(`Site ${s.name || '(unnamed)'}`).wrote(`name, description, notes and ${s.parent_blocks.length === 1 ? '1 parent block' : `${s.parent_blocks.length} parent blocks`}`).build());
  for (const v of Object.values(data.vrfs)) items.push(new ItemBuilder(`VRF ${v.name || '(unnamed)'}`).wrote('name, site, route exchange, description and notes').build());
  for (const n of Object.values(data.vlan_namespaces)) items.push(new ItemBuilder(`VLAN namespace ${n.name || '(unnamed)'}`).wrote('name, site and description').build());
  for (const v of Object.values(data.vlans)) {
    const label = v.vlan_id === null ? (v.name === '' ? 'Unnamed VLAN (no ID)' : `VLAN ${v.name} (no ID)`) : v.name === '' ? `VLAN ${v.vlan_id}` : `VLAN ${v.vlan_id} ${v.name}`;
    items.push(new ItemBuilder(label).wrote('ID, name, site, VRF, namespace, IPv4 network, gateway and DHCP pools, IPv6 prefixes and gateway, reserved ranges, host target, description and notes').build());
  }
  return items;
}

/** The provider-neutral JSON document. */
export function neutralJson(plan: Plan, scope: ExportScope): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const problem = scopeProblem(plan, scope);
  if (problem) return refused([problem]);
  const data = neutralData(resolved.value, scope);
  const count = Object.keys(data.vlans).length;
  if (count === 0) return refused(['No VLAN is in this selection.']);
  const doc = { format: NEUTRAL_FORMAT, version: NEUTRAL_VERSION, plan: { name: plan.name.trim(), description: plan.description.trim() }, ...data };
  return output({
    files: [{ name: 'netforge-network.json', kind: 'JSON', mime: 'application/json', text: toJsonText(doc) }],
    items: neutralItems(data),
    assumptions: [
      `The document is NetForge's own structure (format "${NEUTRAL_FORMAT}", version ${NEUTRAL_VERSION}), not any vendor's schema. Sites, VRFs, VLAN namespaces and VLANs are keyed by their plan ids.`,
      'Networks, gateways and ranges are written in canonical form (RFC 5952 for IPv6), which can differ in spelling from what was typed.',
      `${formatInteger(count)} ${count === 1 ? 'VLAN is' : 'VLANs are'} included. A VLAN without a network is included with null networks.`,
    ],
    manualSteps: [],
    notCovered: ['The "kept as is" marks used by automatic allocation, and validation findings. Save the plan file from the planner to keep everything.'],
  });
}
