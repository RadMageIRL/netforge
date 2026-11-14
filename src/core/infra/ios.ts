/**
 * Cisco IOS / IOS-XE configuration snippets for a network plan: VLAN declarations, gateway
 * interfaces (SVIs) and DHCP pools. Snippets, not a device configuration: they are lines for
 * global configuration mode, to be reviewed and pasted by a person.
 *
 * Written from the IOS and IOS-XE command references. NetForge has not loaded them on a device.
 *
 * Safety rules:
 * - No "no ..." command, no shutdown or no shutdown, no VRF definition, no trunk or access port,
 *   no routing protocol, no "end", no "write memory". Only lines that add what the plan states.
 * - Plan text reaches a line only as a checked one-word name or a checked description: printable
 *   ASCII, no "?" (the CLI help key), no line breaks. Anything else is left out and reported.
 * - Addresses and masks are written from parsed numbers.
 */
import { prefixToRange } from '../net/address';
import { subtractRanges } from '../net/ops';
import type { Plan } from '../plan/model';
import { descriptionProblem, duplicateVlanNumbers, placeVrf, type DeviceContext, type VrfPlacement } from './devices';
import { ItemBuilder, output, refused, type ExportItem, type ExportOutput, type Skipped } from './model';
import { cidr, ip4, ip6, mask4, resolvePlan, scopedVlans, scopeProblem, usable4, type ResolvedVlan } from './source';
import { checkDnsName, nameToken, parseDnsServers } from './text';

export interface IosSections {
  readonly vlans: boolean;
  readonly svis: boolean;
  readonly dhcp: boolean;
}

export interface IosOptions {
  readonly context: DeviceContext;
  readonly sections: IosSections;
  /** DNS servers for DHCP pools, separated by commas or spaces; empty to write none. */
  readonly dnsServers: string;
  /** Domain name for DHCP pools; empty to write none. */
  readonly dnsDomain: string;
}

/** One-word names: a conservative subset of what IOS accepts. */
export const IOS_NAME = /^[A-Za-z0-9_.-]+$/;
export const IOS_VLAN_NAME_MAX = 32;
export const IOS_VRF_NAME_MAX = 32;
const IOS_DESCRIPTION_FORBIDDEN = /\?/;

const IOS_NOT_COVERED: readonly string[] = [
  'Switch ports: trunks, allowed VLAN lists, access ports, port channels and spanning tree.',
  'VRF definitions (route distinguishers, route targets, address families). Interfaces are placed in a VRF that must already exist.',
  'First-hop redundancy (HSRP, VRRP), routing protocols, static routes, ACLs and IP helper addresses.',
  'Global commands such as ip routing, ipv6 unicast-routing and service dhcp.',
  'DHCPv6, DHCP lease times (the IOS default of one day applies) and DHCP options other than the router, DNS servers and domain name.',
  'NX-OS and IOS XR, which use different commands.',
];

function vrfSuffix(p: VrfPlacement): string {
  return p.kind === 'named' ? ` vrf ${p.name}` : '';
}

export function iosConfig(plan: Plan, options: IosOptions): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const { context, sections } = options;
  const problem = scopeProblem(plan, context.scope);
  if (problem) return refused([problem]);
  const refusals: string[] = [];
  if (!sections.vlans && !sections.svis && !sections.dhcp) refusals.push('Choose at least one section to write.');
  const dns = parseDnsServers(sections.dhcp ? options.dnsServers : '');
  if (!dns.ok) refusals.push(`DNS servers: ${dns.message}`);
  const domain = sections.dhcp ? options.dnsDomain.trim() : '';
  if (domain !== '') {
    const bad = checkDnsName(domain);
    if (bad) refusals.push(`Domain name: ${bad}`);
  }
  if (refusals.length > 0 || !dns.ok) return refused(refusals, { notCovered: IOS_NOT_COVERED });

  const vlans = scopedVlans(resolved.value, context.scope);
  if (vlans.length === 0) return refused(['No VLAN is in this selection.'], { notCovered: IOS_NOT_COVERED });
  const duplicates = duplicateVlanNumbers(vlans);

  // VLAN names must be unique on a switch: a name two VLANs would share is written for neither.
  const tokens = new Map<string, ReturnType<typeof nameToken>>();
  const tokenCount = new Map<string, number>();
  for (const v of vlans) {
    // Only VLANs that get a vlan line take part: one that is not written cannot use up a name.
    if (v.name === '' || v.number === null || v.number === 1 || (v.number >= 1002 && v.number <= 1005) || duplicates.has(v.number)) continue;
    const t = nameToken(v.name, IOS_NAME, IOS_VLAN_NAME_MAX, '_');
    tokens.set(v.vlan.id, t);
    if (t.kind !== 'refused') tokenCount.set(t.value.toLowerCase(), (tokenCount.get(t.value.toLowerCase()) ?? 0) + 1);
  }

  const items: ExportItem[] = [];
  const skipped: Skipped[] = [];
  const vlanLines: string[] = [];
  const sviLines: string[] = [];
  const dhcpLines: string[] = [];
  let extended = false;
  let wroteIpv6 = false;
  let wroteVrf = false;

  const place = (v: ResolvedVlan) => placeVrf(v, context, IOS_NAME, IOS_VRF_NAME_MAX, 'IOS VRF name');

  for (const v of vlans) {
    const item = new ItemBuilder(v.label);
    if (v.number === null) { item.unsupported('VLAN', 'The VLAN has no ID in the plan.'); items.push(item.build()); continue; }
    const n = v.number;
    const twins = duplicates.get(n);
    if (twins) {
      item.unsupported('VLAN', `VLAN ${n} appears ${twins.length} times in this selection (VLAN namespaces: ${twins.map(t => t.namespace?.name.trim() || t.vlan.namespaceId).join(', ')}). A switch has one VLAN ${n}: export one VLAN namespace at a time.`);
      items.push(item.build());
      continue;
    }
    if (n >= 1002 && n <= 1005) { item.unsupported('VLAN', `VLAN ${n} is reserved on Cisco switches (FDDI and Token Ring defaults) and cannot be used.`); items.push(item.build()); continue; }

    if (sections.vlans) {
      if (n === 1) {
        item.remark('VLAN 1 exists on every switch and cannot be created or renamed, so no vlan lines are written for it.');
        if (v.name !== '') item.unsupported('Name', 'The name of VLAN 1 cannot be changed on IOS.');
      } else {
        vlanLines.push(`vlan ${n}`);
        item.wrote(`vlan ${n}`);
        if (n >= 1006) extended = true;
        const t = tokens.get(v.vlan.id);
        if (t) {
          if (t.kind === 'refused') item.unsupported('Name', `"${v.name.slice(0, 40)}" is not written as the VLAN name: ${t.reason}. IOS VLAN names are one word of up to ${IOS_VLAN_NAME_MAX} characters.`);
          else if ((tokenCount.get(t.value.toLowerCase()) ?? 0) > 1) item.unsupported('Name', `The name ${t.value} would be used by more than one VLAN in this export, and IOS VLAN names must be unique, so it is not written.`);
          else {
            vlanLines.push(` name ${t.value}`);
            item.wrote(`name ${t.value}`);
            if (t.kind === 'approximate') item.approximate('Name', `IOS VLAN names are one word: ${t.change}.`);
          }
        }
        vlanLines.push('!');
      }
    }

    if (sections.svis) {
      if (v.gateway4 === null && v.gateway6 === null) {
        if (v.net4 !== null || v.net6.length > 0) item.remark('The plan has no gateway address for this VLAN, so no interface is written.');
      } else {
        const where = place(v);
        if (where.kind === 'unknown') item.unsupported('Gateway interface', `interface Vlan${n} is not written. ${where.reason}`);
        else if (v.gateway4 !== null && v.net4 !== null && v.net4.length === 32 && v.gateway6 === null) item.unsupported('Gateway interface', `interface Vlan${n} is not written: ${cidr(v.net4)} is a single address.`);
        else {
          const lines = [`interface Vlan${n}`];
          const text = v.vlan.description.trim();
          if (text !== '') {
            const bad = descriptionProblem(text, IOS_DESCRIPTION_FORBIDDEN, 'a question mark, which is the help key of the IOS command line');
            if (bad) item.unsupported('Description', `It is not written: ${bad}.`);
            else lines.push(` description ${text}`);
          }
          if (where.kind === 'named') { lines.push(` vrf forwarding ${where.name}`); wroteVrf = true; }
          const wrote: string[] = [];
          if (v.gateway4 !== null && v.net4 !== null && v.net4.length < 32) { lines.push(` ip address ${ip4(v.gateway4)} ${mask4(v.net4.length)}`); wrote.push(`${ip4(v.gateway4)}/${v.net4.length}`); }
          else if (v.gateway4 !== null && v.net4 !== null) item.unsupported('IPv4 address', `${ip4(v.gateway4)} is not written on interface Vlan${n}: ${cidr(v.net4)} is a single address.`);
          if (v.gateway6) {
            wroteIpv6 = true;
            if (v.gateway6.linkLocal) { lines.push(` ipv6 address ${ip6(v.gateway6.value)} link-local`); wrote.push(`${ip6(v.gateway6.value)} (link-local)`); }
            else if (v.gateway6.home) { lines.push(` ipv6 address ${ip6(v.gateway6.value)}/${v.gateway6.home.length}`); wrote.push(`${ip6(v.gateway6.value)}/${v.gateway6.home.length}`); }
          }
          for (const p of v.net6) {
            if (v.gateway6 && v.gateway6.home === p) continue;
            item.unsupported('IPv6 prefix', `${cidr(p)} is not configured on the interface: the plan gives the gateway no address in it${v.gateway6?.linkLocal ? ' (only a link-local address)' : ''}, so the interface would not advertise it.`);
          }
          lines.push('!');
          sviLines.push(...lines);
          item.wrote(`interface Vlan${n} with ${wrote.join(' and ')}${where.kind === 'named' ? ` in VRF ${where.name}` : ' in the global routing table'}`);
        }
      }
    }

    if (sections.dhcp && v.pools.length > 0 && v.net4 !== null) {
      const usable = usable4(v.net4);
      const where = place(v);
      if (usable === null) item.unsupported('DHCP pool', `${cidr(v.net4)} has no host range for a DHCP pool.`);
      else if (where.kind === 'unknown') item.unsupported('DHCP pool', `It is not written. ${where.reason}`);
      else {
        const net = prefixToRange(v.net4);
        const excluded = subtractRanges(usable, v.pools);
        for (const e of excluded) dhcpLines.push(`ip dhcp excluded-address${vrfSuffix(where)} ${ip4(e.first)}${e.first === e.last ? '' : ` ${ip4(e.last)}`}`);
        dhcpLines.push(`ip dhcp pool VLAN${n}`);
        if (where.kind === 'named') { dhcpLines.push(` vrf ${where.name}`); wroteVrf = true; }
        dhcpLines.push(` network ${ip4(net.first)} ${mask4(v.net4.length)}`);
        if (v.gateway4 !== null) dhcpLines.push(` default-router ${ip4(v.gateway4)}`);
        else item.remark('The plan has no gateway for this VLAN, so the DHCP pool has no default-router line.');
        if (dns.values.length > 0) dhcpLines.push(` dns-server ${dns.values.join(' ')}`);
        if (domain !== '') dhcpLines.push(` domain-name ${domain}`);
        dhcpLines.push('!');
        item.wrote(`DHCP pool VLAN${n} leasing ${v.pools.map(p => (p.first === p.last ? ip4(p.first) : `${ip4(p.first)} to ${ip4(p.last)}`)).join(', ')} (${excluded.length === 1 ? '1 excluded range' : `${excluded.length} excluded ranges`})`);
      }
    }

    const built = item.build();
    if (built.written.length === 0 && built.notes.length === 0) skipped.push({ subject: v.label, reason: built.remarks[0] ?? 'the plan has nothing for the chosen sections.' });
    else items.push(built);
  }

  const body: string[] = [];
  if (vlanLines.length > 0) body.push('! VLANs', ...vlanLines);
  if (sviLines.length > 0) body.push('! Gateway interfaces (SVIs)', ...sviLines);
  if (dhcpLines.length > 0) body.push('! DHCP: excluded addresses first, then pools', ...dhcpLines);
  if (body.length === 0) return refused(['Nothing in this selection can be written for the chosen sections. The notes say why for each VLAN.'], { items, skipped, notCovered: IOS_NOT_COVERED });
  const head = [
    '! NetForge preview: Cisco IOS / IOS-XE configuration snippet generated from a network plan.',
    '! Not a complete configuration. NetForge has not loaded it on a device.',
    '! Review every line, then paste it in global configuration mode yourself.',
    '!',
  ];
  const manualSteps = [
    'Compare the snippet with the running configuration first: a line for a VLAN, interface or pool that already exists changes that existing object.',
    'Save the configuration yourself after checking the result; the snippet has no end or write command.',
    'Assign the VLANs to trunks and access ports; no port configuration is written.',
  ];
  if (extended) manualSteps.push('VLANs 1006 to 4094 are extended-range VLANs: the switch must run VTP version 3 or be in VTP transparent mode to create them.');
  if (wroteVrf) manualSteps.push('Each named VRF must already exist on the device (vrf definition with its address families). Applying "vrf forwarding" to an interface that already has addresses removes them: use it on new interfaces only.');
  if (wroteIpv6) manualSteps.push('IPv6 routing must be enabled on the device (ipv6 unicast-routing) for the IPv6 addresses to route.');
  if (sviLines.length > 0) manualSteps.push('A new VLAN interface comes up as soon as the VLAN is active on a port. Check that no other device already answers for these gateway addresses. Interface Vlan1 is shut down by default and stays so: nothing here enables it.');
  if (dhcpLines.length > 0) manualSteps.push('Check that no DHCP pool named VLAN<id> exists already, and that the DHCP service is enabled. The device starts leasing as soon as a pool is complete.');
  return output({
    files: [{ name: 'netforge-ios.txt', kind: 'Cisco IOS / IOS-XE configuration', mime: 'text/plain', text: `${[...head, ...body].join('\n')}\n` }],
    items, skipped,
    assumptions: [
      'A Catalyst-style layer 3 switch running IOS 15 or IOS-XE 16 or later, in global configuration mode. Routers without switch ports, NX-OS and IOS XR use other commands.',
      'VLANs are written in configuration mode (vlan <id>), not VLAN database mode.',
      'The device is the gateway of each VLAN: the plan\'s gateway address is put on interface Vlan<id>. With HSRP or VRRP the plan\'s gateway is usually the virtual address instead, which this export does not write.',
      'VRFs use the "vrf definition" form, so interfaces take "vrf forwarding <name>". Older "ip vrf" configurations use "ip vrf forwarding".',
      ...(dhcpLines.length > 0 ? ['An IOS DHCP pool leases its whole network except excluded addresses. Everything outside the plan\'s pools is excluded first, so only the plan\'s pools are leased.'] : []),
    ],
    manualSteps, notCovered: IOS_NOT_COVERED,
  });
}
