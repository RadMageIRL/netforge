/**
 * The network plan: sites, VRFs (routing domains), VLAN namespaces and VLANs.
 *
 * Three identities are kept apart on purpose:
 * - A site is a place: a building, a campus, a data center.
 * - A VRF is a routing domain. Networks must not overlap inside one VRF, or between VRFs that
 *   exchange routes. The same network may be reused in VRFs that are independent of each other.
 * - A VLAN namespace is a switching domain. VLAN IDs must be unique inside one namespace and may
 *   repeat in another. A namespace is not tied to a VRF, and a VRF does not make VLAN IDs unique.
 *
 * Every value a person types is kept as the text typed, so an unfinished plan saves and reopens
 * unchanged. validate.ts interprets the text and reports what is wrong with it.
 */

/** A reserved address, range or CIDR block, with an optional label. */
export interface ReservedEntry {
  range: string;
  label: string;
}

/** Address space a site may use in one VRF. VLAN networks in that site and VRF must fall inside its blocks. */
export interface ParentBlock {
  id: string;
  network: string;
  vrfId: string;
  description: string;
  /** Space inside the block that automatic allocation leaves alone. */
  reserved: ReservedEntry[];
}

export interface Site {
  id: string;
  name: string;
  description: string;
  notes: string;
  blocks: ParentBlock[];
}

export interface Vrf {
  id: string;
  name: string;
  /** The site the VRF exists at, or '' when it is available at every site. */
  siteId: string;
  /** VRFs that exchange routes with this one (route leaking, shared services). Overlaps with them are errors. */
  exchangesWith: string[];
  description: string;
  notes: string;
}

export interface VlanNamespace {
  id: string;
  name: string;
  /** The site the namespace belongs to, or '' when it spans sites (a stretched layer 2 domain). */
  siteId: string;
  description: string;
}

export interface Ipv4Settings {
  network: string;
  gateway: string;
  /** DHCP pools: each a range "first - last", a single address or a CIDR block. */
  dhcp: string[];
  /** Kept as is when automatic allocation reassigns networks. */
  fixed: boolean;
}

export interface Ipv6Settings {
  prefixes: string[];
  gateway: string;
  fixed: boolean;
}

export interface Vlan {
  id: string;
  vlanId: string;
  name: string;
  siteId: string;
  namespaceId: string;
  vrfId: string;
  /** Usable IPv4 addresses the VLAN needs, including its gateway. Empty for no target. */
  hosts: string;
  description: string;
  notes: string;
  ipv4: Ipv4Settings;
  ipv6: Ipv6Settings;
  /** Reserved addresses inside the VLAN's networks (either family). */
  reserved: ReservedEntry[];
}

export interface Plan {
  name: string;
  description: string;
  sites: Site[];
  vrfs: Vrf[];
  namespaces: VlanNamespace[];
  vlans: Vlan[];
}

export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** The lowest unused id of the form prefix + number. */
export function nextId(prefix: string, taken: Iterable<{ id: string }>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.id);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function blankVlan(id: string, defaults: Partial<Pick<Vlan, 'siteId' | 'namespaceId' | 'vrfId'>> = {}): Vlan {
  return {
    id, vlanId: '', name: '', siteId: defaults.siteId ?? '', namespaceId: defaults.namespaceId ?? '', vrfId: defaults.vrfId ?? '',
    hosts: '', description: '', notes: '',
    ipv4: { network: '', gateway: '', dhcp: [], fixed: false },
    ipv6: { prefixes: [], gateway: '', fixed: false },
    reserved: [],
  };
}

/** A new plan: one site, one VRF available everywhere and one VLAN namespace for the site. */
export function emptyPlan(): Plan {
  return {
    name: '',
    description: '',
    sites: [{ id: 's1', name: 'Main site', description: '', notes: '', blocks: [] }],
    vrfs: [{ id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: 'The global routing table.', notes: '' }],
    namespaces: [{ id: 'n1', name: 'Main site switches', siteId: 's1', description: '' }],
    vlans: [],
  };
}

export function clonePlan(plan: Plan): Plan {
  return structuredClone(plan);
}

/** VRFs that may be used at a site: those at that site and those available everywhere. */
export function vrfsForSite(plan: Plan, siteId: string): Vrf[] {
  return plan.vrfs.filter(v => v.siteId === '' || v.siteId === siteId);
}

export function namespacesForSite(plan: Plan, siteId: string): VlanNamespace[] {
  return plan.namespaces.filter(n => n.siteId === '' || n.siteId === siteId);
}

/** Defaults for a new VLAN at a site: its first usable VRF and namespace. */
export function vlanDefaults(plan: Plan, siteId: string): Pick<Vlan, 'siteId' | 'namespaceId' | 'vrfId'> {
  return { siteId, vrfId: vrfsForSite(plan, siteId)[0]?.id ?? '', namespaceId: namespacesForSite(plan, siteId)[0]?.id ?? '' };
}

/** VRF ids whose routes meet `vrfId`'s: itself and every VRF either side lists in exchangesWith. */
export function routingNeighbors(plan: Plan, vrfId: string): Set<string> {
  const out = new Set<string>([vrfId]);
  for (const v of plan.vrfs) {
    if (v.id === vrfId) v.exchangesWith.forEach(id => out.add(id));
    else if (v.exchangesWith.includes(vrfId)) out.add(v.id);
  }
  return out;
}

/** How many VLANs (and parent blocks) refer to each site, VRF and namespace. */
export function usage(plan: Plan): { sites: Map<string, number>; vrfs: Map<string, number>; namespaces: Map<string, number> } {
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const sites = new Map<string, number>();
  const vrfs = new Map<string, number>();
  const namespaces = new Map<string, number>();
  for (const v of plan.vlans) {
    bump(sites, v.siteId);
    bump(vrfs, v.vrfId);
    bump(namespaces, v.namespaceId);
  }
  for (const s of plan.sites) for (const b of s.blocks) bump(vrfs, b.vrfId);
  for (const v of plan.vrfs) if (v.siteId) bump(sites, v.siteId);
  for (const n of plan.namespaces) if (n.siteId) bump(sites, n.siteId);
  return { sites, vrfs, namespaces };
}
