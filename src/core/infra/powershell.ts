/**
 * PowerShell previews for a network plan: Windows DHCP Server scopes (the DhcpServer module) and a
 * read-only plan report. Nothing is run. Every string from the plan is written as a single-quoted
 * literal by the Phase 3 writer, which doubles every quote character PowerShell recognizes and
 * refuses control characters; addresses are written from parsed numbers, never from typed text.
 *
 * DHCP mapping. A Windows scope is one address range in a subnet, with exclusion ranges inside
 * it. A plan has any number of DHCP pools per VLAN. The scope is written over the whole host
 * range of the network, and everything outside the plan's pools is excluded, so the addresses
 * the server can lease are exactly the plan's pools.
 */
import { prefixToRange, type IpRange } from '../net/address';
import { subtractRanges } from '../net/ops';
import { psQuote } from '../schedule/commands';
import { hasLoneSurrogate } from './hcl';
import { ItemBuilder, output, refused, type ExportItem, type ExportOutput, type Skipped } from './model';
import { cidr, ip4, ip6, mask4, overlappingNetworks, resolvePlan, scopedVlans, scopeProblem, usable4, type ExportScope, type ResolvedVlan } from './source';
import { checkComputerName, checkDnsName, hasControl, macWithDashes, parseDnsServers, parseMac } from './text';
import type { Plan } from '../plan/model';

export interface DhcpOptions {
  readonly scope: ExportScope;
  /** -ComputerName for every command; empty for the server the script runs on. */
  readonly computerName: string;
  /** DNS servers for option 6, separated by commas or spaces; empty to leave the option unset. */
  readonly dnsServers: string;
  /** DNS domain for option 15; empty to leave it unset. */
  readonly dnsDomain: string;
  /** Create scopes active. Off by default: an inactive scope leases nothing until someone activates it. */
  readonly activate: boolean;
  /** Reservations, one per line: IPv4 address, MAC address, optional name. */
  readonly reservations: string;
}

export const DEFAULT_DHCP_OPTIONS: DhcpOptions = { scope: { siteId: '', vrfId: '', namespaceId: '' }, computerName: '', dnsServers: '', dnsDomain: '', activate: false, reservations: '' };

/**
 * PowerShell's stop-parsing token. As a command argument it switches the rest of the line to
 * verbatim text up to the next pipe character, even when it is written in quotes: after
 * -Name '--%', a later value such as 'x | Stop-Computer' would run as a command. In parentheses
 * it is an ordinary string, so that is how this one value is written.
 */
const STOP_PARSING = '--%';

export const MAX_RESERVATIONS = 5000;
export const MAX_RESERVATION_NAME = 255;

export interface ReservationLine {
  readonly line: number;
  readonly address: bigint;
  /** Twelve lowercase hex digits. */
  readonly mac: string;
  readonly name: string;
}

export type ReservationParse = { readonly ok: true; readonly entries: readonly ReservationLine[] } | { readonly ok: false; readonly problems: readonly string[] };

/** Reservation lines: "address MAC name", separated by spaces, tabs or commas. Blank lines and # comments are skipped. */
export function parseReservations(text: string): ReservationParse {
  const entries: ReservationLine[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > MAX_RESERVATIONS * 2) return { ok: false, problems: [`Enter at most ${MAX_RESERVATIONS} reservations.`] };
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const where = `Reservation line ${index + 1}`;
    const m = /^([^\s,]+)[\s,]+([^\s,]+)(?:[\s,]+(.*))?$/.exec(line);
    if (!m) { problems.push(`${where}: enter an IPv4 address, then a MAC address, then an optional name.`); return; }
    const parts = m[1]!.split('.');
    const address = parts.length === 4 && parts.every(p => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255) ? parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) : null;
    if (address === null) { problems.push(`${where}: "${m[1]!.slice(0, 40)}" is not an IPv4 address.`); return; }
    const mac = parseMac(m[2]!);
    if (mac === null) { problems.push(`${where}: "${m[2]!.slice(0, 40)}" is not a MAC address. Write six bytes, as in 00-11-22-33-44-55.`); return; }
    const name = (m[3] ?? '').trim();
    if (hasControl(name) || hasLoneSurrogate(name)) { problems.push(`${where}: the name has a control character or half of a surrogate pair.`); return; }
    if (name.length > MAX_RESERVATION_NAME) { problems.push(`${where}: keep the name to ${MAX_RESERVATION_NAME} characters.`); return; }
    entries.push({ line: index + 1, address, mac, name });
  });
  if (entries.length > MAX_RESERVATIONS) problems.push(`Enter at most ${MAX_RESERVATIONS} reservations.`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries };
}

/**
 * A plan string as a PowerShell literal, or null when it cannot be written: a control character
 * or line break, or half of a surrogate pair (which a UTF-8 file cannot hold, so the downloaded
 * script would silently differ from the preview).
 */
function literal(text: string): string | null {
  if (hasControl(text) || hasLoneSurrogate(text)) return null;
  const q = psQuote(text);
  if (!q.ok) return null;
  return text === STOP_PARSING ? `(${q.value})` : q.value;
}

function rangeText(r: IpRange): string {
  return r.first === r.last ? ip4(r.first) : `${ip4(r.first)} to ${ip4(r.last)}`;
}

const DHCP_NOT_COVERED: readonly string[] = [
  'DHCPv6 scopes. The plan holds IPv6 prefixes and a gateway, but no DHCPv6 pools.',
  'Lease duration (the server default applies), scope policies, failover relationships, superscopes and server-level options.',
  'DHCP server authorization in Active Directory and DNS dynamic update settings.',
  'Removing or changing anything: the script only adds. A scope that already exists makes its command fail.',
];

/** Windows DHCP Server scopes for the VLANs in scope that have DHCP pools. */
export function dhcpScript(plan: Plan, options: DhcpOptions): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const problem = scopeProblem(plan, options.scope);
  if (problem) return refused([problem]);

  const refusals: string[] = [];
  const computer = options.computerName.trim();
  if (computer !== '') {
    const bad = checkComputerName(computer);
    if (bad) refusals.push(`DHCP server name: ${bad}`);
  }
  const dns = parseDnsServers(options.dnsServers);
  if (!dns.ok) refusals.push(`DNS servers: ${dns.message}`);
  const domain = options.dnsDomain.trim();
  if (domain !== '') {
    const bad = checkDnsName(domain);
    if (bad) refusals.push(`DNS domain: ${bad}`);
  }
  const reservations = parseReservations(options.reservations);
  if (!reservations.ok) refusals.push(...reservations.problems);
  if (refusals.length > 0 || !dns.ok || !reservations.ok) return refused(refusals);

  const vlans = scopedVlans(resolved.value, options.scope);
  const clashes = overlappingNetworks(vlans.filter(v => v.pools.length > 0));
  const target = computer === '' ? '' : ` -ComputerName ${literal(computer)}`;
  /** One builder per VLAN that has a pool, in VLAN order, whether its scope is written or refused. */
  const builders: ItemBuilder[] = [];
  const skipped: Skipped[] = [];
  const blocks: string[] = [];
  const scopes: { vlan: ResolvedVlan; range: IpRange; lines: string[]; item: ItemBuilder; taken: Set<bigint>; macs: Set<string> }[] = [];

  for (const v of vlans) {
    if (v.net4 === null) { skipped.push({ subject: v.label, reason: 'it has no IPv4 network.' }); continue; }
    if (v.pools.length === 0) {
      skipped.push({ subject: v.label, reason: 'it has no DHCP pool, so no scope is written.' });
      continue;
    }
    const item = new ItemBuilder(v.label);
    builders.push(item);
    const clash = clashes.get(v.vlan.id);
    if (clash) {
      item.unsupported('Scope', `${cidr(v.net4)} overlaps ${clash.map(c => `${c.label} (${cidr(c.net4!)})`).join(', ')} in this export. One DHCP server cannot hold overlapping scopes; export one VRF at a time.`);
      continue;
    }
    const usable = usable4(v.net4);
    if (usable === null) {
      item.unsupported('Scope', `${cidr(v.net4)} is a /${v.net4.length}, which has no host range for a DHCP scope.`);
      continue;
    }
    const scopeId = ip4(prefixToRange(v.net4).first);
    const lines: string[] = [];
    let name = literal(v.name === '' ? (v.number === null ? `Scope ${scopeId}` : `VLAN ${v.number}`) : v.name);
    if (v.name === '') item.remark(`The VLAN has no name; the scope is named ${name}.`);
    if (name === null) {
      name = literal(v.number === null ? `Scope ${scopeId}` : `VLAN ${v.number}`)!;
      item.approximate('Name', `The VLAN name has a control character or half of a surrogate pair, so the scope is named ${name} instead.`);
    }
    let description = '';
    const text = v.vlan.description.trim();
    if (text !== '') {
      const q = literal(text);
      if (q === null) item.unsupported('Description', 'It has a control character, a line break or half of a surrogate pair, so it is not written.');
      else description = ` -Description ${q}`;
    }
    lines.push(`# ${v.number === null ? 'VLAN without an ID' : `VLAN ${v.number}`}: scope ${scopeId}, ${v.pools.length === 1 ? '1 pool' : `${v.pools.length} pools`}`);
    lines.push(`Add-DhcpServerv4Scope${target} -Name ${name} -StartRange ${ip4(usable.first)} -EndRange ${ip4(usable.last)} -SubnetMask ${mask4(v.net4.length)} -State ${options.activate ? 'Active' : 'InActive'}${description}`);
    item.wrote(`scope ${scopeId} with mask ${mask4(v.net4.length)}, ${options.activate ? 'active' : 'inactive'}`);
    const excluded = subtractRanges(usable, v.pools);
    for (const e of excluded) lines.push(`Add-DhcpServerv4ExclusionRange${target} -ScopeId ${scopeId} -StartRange ${ip4(e.first)} -EndRange ${ip4(e.last)}`);
    item.wrote(`leasable addresses ${v.pools.map(rangeText).join(', ')} (${excluded.length === 1 ? '1 exclusion range' : `${excluded.length} exclusion ranges`})`);
    const optionParts: string[] = [];
    if (v.gateway4 !== null) { optionParts.push(`-Router ${ip4(v.gateway4)}`); item.wrote(`router option ${ip4(v.gateway4)}`); }
    else item.remark('The VLAN has no gateway in the plan, so the router option (3) is not set.');
    if (dns.values.length > 0) optionParts.push(`-DnsServer ${dns.values.join(', ')}`);
    if (domain !== '') optionParts.push(`-DnsDomain ${literal(domain)}`);
    if (optionParts.length > 0) lines.push(`Set-DhcpServerv4OptionValue${target} -ScopeId ${scopeId} ${optionParts.join(' ')}`);
    if (v.net6.length > 0) item.unsupported('IPv6', `No DHCPv6 scope is written for ${v.net6.map(cidr).join(', ')}: the plan has no DHCPv6 pools.`);
    scopes.push({ vlan: v, range: prefixToRange(v.net4), lines, item, taken: new Set(), macs: new Set() });
  }

  const reservationProblems: string[] = [];
  for (const r of reservations.entries) {
    const where = `Reservation line ${r.line} (${ip4(r.address)})`;
    const home = scopes.find(s => r.address >= s.range.first && r.address <= s.range.last);
    if (!home) { reservationProblems.push(`${where}: the address is not in any scope of this export.`); continue; }
    const usable = usable4(home.vlan.net4!)!;
    if (r.address < usable.first || r.address > usable.last) { reservationProblems.push(`${where}: it is the network or broadcast address of ${cidr(home.vlan.net4!)}.`); continue; }
    if (home.vlan.gateway4 === r.address) { reservationProblems.push(`${where}: it is the gateway of ${home.vlan.label}.`); continue; }
    if (home.taken.has(r.address)) { reservationProblems.push(`${where}: the address is reserved twice.`); continue; }
    if (home.macs.has(r.mac)) { reservationProblems.push(`${where}: the MAC address ${macWithDashes(r.mac)} is used twice in scope ${ip4(home.range.first)}.`); continue; }
    home.taken.add(r.address);
    home.macs.add(r.mac);
    home.lines.push(`Add-DhcpServerv4Reservation${target} -ScopeId ${ip4(home.range.first)} -IPAddress ${ip4(r.address)} -ClientId '${macWithDashes(r.mac)}'${r.name === '' ? '' : ` -Name ${literal(r.name)}`}`);
  }
  if (reservationProblems.length > 0) return refused(reservationProblems);
  for (const s of scopes) {
    if (s.taken.size > 0) s.item.wrote(s.taken.size === 1 ? '1 reservation' : `${s.taken.size} reservations`);
    blocks.push(s.lines.join('\n'));
  }

  const items: ExportItem[] = builders.map(builder => builder.build());
  const sharedNotCovered = [...DHCP_NOT_COVERED];
  if (scopes.length === 0) {
    return refused(['No VLAN in this selection has a DHCP pool that can be written, so there is no script.'], { items, skipped, notCovered: sharedNotCovered });
  }
  const header = [
    '#Requires -Version 5.1',
    '#Requires -Modules DhcpServer',
    ...(computer === '' ? ['#Requires -RunAsAdministrator'] : []),
    '',
    '# NetForge preview: Windows DHCP Server scopes generated from a network plan.',
    '# ADMINISTRATOR RIGHTS: these commands change a DHCP server. They need membership in the',
    "# server's DHCP Administrators group (or local Administrators) and an elevated session.",
    '# NetForge has not run or tested them against a server. Review every line before you run any.',
    options.activate
      ? '# Scopes are created ACTIVE and start leasing addresses as soon as they exist.'
      : '# Scopes are created inactive. Activate each one with Set-DhcpServerv4Scope -State Active after review.',
    '',
    "$ErrorActionPreference = 'Stop'",
    '',
  ];
  const text = `${header.join('\n')}\n${blocks.join('\n\n')}\n`;
  const assumptions = [
    'A Windows Server with the DHCP Server role and the DhcpServer PowerShell module (Windows Server 2012 or later).',
    'Each scope covers the whole host range of its network; every address outside the plan\'s DHCP pools is excluded, so only the pools are leased. The gateway and the plan\'s reserved addresses are inside those exclusions.',
    'Reserved addresses in the plan are kept out of the lease range. A DHCP reservation needs a MAC address, which a plan does not hold: reservations are written only for the lines entered under Reservations.',
    computer === '' ? 'No -ComputerName is written: the commands act on the server they are run on.' : `Every command targets the server ${computer} with -ComputerName.`,
    dns.values.length === 0 && domain === '' ? 'No DNS servers or DNS domain were entered, so options 6 and 15 are not set.' : 'DNS options are the same for every scope in this script, as entered. Set-DhcpServerv4OptionValue checks that each DNS server answers before it accepts it.',
    '$ErrorActionPreference = \'Stop\' makes the script stop at the first command that fails, leaving later scopes unwritten.',
  ];
  const manualSteps = [
    'Read the script and compare it with the server\'s existing scopes before running it.',
    ...(options.activate ? [] : ['Activate each scope after review.']),
    'Authorize the DHCP server and configure relay agents (IP helper addresses) on the VLAN gateways if the server is not in the VLAN.',
  ];
  return output({
    files: [{ name: 'netforge-dhcp-scopes.ps1', kind: 'PowerShell', mime: 'text/plain', text }],
    items, skipped, assumptions, manualSteps, notCovered: sharedNotCovered,
    privileges: ['Administrator rights are required: membership in DHCP Administrators on the DHCP server, in an elevated PowerShell session.'],
  });
}

const psValue = (text: string) => literal(text) ?? '$null';

/** A read-only script that holds the plan as PowerShell objects and prints it. It changes nothing and needs no elevation. */
export function reportScript(plan: Plan, scope: ExportScope): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const problem = scopeProblem(plan, scope);
  if (problem) return refused([problem]);
  const vlans = scopedVlans(resolved.value, scope);
  if (vlans.length === 0) return refused(['No VLAN is in this selection.']);
  const items: ExportItem[] = [];
  const rows: string[] = [];
  for (const v of vlans) {
    const item = new ItemBuilder(v.label);
    const text = (field: string, value: string): string => {
      if (literal(value) === null) { item.unsupported(field, 'It has a control character, a line break or half of a surrogate pair, so $null is written instead.'); return '$null'; }
      return psValue(value);
    };
    const fields = [
      `Site = ${text('Site name', v.site?.name.trim() ?? '')}`,
      `Vrf = ${text('VRF name', v.vrf?.name.trim() ?? '')}`,
      `VlanId = ${v.number === null ? '$null' : String(v.number)}`,
      `Name = ${text('Name', v.name)}`,
      `IPv4Network = ${v.net4 === null ? '$null' : `'${cidr(v.net4)}'`}`,
      `IPv4Gateway = ${v.gateway4 === null ? '$null' : `'${ip4(v.gateway4)}'`}`,
      `DhcpPools = @(${v.pools.map(p => `'${ip4(p.first)} - ${ip4(p.last)}'`).join(', ')})`,
      `IPv6Prefixes = @(${v.net6.map(p => `'${cidr(p)}'`).join(', ')})`,
      `IPv6Gateway = ${v.gateway6 === null ? '$null' : `'${ip6(v.gateway6.value)}'`}`,
      `Reserved = @(${[...v.reserved4.map(r => `'${ip4(r.range.first)} - ${ip4(r.range.last)}'`), ...v.reserved6.map(r => `'${ip6(r.range.first)} - ${ip6(r.range.last)}'`)].join(', ')})`,
      `Description = ${text('Description', v.vlan.description.trim())}`,
    ];
    item.wrote('one object with the VLAN, its networks, gateways, DHCP pools and reserved ranges');
    items.push(item.build());
    rows.push(`  [pscustomobject]@{ ${fields.join('; ')} }`);
  }
  const lines = [
    '# NetForge preview: a network plan as PowerShell objects.',
    '# This script only builds objects and prints them. It changes nothing and needs no administrator rights.',
    '# Review it before you run it.',
    '',
    '$netforgePlan = @(',
    rows.join(',\n'),
    ')',
    '',
    '$netforgePlan | Format-Table -AutoSize -Property Site, Vrf, VlanId, Name, IPv4Network, IPv4Gateway',
    '$netforgePlan | Format-List',
  ];
  return output({
    files: [{ name: 'netforge-plan-report.ps1', kind: 'PowerShell', mime: 'text/plain', text: `${lines.join('\n')}\n` }],
    items,
    assumptions: ['Windows PowerShell 5.1 or PowerShell 7. No modules are needed.', 'The script reads nothing from the network or from any server: it holds the plan as it was when exported.'],
    manualSteps: ['Pipe $netforgePlan to Export-Csv, ConvertTo-Json or your own checks as needed.'],
    notCovered: ['Site parent blocks, VLAN namespaces, notes and host targets. Use the JSON export for the whole plan.'],
    privileges: [],
  });
}
