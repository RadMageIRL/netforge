/**
 * Reads a network plan for export. A plan with validation errors is never exported: a duplicate
 * VLAN ID or an overlapping network would turn into configuration that looks reviewed. Every
 * value is parsed once here, so the targets work with numbers and ranges, not typed text.
 */
import { formatAddress, formatPrefix, parseAddress, prefixToRange, type IpPrefix, type IpRange } from '../net/address';
import { parseNetworkItem } from '../net/list';
import { mergeRanges } from '../net/ops';
import type { Plan, Site, Vlan, VlanNamespace, Vrf } from '../plan/model';
import { validatePlan, type PlanIssue, type PlanValidation } from '../plan/validate';

export interface ReservedRange {
  readonly range: IpRange;
  readonly label: string;
}

export interface Gateway6 {
  readonly value: bigint;
  readonly linkLocal: boolean;
  /** The VLAN prefix that holds the address; null for a link-local gateway. */
  readonly home: IpPrefix | null;
}

export interface ResolvedVlan {
  readonly vlan: Vlan;
  /** "VLAN 10 Users", "VLAN 10", "VLAN Users (no ID)". */
  readonly label: string;
  readonly number: number | null;
  readonly name: string;
  readonly site: Site | null;
  readonly vrf: Vrf | null;
  readonly namespace: VlanNamespace | null;
  readonly net4: IpPrefix | null;
  readonly gateway4: bigint | null;
  /** DHCP pools, merged and ascending. */
  readonly pools: readonly IpRange[];
  readonly reserved4: readonly ReservedRange[];
  readonly reserved6: readonly ReservedRange[];
  readonly net6: readonly IpPrefix[];
  readonly gateway6: Gateway6 | null;
}

export interface ResolvedPlan {
  readonly plan: Plan;
  readonly validation: PlanValidation;
  readonly vlans: readonly ResolvedVlan[];
}

/** Which part of the plan an export covers. An empty id means "all". */
export interface ExportScope {
  readonly siteId: string;
  readonly vrfId: string;
  readonly namespaceId: string;
}

export const WHOLE_PLAN: ExportScope = { siteId: '', vrfId: '', namespaceId: '' };

/** Errors listed in a refusal before the rest are counted. */
export const ERRORS_LISTED = 10;

const LINK_LOCAL_FIRST = 0xfe80n << 112n;
const LINK_LOCAL_LAST = (0xfec0n << 112n) - 1n;

function describeTarget(plan: Plan, issue: PlanIssue): string {
  const t = issue.target;
  if (t.kind === 'vlan') {
    const v = plan.vlans.find(x => x.id === t.id);
    return v ? vlanLabel(v) : 'A VLAN';
  }
  if (t.kind === 'site') return `Site ${plan.sites.find(s => s.id === t.id)?.name.trim() || t.id}`;
  if (t.kind === 'vrf') return `VRF ${plan.vrfs.find(s => s.id === t.id)?.name.trim() || t.id}`;
  if (t.kind === 'namespace') return `VLAN namespace ${plan.namespaces.find(s => s.id === t.id)?.name.trim() || t.id}`;
  if (t.kind === 'block') return 'A parent block';
  return 'The plan';
}

export function vlanLabel(v: Vlan): string {
  const id = v.vlanId.trim();
  const name = v.name.trim();
  if (id !== '') return name === '' ? `VLAN ${id}` : `VLAN ${id} ${name}`;
  return name === '' ? 'Unnamed VLAN (no ID)' : `VLAN ${name} (no ID)`;
}

/** The plan's errors as refusal lines, or null when it has none. */
export function planErrors(plan: Plan, validation: PlanValidation): string[] | null {
  const errors = validation.issues.filter(i => i.severity === 'error');
  if (errors.length === 0) return null;
  const lines = [`The plan has ${errors.length === 1 ? '1 error' : `${errors.length} errors`}. Fix ${errors.length === 1 ? 'it' : 'them'} in the planner first: an export of a plan with errors would look reviewed when it is not.`];
  for (const e of errors.slice(0, ERRORS_LISTED)) lines.push(`${describeTarget(plan, e)}: ${e.message}`);
  if (errors.length > ERRORS_LISTED) lines.push(`And ${errors.length - ERRORS_LISTED} more.`);
  return lines;
}

function itemRange(text: string): IpRange | null {
  const r = parseNetworkItem(text);
  return 'message' in r ? null : { family: r.family, first: r.first, last: r.last };
}

function resolveVlan(plan: Plan, validation: PlanValidation, v: Vlan): ResolvedVlan {
  const parsed = validation.parsed.get(v.id);
  const net4 = parsed?.ipv4 ?? null;
  const net6 = parsed?.ipv6 ?? [];
  const gw4 = v.ipv4.gateway.trim() === '' ? null : parseAddress(v.ipv4.gateway.trim(), 4);
  const gw6Text = v.ipv6.gateway.trim() === '' ? null : parseAddress(v.ipv6.gateway.trim(), 6);
  let gateway6: Gateway6 | null = null;
  if (gw6Text && gw6Text.ok) {
    const value = gw6Text.value.value;
    const linkLocal = value >= LINK_LOCAL_FIRST && value <= LINK_LOCAL_LAST;
    const home = linkLocal ? null : net6.find(p => { const r = prefixToRange(p); return value >= r.first && value <= r.last; }) ?? null;
    gateway6 = { value, linkLocal, home };
  }
  const pools: IpRange[] = [];
  for (const raw of v.ipv4.dhcp) {
    if (raw.trim() === '') continue;
    const r = itemRange(raw);
    if (r && r.family === 4) pools.push(r);
  }
  const reserved4: ReservedRange[] = [];
  const reserved6: ReservedRange[] = [];
  for (const entry of v.reserved) {
    if (entry.range.trim() === '') continue;
    const r = itemRange(entry.range);
    if (r) (r.family === 4 ? reserved4 : reserved6).push({ range: r, label: entry.label.trim() });
  }
  return {
    vlan: v, label: vlanLabel(v), number: parsed?.vlanNumber ?? null, name: v.name.trim(),
    site: plan.sites.find(s => s.id === v.siteId) ?? null,
    vrf: plan.vrfs.find(s => s.id === v.vrfId) ?? null,
    namespace: plan.namespaces.find(s => s.id === v.namespaceId) ?? null,
    net4, gateway4: gw4 && gw4.ok ? gw4.value.value : null,
    pools: mergeRanges(pools), reserved4, reserved6, net6, gateway6,
  };
}

export type ResolveResult = { readonly ok: true; readonly value: ResolvedPlan } | { readonly ok: false; readonly refusals: readonly string[] };

export function resolvePlan(plan: Plan): ResolveResult {
  const validation = validatePlan(plan);
  const errors = planErrors(plan, validation);
  if (errors) return { ok: false, refusals: errors };
  if (plan.vlans.length === 0) return { ok: false, refusals: ['The plan has no VLANs, so there is nothing to export.'] };
  return { ok: true, value: { plan, validation, vlans: plan.vlans.map(v => resolveVlan(plan, validation, v)) } };
}

export function inScope(v: ResolvedVlan, scope: ExportScope): boolean {
  return (scope.siteId === '' || v.vlan.siteId === scope.siteId)
    && (scope.vrfId === '' || v.vlan.vrfId === scope.vrfId)
    && (scope.namespaceId === '' || v.vlan.namespaceId === scope.namespaceId);
}

/** The VLANs in scope, by VLAN ID (VLANs without one last), then name, then plan order. */
export function scopedVlans(r: ResolvedPlan, scope: ExportScope): ResolvedVlan[] {
  return r.vlans.filter(v => inScope(v, scope))
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (a.v.number ?? 100_000) - (b.v.number ?? 100_000) || (a.v.name < b.v.name ? -1 : a.v.name > b.v.name ? 1 : 0) || a.i - b.i)
    .map(x => x.v);
}

/** A scope that names a site, VRF or namespace the plan does not have. */
export function scopeProblem(plan: Plan, scope: ExportScope): string | null {
  if (scope.siteId !== '' && !plan.sites.some(s => s.id === scope.siteId)) return 'The selected site is not in the plan.';
  if (scope.vrfId !== '' && !plan.vrfs.some(s => s.id === scope.vrfId)) return 'The selected VRF is not in the plan.';
  if (scope.namespaceId !== '' && !plan.namespaces.some(s => s.id === scope.namespaceId)) return 'The selected VLAN namespace is not in the plan.';
  return null;
}

/** "site Headquarters, VRF Global" for headers and messages. Names are shown in the page, never written into generated text. */
export function describeScope(plan: Plan, scope: ExportScope): string {
  const parts: string[] = [];
  parts.push(scope.siteId === '' ? 'all sites' : `site ${plan.sites.find(s => s.id === scope.siteId)?.name.trim() || scope.siteId}`);
  parts.push(scope.vrfId === '' ? 'all VRFs' : `VRF ${plan.vrfs.find(s => s.id === scope.vrfId)?.name.trim() || scope.vrfId}`);
  if (scope.namespaceId !== '') parts.push(`VLAN namespace ${plan.namespaces.find(s => s.id === scope.namespaceId)?.name.trim() || scope.namespaceId}`);
  return parts.join(', ');
}

export const ip4 = (value: bigint) => formatAddress(4, value);
export const ip6 = (value: bigint) => formatAddress(6, value);
export const cidr = (p: IpPrefix) => formatPrefix(p);

/** Dotted mask of an IPv4 prefix length. */
export function mask4(length: number): string {
  const mask = length === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - length)) - 1n);
  return formatAddress(4, mask);
}

/** The host addresses of an IPv4 network: everything but the network and broadcast addresses. Null for /31 and /32. */
export function usable4(p: IpPrefix): IpRange | null {
  if (p.length >= 31) return null;
  const r = prefixToRange(p);
  return { family: 4, first: r.first + 1n, last: r.last - 1n };
}

/** Pairs of VLANs in the list whose IPv4 networks overlap (legal reuse in independent VRFs). */
export function overlappingNetworks(vlans: readonly ResolvedVlan[]): Map<string, ResolvedVlan[]> {
  const withNet = vlans.filter(v => v.net4 !== null).map(v => ({ v, r: prefixToRange(v.net4!) })).sort((a, b) => (a.r.first < b.r.first ? -1 : a.r.first > b.r.first ? 1 : 0));
  const clashes = new Map<string, ResolvedVlan[]>();
  const add = (a: ResolvedVlan, b: ResolvedVlan) => { const list = clashes.get(a.vlan.id); if (list) list.push(b); else clashes.set(a.vlan.id, [b]); };
  for (let i = 0; i < withNet.length; i++) {
    for (let j = i + 1; j < withNet.length && withNet[j]!.r.first <= withNet[i]!.r.last; j++) {
      add(withNet[i]!.v, withNet[j]!.v);
      add(withNet[j]!.v, withNet[i]!.v);
    }
  }
  return clashes;
}
