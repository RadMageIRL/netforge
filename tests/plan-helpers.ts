/** Plan builders for tests. */
import { blankVlan, type Plan, type Vlan } from '../src/core/plan/model';

export type VlanSpec = Partial<Omit<Vlan, 'ipv4' | 'ipv6'>> & { ipv4?: Partial<Vlan['ipv4']>; ipv6?: Partial<Vlan['ipv6']> };

export function makeVlan(id: string, spec: VlanSpec = {}): Vlan {
  const v = blankVlan(id, { siteId: 's1', namespaceId: 'n1', vrfId: 'r1' });
  const { ipv4, ipv6, ...rest } = spec;
  return { ...v, vlanId: String(10 * (Number(id.replace(/\D/g, '')) || 1)), name: `VLAN ${id}`, ...rest, ipv4: { ...v.ipv4, ...ipv4 }, ipv6: { ...v.ipv6, ...ipv6 } };
}

/** One site (s1), one global VRF (r1), one namespace (n1) unless overridden, and the given VLANs. */
export function makePlan(vlans: VlanSpec[] = [], extra: Partial<Plan> = {}): Plan {
  return {
    name: 'Test', description: '',
    sites: [{ id: 's1', name: 'Site one', description: '', notes: '', blocks: [] }],
    vrfs: [{ id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: '', notes: '' }],
    namespaces: [{ id: 'n1', name: 'Site one switches', siteId: 's1', description: '' }],
    vlans: vlans.map((v, i) => makeVlan(v.id ?? `v${i + 1}`, v)),
    ...extra,
  };
}

/**
 * A valid enterprise-style plan of `count` VLANs: 50 VLANs per site, each site with its own VLAN
 * namespace, IPv4 and IPv6 parent blocks in the global VRF, and a guest VRF reusing 192.168.0.0/16.
 * Every VLAN has a network, gateway, DHCP pool, reservation and IPv6 prefix.
 */
export function syntheticPlan(count: number): Plan {
  const perSite = 50;
  const siteCount = Math.ceil(count / perSite);
  const plan: Plan = { name: `Synthetic ${count}`, description: '', sites: [], vrfs: [{ id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: '', notes: '' }], namespaces: [], vlans: [] };
  for (let s = 1; s <= siteCount; s++) {
    plan.sites.push({ id: `s${s}`, name: `Site ${s}`, description: '', notes: '', blocks: [
      { id: `b${s}a`, network: `10.${s}.0.0/16`, vrfId: 'r1', description: '', reserved: [{ range: `10.${s}.255.0/24`, label: 'links' }] },
      { id: `b${s}b`, network: `2001:db8:${s.toString(16)}::/48`, vrfId: 'r1', description: '', reserved: [] },
      { id: `b${s}c`, network: '192.168.0.0/16', vrfId: `g${s}`, description: '', reserved: [] },
    ] });
    plan.vrfs.push({ id: `g${s}`, name: `Guest ${s}`, siteId: `s${s}`, exchangesWith: [], description: '', notes: '' });
    plan.namespaces.push({ id: `n${s}`, name: `Site ${s} switches`, siteId: `s${s}`, description: '' });
  }
  for (let i = 0; i < count; i++) {
    const s = Math.floor(i / perSite) + 1;
    const k = (i % perSite) + 1;
    const guest = k === perSite;
    const net = guest ? `192.168.${k}.0/24` : `10.${s}.${k}.0/24`;
    const base = guest ? `192.168.${k}` : `10.${s}.${k}`;
    plan.vlans.push(makeVlan(`v${i + 1}`, {
      vlanId: String(k * 10), name: guest ? 'Guest' : `Segment ${k}`, siteId: `s${s}`, namespaceId: `n${s}`, vrfId: guest ? `g${s}` : 'r1', hosts: '200',
      ipv4: { network: net, gateway: `${base}.1`, dhcp: [`${base}.100 - ${base}.250`] },
      ipv6: { prefixes: guest ? [] : [`2001:db8:${s.toString(16)}:${k.toString(16)}::/64`], gateway: guest ? '' : 'fe80::1' },
      reserved: [{ range: `${base}.2 - ${base}.20`, label: 'infrastructure' }],
    }));
  }
  return plan;
}
