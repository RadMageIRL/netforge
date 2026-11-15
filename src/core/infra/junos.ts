/**
 * Juniper Junos configuration snippets for a network plan, as "set" commands: VLANs, their IRB
 * gateway interfaces, and the routing instance each IRB interface belongs to.
 *
 * Written from the Junos configuration statement reference for switches that use Enhanced Layer 2
 * Software (ELS): EX and QFX series, where a VLAN's layer 3 interface is irb.<unit>. NetForge has
 * not loaded the output on a device.
 *
 * Safety rules:
 * - Only "set" lines. No delete, no deactivate, no commit, no physical interface, no
 *   routing-instance definition (instance type, route distinguisher): an IRB interface is added
 *   to an instance that must already exist.
 * - A VLAN name is the key of the VLAN in Junos, so it is always written; when the plan's name
 *   does not fit, a stated replacement is used and the item is marked approximate.
 * - Descriptions are written in double quotes, and only when they are printable ASCII without a
 *   double quote, a backslash or a question mark. Anything else is left out and reported.
 * - The output has no comment lines, so every line of it is a configuration statement.
 */
import type { Plan } from '../plan/model';
import { descriptionProblem, duplicateVlanNumbers, placeVrf, type DeviceContext } from './devices';
import { ItemBuilder, output, refused, type ExportItem, type ExportOutput, type Skipped } from './model';
import { cidr, ip4, ip6, resolvePlan, scopedVlans, scopeProblem } from './source';
import { nameToken } from './text';

export interface JunosSections {
  readonly vlans: boolean;
  readonly irb: boolean;
}

export interface JunosOptions {
  readonly context: DeviceContext;
  readonly sections: JunosSections;
}

/** Names start with a letter and use letters, digits, hyphens and underscores. */
export const JUNOS_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const JUNOS_VLAN_NAME_MAX = 64;
/** Starts with a letter or digit; "default" and "master" are the names Junos gives its own instances. */
export const JUNOS_INSTANCE_NAME = /^(?!(?:default|master)$)[A-Za-z0-9][A-Za-z0-9_-]*$/i;
export const JUNOS_INSTANCE_NAME_MAX = 64;
const JUNOS_DESCRIPTION_FORBIDDEN = /["\\?]/;
/** Names Junos already uses or reserves. */
const JUNOS_RESERVED_NAMES = new Set(['default', 'all']);

const JUNOS_NOT_COVERED: readonly string[] = [
  'Physical interfaces: trunk and access ports, VLAN membership, aggregated Ethernet. Nothing assigns a VLAN to a port.',
  'Routing-instance definitions (instance type, route distinguisher, targets). An IRB interface is only added to an instance that already exists.',
  'DHCP server, DHCP relay and router advertisement configuration. The plan\'s DHCP pools are not written for Junos.',
  'VRRP, routing protocols, static routes and firewall filters.',
  'Switches without ELS (which use vlan.<unit> interfaces), and MX routers (bridge domains).',
  'A commit: the output has no commit command.',
];

export function junosConfig(plan: Plan, options: JunosOptions): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const { context, sections } = options;
  const problem = scopeProblem(plan, context.scope);
  if (problem) return refused([problem]);
  if (!sections.vlans && !sections.irb) return refused(['Choose at least one section to write.'], { notCovered: JUNOS_NOT_COVERED });
  const vlans = scopedVlans(resolved.value, context.scope);
  if (vlans.length === 0) return refused(['No VLAN is in this selection.'], { notCovered: JUNOS_NOT_COVERED });
  const duplicates = duplicateVlanNumbers(vlans);

  // Every VLAN needs a unique name. Plan names that fit are kept; the rest get VLAN<id>.
  const chosen = new Map<string, { name: string; change: string | null }>();
  const taken = new Map<string, number>();
  for (const v of vlans) {
    // VLANs that are not written (no ID, ID 1, an ID used twice) do not use up a name.
    if (v.number === null || v.number === 1 || duplicates.has(v.number)) continue;
    const t = v.name === '' ? null : nameToken(v.name, JUNOS_NAME, JUNOS_VLAN_NAME_MAX, '-');
    let pick: { name: string; change: string | null };
    if (t === null) pick = { name: `VLAN${v.number}`, change: 'The plan has no name for this VLAN and Junos needs one' };
    else if (t.kind === 'refused') pick = { name: `VLAN${v.number}`, change: `"${v.name.slice(0, 40)}" cannot be a Junos VLAN name (${t.reason})` };
    else if (JUNOS_RESERVED_NAMES.has(t.value.toLowerCase())) pick = { name: `VLAN${v.number}`, change: `"${t.value}" is a name Junos reserves` };
    else pick = { name: t.value, change: t.kind === 'approximate' ? `Junos names are one word: ${t.change}` : null };
    chosen.set(v.vlan.id, pick);
    taken.set(pick.name, (taken.get(pick.name) ?? 0) + 1);
  }
  for (const v of vlans) {
    const pick = chosen.get(v.vlan.id);
    if (!pick || (taken.get(pick.name) ?? 0) < 2 || pick.name === `VLAN${v.number}`) continue;
    chosen.set(v.vlan.id, { name: `VLAN${v.number}`, change: `The name ${pick.name} would be used by more than one VLAN in this export` });
  }

  const finalCount = new Map<string, number>();
  for (const pick of chosen.values()) finalCount.set(pick.name, (finalCount.get(pick.name) ?? 0) + 1);

  const items: ExportItem[] = [];
  const skipped: Skipped[] = [];
  const vlanLines: string[] = [];
  const irbLines: string[] = [];
  const instanceLines: string[] = [];
  let wroteInstance = false;

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
    if (n === 1) {
      item.unsupported('VLAN', 'VLAN ID 1 belongs to the VLAN named "default" in the factory configuration of ELS switches. On a switch that still has it, a second VLAN with ID 1 fails the commit check, so nothing is written.');
      items.push(item.build());
      continue;
    }
    const pick = chosen.get(v.vlan.id)!;
    if ((finalCount.get(pick.name) ?? 0) > 1) {
      item.unsupported('VLAN', `No unique Junos name is available: ${pick.name} is also the name of another VLAN in this export. Rename one of them in the plan.`);
      items.push(item.build());
      continue;
    }
    const hasGateway = v.gateway4 !== null || v.gateway6 !== null;
    const where = sections.irb && hasGateway ? placeVrf(v, context, JUNOS_INSTANCE_NAME, JUNOS_INSTANCE_NAME_MAX, 'Junos routing-instance name') : null;
    const writeIrb = where !== null && where.kind !== 'unknown' && !(v.gateway4 !== null && v.net4 !== null && v.net4.length === 32 && v.gateway6 === null);

    if (sections.vlans) {
      vlanLines.push(`set vlans ${pick.name} vlan-id ${n}`);
      item.wrote(`vlan ${pick.name} with vlan-id ${n}`);
      if (pick.change) item.approximate('Name', `${pick.change}, so the VLAN is named ${pick.name}.`);
      const text = v.vlan.description.trim();
      if (text !== '') {
        const bad = descriptionProblem(text, JUNOS_DESCRIPTION_FORBIDDEN, 'a double quote, a backslash or a question mark');
        if (bad) item.unsupported('Description', `It is not written: ${bad}.`);
        else vlanLines.push(`set vlans ${pick.name} description "${text}"`);
      }
      if (writeIrb) vlanLines.push(`set vlans ${pick.name} l3-interface irb.${n}`);
    }

    if (sections.irb) {
      if (!hasGateway) {
        if (v.net4 !== null || v.net6.length > 0) item.remark('The plan has no gateway address for this VLAN, so no IRB interface is written.');
      } else if (where!.kind === 'unknown') item.unsupported('IRB interface', `irb.${n} is not written. ${where!.reason}`);
      else if (!writeIrb) item.unsupported('IRB interface', `irb.${n} is not written: ${cidr(v.net4!)} is a single address.`);
      else {
        const wrote: string[] = [];
        if (v.gateway4 !== null && v.net4 !== null && v.net4.length < 32) { irbLines.push(`set interfaces irb unit ${n} family inet address ${ip4(v.gateway4)}/${v.net4.length}`); wrote.push(`${ip4(v.gateway4)}/${v.net4.length}`); }
        else if (v.gateway4 !== null && v.net4 !== null) item.unsupported('IPv4 address', `${ip4(v.gateway4)} is not written on irb.${n}: ${cidr(v.net4)} is a single address.`);
        if (v.gateway6) {
          const length = v.gateway6.linkLocal ? 64 : v.gateway6.home?.length ?? null;
          if (length !== null) { irbLines.push(`set interfaces irb unit ${n} family inet6 address ${ip6(v.gateway6.value)}/${length}`); wrote.push(`${ip6(v.gateway6.value)}/${length}${v.gateway6.linkLocal ? ' (link-local)' : ''}`); }
        }
        for (const p of v.net6) {
          if (v.gateway6 && v.gateway6.home === p) continue;
          item.unsupported('IPv6 prefix', `${cidr(p)} is not configured on the interface: the plan gives the gateway no address in it${v.gateway6?.linkLocal ? ' (only a link-local address)' : ''}.`);
        }
        if (where!.kind === 'named') { instanceLines.push(`set routing-instances ${where!.name} interface irb.${n}`); wroteInstance = true; }
        item.wrote(`irb.${n} with ${wrote.join(' and ')}${where!.kind === 'named' ? ` in routing instance ${where!.name}` : ' in the default routing instance'}`);
        if (!sections.vlans) item.remark(`The VLAN section is off, so no l3-interface line ties irb.${n} to its VLAN.`);
      }
    }
    if (v.pools.length > 0) item.unsupported('DHCP pools', `${v.pools.length === 1 ? 'The DHCP pool is' : `The ${v.pools.length} DHCP pools are`} not written: this export has no Junos DHCP configuration.`);

    const built = item.build();
    if (built.written.length === 0 && built.notes.length === 0) skipped.push({ subject: v.label, reason: built.remarks[0] ?? 'the plan has nothing for the chosen sections.' });
    else items.push(built);
  }

  const body = [...vlanLines, ...irbLines, ...instanceLines];
  if (body.length === 0) return refused(['Nothing in this selection can be written for the chosen sections. The notes say why for each VLAN.'], { items, skipped, notCovered: JUNOS_NOT_COVERED });
  const manualSteps = [
    'Compare the lines with the candidate and active configuration first: a set line for something that exists changes it.',
    'Load the lines in configuration mode, run "show | compare" and "commit check", and commit yourself. The output has no commit command; "commit confirmed" gives you an automatic rollback.',
    'Assign the VLANs to interfaces; no port configuration is written.',
  ];
  if (wroteInstance) manualSteps.push('Each routing instance must already exist with its instance type. Moving an existing interface into an instance changes its routing: use these lines for new IRB units only.');
  if (irbLines.length > 0) manualSteps.push('An IRB interface comes up once its VLAN has an active port. Check that no other device already answers for these gateway addresses.');
  return output({
    files: [{ name: 'netforge-junos.txt', kind: 'Junos set commands', mime: 'text/plain', text: `${body.join('\n')}\n` }],
    items, skipped,
    assumptions: [
      'An EX or QFX series switch running Junos with Enhanced Layer 2 Software (ELS), where VLANs are under "vlans" and their layer 3 interfaces are irb units.',
      'The IRB unit number is the VLAN ID. That is a convention, not a requirement.',
      'The device is the gateway of each VLAN: the plan\'s gateway address is put on the IRB unit. With VRRP the plan\'s gateway is usually the virtual address instead, which this export does not write.',
      'The output has no comment lines; these notes are the commentary.',
    ],
    manualSteps, notCovered: JUNOS_NOT_COVERED,
  });
}
