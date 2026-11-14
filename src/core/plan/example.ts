/**
 * The example plan: two sites sharing a global VRF, a guest VRF at each site reusing the same
 * guest network (legal, since the guest VRFs are independent), the same VLAN IDs in each site's
 * own VLAN namespace, and two VLANs still waiting for automatic allocation.
 */
import { blankVlan, type Plan, type Vlan } from './model';

function vlan(id: string, fields: Partial<Omit<Vlan, 'ipv4' | 'ipv6'>> & { ipv4?: Partial<Vlan['ipv4']>; ipv6?: Partial<Vlan['ipv6']> }): Vlan {
  const v = blankVlan(id);
  const { ipv4, ipv6, ...rest } = fields;
  return { ...v, ...rest, ipv4: { ...v.ipv4, ...ipv4 }, ipv6: { ...v.ipv6, ...ipv6 } };
}

export function examplePlan(): Plan {
  const hq = { siteId: 's1', namespaceId: 'n1', vrfId: 'r1' };
  const br = { siteId: 's2', namespaceId: 'n2', vrfId: 'r1' };
  return {
    name: 'Example network',
    description: 'Headquarters and a branch office.',
    sites: [
      {
        id: 's1', name: 'Headquarters', description: 'Main campus', notes: '',
        blocks: [
          { id: 'b1', network: '10.10.0.0/16', vrfId: 'r1', description: 'HQ IPv4', reserved: [{ range: '10.10.255.0/24', label: 'Future WAN links' }] },
          { id: 'b2', network: '2001:db8:10::/48', vrfId: 'r1', description: 'HQ IPv6', reserved: [] },
          { id: 'b3', network: '192.168.100.0/24', vrfId: 'r2', description: 'HQ guest', reserved: [] },
        ],
      },
      {
        id: 's2', name: 'Branch office', description: '', notes: '',
        blocks: [
          { id: 'b4', network: '10.20.0.0/16', vrfId: 'r1', description: 'Branch IPv4', reserved: [] },
          { id: 'b5', network: '2001:db8:20::/48', vrfId: 'r1', description: 'Branch IPv6', reserved: [] },
          { id: 'b6', network: '192.168.100.0/24', vrfId: 'r3', description: 'Branch guest', reserved: [] },
        ],
      },
    ],
    vrfs: [
      { id: 'r1', name: 'Global', siteId: '', exchangesWith: [], description: 'Corporate routing table, shared by both sites.', notes: '' },
      { id: 'r2', name: 'Guest HQ', siteId: 's1', exchangesWith: [], description: 'Internet-only guest access.', notes: '' },
      { id: 'r3', name: 'Guest branch', siteId: 's2', exchangesWith: [], description: 'Internet-only guest access.', notes: '' },
    ],
    namespaces: [
      { id: 'n1', name: 'HQ switches', siteId: 's1', description: '' },
      { id: 'n2', name: 'Branch switches', siteId: 's2', description: '' },
    ],
    vlans: [
      vlan('v1', { ...hq, vlanId: '10', name: 'Users', hosts: '200', ipv4: { network: '10.10.10.0/24', gateway: '10.10.10.1', dhcp: ['10.10.10.100 - 10.10.10.250'] }, ipv6: { prefixes: ['2001:db8:10:10::/64'], gateway: 'fe80::1' }, reserved: [{ range: '10.10.10.2 - 10.10.10.20', label: 'Printers and access points' }] }),
      vlan('v2', { ...hq, vlanId: '20', name: 'Voice', hosts: '120', ipv4: { network: '10.10.20.0/24', gateway: '10.10.20.1', dhcp: ['10.10.20.50 - 10.10.20.200'] }, ipv6: { prefixes: ['2001:db8:10:20::/64'], gateway: 'fe80::1' } }),
      vlan('v3', { ...hq, vlanId: '30', name: 'Servers', hosts: '60', description: 'Static addressing only.', ipv4: { network: '10.10.30.0/25', gateway: '10.10.30.1', fixed: true }, ipv6: { prefixes: ['2001:db8:10:30::/64'], gateway: '2001:db8:10:30::1', fixed: true }, reserved: [{ range: '10.10.30.2 - 10.10.30.9', label: 'Hypervisor hosts' }] }),
      vlan('v4', { ...hq, vlanId: '99', name: 'Management', hosts: '40', ipv4: { network: '10.10.99.0/26', gateway: '10.10.99.1' } }),
      vlan('v5', { ...hq, vlanId: '40', name: 'Cameras', hosts: '80', notes: 'Waiting for a network: use Allocate.' }),
      vlan('v6', { siteId: 's1', namespaceId: 'n1', vrfId: 'r2', vlanId: '200', name: 'Guest', ipv4: { network: '192.168.100.0/24', gateway: '192.168.100.1', dhcp: ['192.168.100.10 - 192.168.100.250'] } }),
      vlan('v7', { ...br, vlanId: '10', name: 'Users', hosts: '150', ipv4: { network: '10.20.10.0/24', gateway: '10.20.10.1', dhcp: ['10.20.10.100 - 10.20.10.250'] }, ipv6: { prefixes: ['2001:db8:20:10::/64'], gateway: 'fe80::1' } }),
      vlan('v8', { ...br, vlanId: '20', name: 'Voice', hosts: '50', ipv4: { network: '10.20.20.0/25', gateway: '10.20.20.1', dhcp: ['10.20.20.20 - 10.20.20.120'] } }),
      vlan('v9', { siteId: 's2', namespaceId: 'n2', vrfId: 'r3', vlanId: '200', name: 'Guest', ipv4: { network: '192.168.100.0/24', gateway: '192.168.100.1', dhcp: ['192.168.100.10 - 192.168.100.250'] } }),
      vlan('v10', { ...br, vlanId: '50', name: 'Printers', hosts: '20' }),
    ],
  };
}
