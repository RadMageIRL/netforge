/**
 * PowerShell previews for a network plan: Windows DHCP scopes, the read-only plan report and the
 * scheduled task example. Expected values are worked out by hand. The generated text is read back
 * by a small parser written here from PowerShell's quoting rules (a single-quoted string ends at
 * any of the five quote characters PowerShell honors unless that character is doubled);
 * export-powershell-oracle.test.ts checks the same with Windows PowerShell's own parser.
 */
import { describe, expect, it } from 'vitest';
import type { ExportOutput } from '../../src/core/infra/model';
import { DEFAULT_DHCP_OPTIONS, dhcpScript, MAX_RESERVATION_NAME, MAX_RESERVATIONS, parseReservations, reportScript, type DhcpOptions } from '../../src/core/infra/powershell';
import { WHOLE_PLAN } from '../../src/core/infra/source';
import { TASK_FREQUENCIES, taskScript, type TaskOptions } from '../../src/core/infra/task';
import { examplePlan } from '../../src/core/plan/example';
import type { Plan } from '../../src/core/plan/model';
import { makePlan, syntheticPlan, type VlanSpec } from '../plan-helpers';

const C = (code: number) => String.fromCharCode(code);
const QUOTES = [0x27, 0x2018, 0x2019, 0x201a, 0x201b].map(C);
const isQuote = (ch: string) => QUOTES.includes(ch);

type Arg = { readonly quoted: boolean; readonly value: string };
interface Command { readonly name: string; readonly params: Readonly<Record<string, readonly Arg[]>> }

/** Reads one generated command line: a command name, then -Parameter value pairs. */
function parseCommand(line: string): Command {
  let i = 0;
  const skip = () => { while (line[i] === ' ') i++; };
  const word = () => { const start = i; while (i < line.length && line[i] !== ' ' && line[i] !== ',') i++; return line.slice(start, i); };
  const name = word();
  const params: Record<string, Arg[]> = {};
  let current = '';
  while (i < line.length) {
    skip();
    if (i >= line.length) break;
    const ch = line[i]!;
    if (isQuote(ch)) {
      i++;
      let value = '';
      for (;;) {
        if (i >= line.length) throw new Error(`unterminated string in: ${line}`);
        if (isQuote(line[i]!)) {
          if (i + 1 < line.length && isQuote(line[i + 1]!)) { value += line[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        value += line[i++];
      }
      if (i < line.length && line[i] !== ' ' && line[i] !== ',') throw new Error(`text directly after a string in: ${line}`);
      params[current]!.push({ quoted: true, value });
    } else if (ch === ',') {
      i++;
    } else if (ch === '-' && /[A-Za-z]/.test(line[i + 1] ?? '')) {
      i++;
      current = word();
      if (params[current]) throw new Error(`parameter -${current} twice in: ${line}`);
      params[current] = [];
    } else {
      const value = word();
      if (current === '') throw new Error(`argument before any parameter in: ${line}`);
      params[current]!.push({ quoted: false, value });
    }
  }
  return { name, params };
}

const ALLOWED = ['Add-DhcpServerv4Scope', 'Add-DhcpServerv4ExclusionRange', 'Set-DhcpServerv4OptionValue', 'Add-DhcpServerv4Reservation'];

/** The command lines of a DHCP script, after checking that every line is of a known kind. */
function dhcpCommands(o: ExportOutput): Command[] {
  expect(o.ok).toBe(true);
  expect(o.files).toHaveLength(1);
  const text = o.files[0]!.text;
  expect(text.endsWith('\n')).toBe(true);
  expect(/[\r\u0085\u2028\u2029\u0000]/.test(text.replace(/\n/g, ''))).toBe(false);
  const out: Command[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (line === "$ErrorActionPreference = 'Stop'") continue;
    const first = line.split(' ')[0]!;
    expect(ALLOWED, `unexpected line: ${line}`).toContain(first);
    out.push(parseCommand(line));
  }
  return out;
}

const bare = (c: Command, p: string) => c.params[p]?.map(a => { expect(a.quoted).toBe(false); return a.value; }) ?? null;
const one = (c: Command, p: string) => { const v = c.params[p]; if (!v) return null; expect(v).toHaveLength(1); return v[0]!.value; };
const quotedOne = (c: Command, p: string) => { const v = c.params[p]; if (!v) return null; expect(v).toHaveLength(1); expect(v[0]!.quoted).toBe(true); return v[0]!.value; };
const named = (cmds: readonly Command[], name: string) => cmds.filter(c => c.name === name);

const dhcp = (plan: Plan, over: Partial<DhcpOptions> = {}) => dhcpScript(plan, { ...DEFAULT_DHCP_OPTIONS, ...over });
const NET: VlanSpec = { vlanId: '10', name: 'Users', ipv4: { network: '10.0.0.0/24', gateway: '10.0.0.1', dhcp: ['10.0.0.100 - 10.0.0.200'] } };
const single = (over: VlanSpec = {}, options: Partial<DhcpOptions> = {}) => dhcp(makePlan([{ ...NET, ...over, ipv4: { ...NET.ipv4, ...over.ipv4 } }]), options);

describe('dhcpScript: scope, exclusions and options', () => {
  it('writes a scope over the host range and excludes everything outside the pool', () => {
    const o = single();
    const cmds = dhcpCommands(o);
    expect(cmds.map(c => c.name)).toEqual(['Add-DhcpServerv4Scope', 'Add-DhcpServerv4ExclusionRange', 'Add-DhcpServerv4ExclusionRange', 'Set-DhcpServerv4OptionValue']);
    const scope = cmds[0]!;
    expect(quotedOne(scope, 'Name')).toBe('Users');
    expect(bare(scope, 'StartRange')).toEqual(['10.0.0.1']);
    expect(bare(scope, 'EndRange')).toEqual(['10.0.0.254']);
    expect(bare(scope, 'SubnetMask')).toEqual(['255.255.255.0']);
    expect(Object.keys(scope.params)).toEqual(['Name', 'StartRange', 'EndRange', 'SubnetMask', 'State']);
    expect(cmds.slice(1, 3).map(c => [one(c, 'ScopeId'), one(c, 'StartRange'), one(c, 'EndRange')])).toEqual([['10.0.0.0', '10.0.0.1', '10.0.0.99'], ['10.0.0.0', '10.0.0.201', '10.0.0.254']]);
    expect(cmds[3]!.params).toEqual({ ScopeId: [{ quoted: false, value: '10.0.0.0' }], Router: [{ quoted: false, value: '10.0.0.1' }] });
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ subject: 'VLAN 10 Users', fidelity: 'exact', notes: [] });
    expect(o.counts).toEqual({ exact: 1, approximate: 0, unsupported: 0 });
    expect(o.files[0]).toMatchObject({ name: 'netforge-dhcp-scopes.ps1', kind: 'PowerShell' });
  });

  it('creates scopes inactive unless asked otherwise', () => {
    expect(DEFAULT_DHCP_OPTIONS.activate).toBe(false);
    expect(bare(dhcpCommands(single())[0]!, 'State')).toEqual(['InActive']);
    expect(bare(dhcpCommands(single({}, { activate: false }))[0]!, 'State')).toEqual(['InActive']);
    const active = single({}, { activate: true });
    expect(bare(dhcpCommands(active)[0]!, 'State')).toEqual(['Active']);
    expect(active.files[0]!.text).toContain('created ACTIVE');
    expect(single().files[0]!.text).not.toContain('created ACTIVE');
    expect(single().manualSteps.some(s => s.includes('Activate'))).toBe(true);
    expect(active.manualSteps.some(s => s.includes('Activate'))).toBe(false);
  });

  it('says the script needs administrator rights, in the file and in the output', () => {
    const o = single();
    const text = o.files[0]!.text;
    expect(text.split('\n').slice(0, 3)).toEqual(['#Requires -Version 5.1', '#Requires -Modules DhcpServer', '#Requires -RunAsAdministrator']);
    expect(text).toContain('ADMINISTRATOR RIGHTS');
    expect(text).toContain("$ErrorActionPreference = 'Stop'");
    expect(o.privileges).toHaveLength(1);
    expect(o.privileges[0]).toContain('Administrator');
  });

  it('handles several pools, in any order, with gaps between them excluded', () => {
    const cmds = dhcpCommands(single({ ipv4: { dhcp: ['10.0.0.200 - 10.0.0.210', '10.0.0.10 - 10.0.0.20', '10.0.0.64/28'] } }));
    expect(named(cmds, 'Add-DhcpServerv4ExclusionRange').map(c => `${one(c, 'StartRange')}-${one(c, 'EndRange')}`))
      .toEqual(['10.0.0.1-10.0.0.9', '10.0.0.21-10.0.0.63', '10.0.0.80-10.0.0.199', '10.0.0.211-10.0.0.254']);
  });

  it('writes no exclusion at an end the pool touches, and a single-address exclusion as a range of one', () => {
    const low = dhcpCommands(single({ ipv4: { gateway: '10.0.0.254', dhcp: ['10.0.0.1 - 10.0.0.252'] } }));
    expect(named(low, 'Add-DhcpServerv4ExclusionRange').map(c => `${one(c, 'StartRange')}-${one(c, 'EndRange')}`)).toEqual(['10.0.0.253-10.0.0.254']);
    const high = dhcpCommands(single({ ipv4: { dhcp: ['10.0.0.2 - 10.0.0.254'] } }));
    expect(named(high, 'Add-DhcpServerv4ExclusionRange').map(c => `${one(c, 'StartRange')}-${one(c, 'EndRange')}`)).toEqual(['10.0.0.1-10.0.0.1']);
    const all = dhcpCommands(single({ ipv4: { gateway: '', dhcp: ['10.0.0.1 - 10.0.0.254'] } }));
    expect(named(all, 'Add-DhcpServerv4ExclusionRange')).toEqual([]);
  });

  it('writes the mask and host range of other prefix lengths', () => {
    const c30 = dhcpCommands(single({ ipv4: { network: '10.0.0.8/30', gateway: '10.0.0.9', dhcp: ['10.0.0.10'] } }));
    expect([one(c30[0]!, 'StartRange'), one(c30[0]!, 'EndRange'), one(c30[0]!, 'SubnetMask')]).toEqual(['10.0.0.9', '10.0.0.10', '255.255.255.252']);
    expect(named(c30, 'Add-DhcpServerv4ExclusionRange').map(c => `${one(c, 'ScopeId')}:${one(c, 'StartRange')}-${one(c, 'EndRange')}`)).toEqual(['10.0.0.8:10.0.0.9-10.0.0.9']);
    const c20 = dhcpCommands(single({ ipv4: { network: '172.16.16.0/20', gateway: '172.16.16.1', dhcp: ['172.16.17.0 - 172.16.30.255'] } }));
    expect([one(c20[0]!, 'StartRange'), one(c20[0]!, 'EndRange'), one(c20[0]!, 'SubnetMask')]).toEqual(['172.16.16.1', '172.16.31.254', '255.255.240.0']);
    expect(named(c20, 'Add-DhcpServerv4ExclusionRange').map(c => `${one(c, 'StartRange')}-${one(c, 'EndRange')}`)).toEqual(['172.16.16.1-172.16.16.255', '172.16.31.0-172.16.31.254']);
  });

  it('refuses a scope for a /31, which has no host range, and writes the other scopes', () => {
    const p2p: VlanSpec = { vlanId: '31', name: 'Link', ipv4: { network: '10.0.9.8/31', gateway: '', dhcp: ['10.0.9.9'] } };
    const alone = dhcp(makePlan([p2p]));
    expect(alone.ok).toBe(false);
    expect(alone.items).toHaveLength(1);
    expect(alone.items[0]).toMatchObject({ fidelity: 'unsupported', written: [] });
    expect(alone.items[0]!.notes[0]).toMatchObject({ fidelity: 'unsupported', field: 'Scope' });
    const mixed = dhcp(makePlan([NET, p2p]));
    expect(named(dhcpCommands(mixed), 'Add-DhcpServerv4Scope')).toHaveLength(1);
    expect(mixed.items.map(i => i.fidelity)).toEqual(['exact', 'unsupported']);
    expect(mixed.files[0]!.text).not.toContain('10.0.9.');
  });

  it('leaves the router option out when the plan has no gateway, and says so', () => {
    const o = single({ ipv4: { gateway: '' } });
    expect(named(dhcpCommands(o), 'Set-DhcpServerv4OptionValue')).toEqual([]);
    expect(o.items[0]!.fidelity).toBe('exact');
    expect(o.items[0]!.remarks.some(r => r.includes('gateway'))).toBe(true);
    const withDns = single({ ipv4: { gateway: '' } }, { dnsServers: '10.0.0.53' });
    expect(Object.keys(named(dhcpCommands(withDns), 'Set-DhcpServerv4OptionValue')[0]!.params)).toEqual(['ScopeId', 'DnsServer']);
  });

  it('writes DNS options only when they are entered, the same for every scope', () => {
    expect(single().assumptions.some(a => a.includes('No DNS servers'))).toBe(true);
    const plan = makePlan([NET, { vlanId: '20', name: 'Voice', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1', dhcp: ['10.0.1.50 - 10.0.1.60'] } }]);
    const cmds = dhcpCommands(dhcp(plan, { dnsServers: '10.0.9.1 10.0.9.2,10.0.9.3', dnsDomain: ' corp.example ' }));
    const options = named(cmds, 'Set-DhcpServerv4OptionValue');
    expect(options).toHaveLength(2);
    for (const c of options) {
      expect(bare(c, 'DnsServer')).toEqual(['10.0.9.1', '10.0.9.2', '10.0.9.3']);
      expect(quotedOne(c, 'DnsDomain')).toBe('corp.example');
    }
    expect(options.map(c => one(c, 'Router'))).toEqual(['10.0.0.1', '10.0.1.1']);
  });

  it('refuses invalid DNS servers and domains without writing anything', () => {
    for (const over of [{ dnsServers: '10.0.0.300' }, { dnsServers: 'ns1.example' }, { dnsServers: '10.0.0.1; Stop-Computer' }, { dnsDomain: "corp'; Stop-Computer; '" }, { dnsDomain: 'a b' }, { dnsDomain: `a${C(0x0a)}b` }]) {
      const o = single({}, over);
      expect(o.ok).toBe(false);
      expect(o.files).toEqual([]);
      expect(o.refusals).toHaveLength(1);
    }
    expect(single({}, { dnsServers: 'x', dnsDomain: 'a b', computerName: 'a b' }).refusals).toHaveLength(3);
  });

  it('adds -ComputerName to every command when a server is named, and drops the local elevation requirement', () => {
    const o = single({}, { computerName: ' dhcp01.corp.example ', reservations: '10.0.0.50 00-11-22-33-44-55' });
    const cmds = dhcpCommands(o);
    expect(cmds).toHaveLength(5);
    for (const c of cmds) expect(quotedOne(c, 'ComputerName')).toBe('dhcp01.corp.example');
    expect(o.files[0]!.text).not.toContain('#Requires -RunAsAdministrator');
    expect(o.files[0]!.text).toContain('#Requires -Modules DhcpServer');
    expect(o.privileges).toHaveLength(1);
    for (const c of dhcpCommands(single())) expect(c.params.ComputerName).toBeUndefined();
  });

  it('refuses a server name that is not a DNS name or an IPv4 address', () => {
    for (const name of ["srv'; calc; '", 'srv 01', '$(hostname)', '`srv`', 'srv;', 'srv"', `srv${C(0x0a)}x`, `srv${C(0x2019)}`]) {
      const o = single({}, { computerName: name });
      expect(o.ok).toBe(false);
      expect(o.refusals[0]).toMatch(/^DHCP server name: /);
    }
    expect(single({}, { computerName: '192.0.2.10' }).ok).toBe(true);
  });

  it('notes IPv6 as unsupported for a VLAN that has prefixes, and still writes the IPv4 scope', () => {
    const o = single({ ipv6: { prefixes: ['2001:db8:1::/64', '2001:db8:2::/64'], gateway: 'fe80::1' } });
    expect(dhcpCommands(o)).toHaveLength(4);
    expect(o.items[0]!.fidelity).toBe('approximate');
    expect(o.items[0]!.notes).toEqual([expect.objectContaining({ fidelity: 'unsupported', field: 'IPv6' })]);
    expect(o.items[0]!.notes[0]!.detail).toContain('2001:db8:1::/64, 2001:db8:2::/64');
    expect(o.files[0]!.text).not.toContain('2001:db8');
    expect(o.notCovered.some(n => n.includes('DHCPv6'))).toBe(true);
  });

  it('skips VLANs without a network or a pool, naming them', () => {
    const plan = makePlan([NET, { vlanId: '20', name: 'NoPool', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }, { vlanId: '30', name: 'NoNet' }]);
    const o = dhcp(plan);
    expect(named(dhcpCommands(o), 'Add-DhcpServerv4Scope')).toHaveLength(1);
    expect(o.items.map(i => i.subject)).toEqual(['VLAN 10 Users']);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 20 NoPool', 'VLAN 30 NoNet']);
  });

  it('refuses when no VLAN in the selection has a pool, and keeps the account', () => {
    const o = dhcp(makePlan([{ vlanId: '20', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1' } }]));
    expect(o.ok).toBe(false);
    expect(o.files).toEqual([]);
    expect(o.skipped).toHaveLength(1);
    expect(o.privileges).toEqual([]);
  });

  it('refuses a plan with errors and an unknown scope', () => {
    expect(dhcp(makePlan([{ ...NET, ipv4: { ...NET.ipv4, gateway: '10.0.0.150' } }])).ok).toBe(false);
    expect(dhcp(makePlan([NET]), { scope: { siteId: 'nope', vrfId: '', namespaceId: '' } }).ok).toBe(false);
    expect(dhcp(makePlan([])).ok).toBe(false);
  });

  it('exports only the VLANs in scope, in VLAN ID order', () => {
    const o = dhcp(examplePlan(), { scope: { siteId: 's2', vrfId: '', namespaceId: '' } });
    expect(named(dhcpCommands(o), 'Add-DhcpServerv4Scope').map(c => one(c, 'StartRange'))).toEqual(['10.20.10.1', '10.20.20.1', '192.168.100.1']);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 50 Printers']);
    const r1 = dhcp(examplePlan(), { scope: { siteId: 's1', vrfId: 'r2', namespaceId: '' } });
    expect(named(dhcpCommands(r1), 'Add-DhcpServerv4Scope').map(c => quotedOne(c, 'Name'))).toEqual(['Guest']);
  });

  it('refuses overlapping networks of independent VRFs, each with the other named, and writes the rest', () => {
    const o = dhcp(examplePlan(), { scope: WHOLE_PLAN });
    const scopes = named(dhcpCommands(o), 'Add-DhcpServerv4Scope').map(c => one(c, 'StartRange'));
    expect(scopes).toEqual(['10.10.10.1', '10.20.10.1', '10.10.20.1', '10.20.20.1']);
    const refusedItems = o.items.filter(i => i.fidelity === 'unsupported');
    expect(refusedItems.map(i => i.subject)).toEqual(['VLAN 200 Guest', 'VLAN 200 Guest']);
    for (const i of refusedItems) {
      expect(i.written).toEqual([]);
      expect(i.notes[0]).toMatchObject({ fidelity: 'unsupported', field: 'Scope' });
      expect(i.notes[0]!.detail).toContain('192.168.100.0/24 overlaps VLAN 200 Guest (192.168.100.0/24)');
    }
    expect(o.files[0]!.text).not.toContain('192.168.100');
    expect(o.counts.unsupported).toBe(2);
  });

  it('does not treat a network without pools as a clash', () => {
    const plan = makePlan([NET, { vlanId: '20', name: 'Lab', vrfId: 'r2', ipv4: { network: '10.0.0.0/24' } }], {
      vrfs: [{ id: 'r1', name: 'A', siteId: '', exchangesWith: [], description: '', notes: '' }, { id: 'r2', name: 'B', siteId: '', exchangesWith: [], description: '', notes: '' }],
    });
    const o = dhcp(plan);
    expect(o.items.map(i => i.fidelity)).toEqual(['exact']);
  });

  it('reports a reservation that falls in a refused scope instead of writing it', () => {
    const o = dhcp(examplePlan(), { reservations: '192.168.100.20 00-11-22-33-44-55' });
    expect(o.ok).toBe(false);
    expect(o.refusals[0]).toContain('not in any scope');
  });

  it('writes the plan description, and names a scope after the VLAN ID when the VLAN has no name', () => {
    const cmds = dhcpCommands(single({ name: '', description: '  Floor 2, east wing  ' }));
    expect(quotedOne(cmds[0]!, 'Name')).toBe('VLAN 10');
    expect(quotedOne(cmds[0]!, 'Description')).toBe('Floor 2, east wing');
    expect(Object.keys(cmds[0]!.params)).toEqual(['Name', 'StartRange', 'EndRange', 'SubnetMask', 'State', 'Description']);
  });

  it('handles a plan of 2,000 VLANs quickly', () => {
    const plan = syntheticPlan(2000);
    const started = Date.now();
    const o = dhcp(plan, { scope: { siteId: '', vrfId: 'r1', namespaceId: '' } });
    const ms = Date.now() - started;
    const cmds = dhcpCommands(o);
    expect(named(cmds, 'Add-DhcpServerv4Scope')).toHaveLength(1960);
    expect(named(cmds, 'Add-DhcpServerv4ExclusionRange')).toHaveLength(3920);
    expect(o.items).toHaveLength(1960);
    expect(o.counts.approximate).toBe(1960);
    expect(ms).toBeLessThan(5000);
    const everything = dhcp(plan);
    expect(everything.ok).toBe(true);
    expect(everything.counts.unsupported).toBe(40);
  });
});

describe('dhcpScript: quoting and injection', () => {
  const HOSTILE = [
    "O'Brien",
    `a${C(0x2018)}b${C(0x2019)}c`,
    `x${C(0x201a)}y${C(0x201b)}z`,
    "''",
    "'",
    QUOTES.join(''),
    "'; Remove-Item C:\\ -Recurse -Force; '",
    `${C(0x2019)}; Stop-Computer; ${C(0x2019)}`,
    '$(Get-Process)',
    '`n`$x`;calc',
    'a;b',
    '# not a comment',
    '"double" quotes',
    '$env:TEMP ${x} @{a=1} @(1)',
    '-Force -Confirm:$false',
    'a | b > c & d && e',
    '{ Stop-Computer }',
    "it's -Name 'x' -State Active",
    `B${C(0xfc)}ro ${String.fromCodePoint(0x1f600)} ${C(0x4e2d)}`,
    'trailing backslash\\',
    '<#  #>',
  ];

  it('round-trips hostile names and descriptions as single literals and adds no lines', () => {
    const baseline = dhcpCommands(single({ description: 'x' }));
    for (const text of HOSTILE) {
      const o = single({ name: text, description: text }, { reservations: `10.0.0.50 00-11-22-33-44-55 ${text}` });
      const cmds = dhcpCommands(o);
      expect(cmds.map(c => c.name)).toEqual([...baseline.map(c => c.name), 'Add-DhcpServerv4Reservation']);
      expect(quotedOne(cmds[0]!, 'Name')).toBe(text);
      expect(quotedOne(cmds[0]!, 'Description')).toBe(text);
      expect(quotedOne(cmds[4]!, 'Name')).toBe(text);
      expect(bare(cmds[0]!, 'State')).toEqual(['InActive']);
      expect(Object.keys(cmds[0]!.params)).toEqual(['Name', 'StartRange', 'EndRange', 'SubnetMask', 'State', 'Description']);
      expect(o.files[0]!.text.split('\n')).toHaveLength(single({ description: 'x' }, { reservations: '10.0.0.50 00-11-22-33-44-55 y' }).files[0]!.text.split('\n').length);
      expect(o.items[0]!.fidelity).toBe('exact');
    }
  });

  it('writes the stop-parsing token in parentheses, where PowerShell reads it as an ordinary string', () => {
    // After a bare or quoted --% argument, PowerShell 5.1 takes the rest of the line verbatim up to
    // a pipe character and runs what follows the pipe (seen with its parser in the oracle suite).
    const o = single({ name: '--%', description: 'x | Stop-Computer #' }, { reservations: '10.0.0.50 00-11-22-33-44-55 --%' });
    const lines = o.files[0]!.text.split('\n');
    expect(lines.filter(l => l.includes('--%'))).toEqual([
      "Add-DhcpServerv4Scope -Name ('--%') -StartRange 10.0.0.1 -EndRange 10.0.0.254 -SubnetMask 255.255.255.0 -State InActive -Description 'x | Stop-Computer #'",
      "Add-DhcpServerv4Reservation -ScopeId 10.0.0.0 -IPAddress 10.0.0.50 -ClientId '00-11-22-33-44-55' -Name ('--%')",
    ]);
    expect(o.files[0]!.text).not.toMatch(/ '--%'/);
    expect(single({ description: '--%' }).files[0]!.text).toContain("-Description ('--%')");
    expect(single({ name: '--% x' }).files[0]!.text).toContain("-Name '--% x' ");
    expect(single({ name: 'a--%' }).files[0]!.text).toContain("-Name 'a--%' ");
    expect(o.items[0]!.fidelity).toBe('exact');
    const report = reportScript(makePlan([{ vlanId: '10', name: '--%', description: '--%' }]), WHOLE_PLAN).files[0]!.text;
    expect(report).toContain("Name = ('--%'); ");
    expect(report).not.toMatch(/ '--%'/);
  });

  it('doubles each of the five quote characters', () => {
    for (const q of QUOTES) {
      const text = single({ name: `a${q}b` }).files[0]!.text;
      expect(text).toContain(`-Name 'a${q}${q}b' `);
    }
  });

  const UNWRITABLE = [0x0a, 0x0d, 0x00, 0x09, 0x1b, 0x7f, 0x80, 0x85, 0x9b, 0x9f, 0x2028, 0x2029, 0x0b, 0x0c].map(code => `Users${C(code)}Stop-Computer`).concat([`half${C(0xd83d)}`, `${C(0xde00)}half`]);

  it('never writes a name with a control character, a line break or half a surrogate pair: the scope gets a stated fallback name', () => {
    const clean = single({ name: '' }).files[0]!.text;
    for (const name of UNWRITABLE) {
      const o = single({ name });
      const cmds = dhcpCommands(o);
      expect(quotedOne(cmds[0]!, 'Name')).toBe('VLAN 10');
      expect(o.files[0]!.text).toBe(clean);
      expect(o.files[0]!.text).not.toContain('Stop-Computer');
      expect(o.items[0]!.fidelity).toBe('approximate');
      expect(o.items[0]!.notes).toEqual([expect.objectContaining({ fidelity: 'approximate', field: 'Name' })]);
    }
  });

  it('never writes such a description: it is left out and reported as unsupported', () => {
    const clean = single().files[0]!.text;
    for (const description of UNWRITABLE) {
      const o = single({ description });
      expect(o.files[0]!.text).toBe(clean);
      expect(dhcpCommands(o)[0]!.params.Description).toBeUndefined();
      expect(o.items[0]!.notes).toEqual([expect.objectContaining({ fidelity: 'unsupported', field: 'Description' })]);
      expect(o.items[0]!.fidelity).toBe('approximate');
    }
  });

  it('keeps plan text out of comments', () => {
    const o = single({ name: 'ZZNAME', description: 'ZZDESC' }, {});
    const comments = o.files[0]!.text.split('\n').filter(l => l.startsWith('#'));
    expect(comments.length).toBeGreaterThan(5);
    for (const c of comments) expect(c).not.toMatch(/ZZNAME|ZZDESC|Site one|Global|Test/);
    expect(comments).toContain('# VLAN 10: scope 10.0.0.0, 1 pool');
  });
});

describe('reservations', () => {
  it('parses lines of address, MAC and optional name, skipping blanks and comments', () => {
    const r = parseReservations(['', '# printers', '10.0.0.5 00-11-22-33-44-55 printer one', '10.0.0.6,00:11:22:33:44:56', '  10.0.0.7\t0011.2233.4457\tlab  ', '10.0.0.8, 001122334458, a, b'].join('\r\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map(e => [e.line, e.address, e.mac, e.name])).toEqual([
      [3, 0x0a000005n, '001122334455', 'printer one'], [4, 0x0a000006n, '001122334456', ''], [5, 0x0a000007n, '001122334457', 'lab'], [6, 0x0a000008n, '001122334458', 'a, b'],
    ]);
    expect(parseReservations('')).toEqual({ ok: true, entries: [] });
  });

  it('reports each bad line with its number', () => {
    const r = parseReservations(['10.0.0.5', '10.0.0.300 00-11-22-33-44-55', '10.0.0.6 00-11-22-33-44', '010.0.0.7 00-11-22-33-44-55', '2001:db8::1 00-11-22-33-44-55', `10.0.0.8 00-11-22-33-44-55 a${C(0x1b)}b`, `10.0.0.9 00-11-22-33-44-55 ${'n'.repeat(MAX_RESERVATION_NAME + 1)}`, `10.0.0.10 00-11-22-33-44-55 x${C(0xd800)}`].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map(p => /^Reservation line (\d+): /.exec(p)?.[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
  });

  it('accepts a name of the maximum length, and treats U+2028 as text inside a name, not as a line break', () => {
    expect(parseReservations(`10.0.0.9 00-11-22-33-44-55 ${'n'.repeat(MAX_RESERVATION_NAME)}`).ok).toBe(true);
    const r = parseReservations(`10.0.0.9 00-11-22-33-44-55 a${C(0x2028)}Stop-Computer`);
    expect(r.ok).toBe(false);
  });

  it(`accepts at most ${MAX_RESERVATIONS} reservations`, () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `10.${Math.floor(i / 250)}.${i % 250}.1 00-00-00-00-${(i >> 8).toString(16).padStart(2, '0')}-${(i & 255).toString(16).padStart(2, '0')}`).join('\n');
    expect(parseReservations(lines(MAX_RESERVATIONS)).ok).toBe(true);
    expect(parseReservations(lines(MAX_RESERVATIONS + 1)).ok).toBe(false);
    expect(parseReservations('\n'.repeat(MAX_RESERVATIONS * 2 + 5)).ok).toBe(false);
  });

  it('writes a reservation in its scope with the MAC in dashed form, for every spelling', () => {
    for (const mac of ['00-11-22-AA-BB-CC', '00:11:22:aa:bb:cc', '001122AABBCC', '0011.22aa.bbcc']) {
      const o = single({}, { reservations: `10.0.0.50 ${mac} printer` });
      const r = named(dhcpCommands(o), 'Add-DhcpServerv4Reservation');
      expect(r).toHaveLength(1);
      expect(r[0]!.params).toEqual({
        ScopeId: [{ quoted: false, value: '10.0.0.0' }], IPAddress: [{ quoted: false, value: '10.0.0.50' }],
        ClientId: [{ quoted: true, value: '00-11-22-aa-bb-cc' }], Name: [{ quoted: true, value: 'printer' }],
      });
      expect(o.items[0]!.written.some(w => w === '1 reservation')).toBe(true);
    }
    const noName = named(dhcpCommands(single({}, { reservations: '10.0.0.150 00-11-22-33-44-55' })), 'Add-DhcpServerv4Reservation')[0]!;
    expect(Object.keys(noName.params)).toEqual(['ScopeId', 'IPAddress', 'ClientId']);
  });

  it('puts each reservation in the scope that holds its address', () => {
    const plan = makePlan([NET, { vlanId: '20', name: 'Voice', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1', dhcp: ['10.0.1.50 - 10.0.1.60'] } }]);
    const o = dhcp(plan, { reservations: '10.0.1.9 00-00-00-00-00-01\n10.0.0.9 00-00-00-00-00-01\n10.0.1.10 00-00-00-00-00-02' });
    expect(named(dhcpCommands(o), 'Add-DhcpServerv4Reservation').map(c => `${one(c, 'ScopeId')} ${one(c, 'IPAddress')}`)).toEqual(['10.0.0.0 10.0.0.9', '10.0.1.0 10.0.1.9', '10.0.1.0 10.0.1.10']);
    expect(o.items.map(i => i.written[i.written.length - 1])).toEqual(['1 reservation', '2 reservations']);
  });

  it('refuses a reservation outside every scope, on the network or broadcast address, on the gateway, or repeated', () => {
    const bad: [string, RegExp][] = [
      ['10.0.9.5 00-11-22-33-44-55', /not in any scope/],
      ['10.0.0.0 00-11-22-33-44-55', /network or broadcast/],
      ['10.0.0.255 00-11-22-33-44-55', /network or broadcast/],
      ['10.0.0.1 00-11-22-33-44-55', /gateway/],
      ['10.0.0.5 00-11-22-33-44-55\n10.0.0.5 00-11-22-33-44-56', /reserved twice/],
      ['10.0.0.5 00-11-22-33-44-55\n10.0.0.6 00:11:22:33:44:55', /MAC address 00-11-22-33-44-55 is used twice/],
    ];
    for (const [reservations, why] of bad) {
      const o = single({}, { reservations });
      expect(o.ok).toBe(false);
      expect(o.files).toEqual([]);
      expect(o.refusals).toHaveLength(1);
      expect(o.refusals[0]).toMatch(why);
    }
  });

  it('allows the same MAC in two different scopes, and the first and last host addresses', () => {
    const plan = makePlan([{ ...NET, ipv4: { ...NET.ipv4, gateway: '10.0.0.10' } }, { vlanId: '20', ipv4: { network: '10.0.1.0/24', gateway: '10.0.1.1', dhcp: ['10.0.1.50 - 10.0.1.60'] } }]);
    const o = dhcp(plan, { reservations: '10.0.0.1 00-11-22-33-44-55\n10.0.0.254 00-11-22-33-44-56\n10.0.1.5 00-11-22-33-44-55' });
    expect(o.ok).toBe(true);
    expect(named(dhcpCommands(o), 'Add-DhcpServerv4Reservation')).toHaveLength(3);
  });

  it('refuses unreadable reservation lines before generating anything', () => {
    const o = single({}, { reservations: 'not a reservation' });
    expect(o.ok).toBe(false);
    expect(o.refusals[0]).toMatch(/^Reservation line 1/);
  });
});

describe('reportScript', () => {
  it('writes one object per VLAN and only read-only commands', () => {
    const o = reportScript(examplePlan(), { siteId: 's1', vrfId: '', namespaceId: '' });
    expect(o.ok).toBe(true);
    expect(o.privileges).toEqual([]);
    expect(o.files[0]!.name).toBe('netforge-plan-report.ps1');
    const lines = o.files[0]!.text.split('\n');
    const rows = lines.filter(l => l.startsWith('  [pscustomobject]@{ '));
    expect(rows).toHaveLength(6);
    expect(o.items).toHaveLength(6);
    expect(o.counts).toEqual({ exact: 6, approximate: 0, unsupported: 0 });
    for (const l of lines) expect(l === '' || l.startsWith('#') || l.startsWith('  [pscustomobject]@{ ') || ['$netforgePlan = @(', ')'].includes(l) || /^\$netforgePlan \| Format-(Table|List)\b/.test(l), l).toBe(true);
    expect(rows[0]).toContain("Site = 'Headquarters'; Vrf = 'Global'; VlanId = 10; Name = 'Users'; IPv4Network = '10.10.10.0/24'; IPv4Gateway = '10.10.10.1'; DhcpPools = @('10.10.10.100 - 10.10.10.250'); IPv6Prefixes = @('2001:db8:10:10::/64'); IPv6Gateway = 'fe80::1'; Reserved = @('10.10.10.2 - 10.10.10.20'); Description = ''");
    expect(rows[3]).toContain("VlanId = 40; Name = 'Cameras'; IPv4Network = $null; IPv4Gateway = $null; DhcpPools = @(); IPv6Prefixes = @(); IPv6Gateway = $null; Reserved = @(); Description = ''");
    expect(rows.slice(0, -1).every(r => r.endsWith(' },'))).toBe(true);
    expect(rows[5]!.endsWith(' }')).toBe(true);
  });

  it('quotes hostile text as literals and writes $null for text that cannot be written', () => {
    const hostile = "x'; Stop-Computer; '";
    const plan = makePlan([{ vlanId: '10', name: hostile, description: `a${C(0x2019)}b` }, { vlanId: '20', name: `bad${C(0x0a)}Stop-Computer`, description: `bad${C(0x2028)}x` }], {
      sites: [{ id: 's1', name: `Site${C(0x0d)}x`, description: '', notes: '', blocks: [] }],
    });
    const o = reportScript(plan, WHOLE_PLAN);
    const lines = o.files[0]!.text.split('\n');
    const rows = lines.filter(l => l.startsWith('  [pscustomobject]@{ '));
    expect(rows).toHaveLength(2);
    expect(lines).toHaveLength(reportScript(makePlan([{ vlanId: '10' }, { vlanId: '20' }]), WHOLE_PLAN).files[0]!.text.split('\n').length);
    expect(rows[0]).toContain("Name = 'x''; Stop-Computer; '''; ");
    expect(rows[0]).toContain(`Description = 'a${C(0x2019)}${C(0x2019)}b' }`);
    expect(rows[0]).toContain('Site = $null; ');
    expect(rows[1]).toContain('Name = $null; ');
    expect(rows[1]).toContain('Description = $null }');
    expect(o.items[0]!.notes.map(n => n.field)).toEqual(['Site name']);
    expect(o.items[1]!.notes.map(n => n.field)).toEqual(['Site name', 'Name', 'Description']);
    expect(o.items.map(i => i.fidelity)).toEqual(['approximate', 'approximate']);
  });

  it('refuses a plan with errors, an unknown scope and an empty selection', () => {
    expect(reportScript(makePlan([{ ipv4: { network: '10.0.0.0/24', gateway: '10.9.9.9' } }]), WHOLE_PLAN).ok).toBe(false);
    expect(reportScript(examplePlan(), { siteId: 'nope', vrfId: '', namespaceId: '' }).ok).toBe(false);
    expect(reportScript(examplePlan(), { siteId: 's1', vrfId: 'r3', namespaceId: '' }).ok).toBe(false);
  });
});

describe('taskScript', () => {
  const base: TaskOptions = { frequency: 'daily', time: '02:30', weekday: '1', every: '15', startDate: '2026-11-16', zone: 'America/New_York', details: { name: 'Nightly report', program: 'C:\\Tools\\report.exe', arguments: '--all' } };

  it('writes a trigger, an action and a registration for each offered schedule', () => {
    expect(TASK_FREQUENCIES).toEqual(['daily', 'weekdays', 'weekly', 'hourly', 'minutes']);
    const expected: Record<string, RegExp> = {
      daily: /New-ScheduledTaskTrigger -Daily -At '2026-11-16T02:30:00'/,
      weekdays: /New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '2026-11-16T02:30:00'/,
      weekly: /New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '2026-11-16T02:30:00'/,
      hourly: /New-ScheduledTaskTrigger -Once -At .* -RepetitionInterval \(New-TimeSpan -Hours 2\)/,
      minutes: /New-ScheduledTaskTrigger -Once -At .* -RepetitionInterval \(New-TimeSpan -Minutes 15\)/,
    };
    for (const frequency of TASK_FREQUENCIES) {
      const o = taskScript({ ...base, frequency, every: frequency === 'hourly' ? '2' : '15' });
      expect(o.ok, frequency).toBe(true);
      expect(o.files).toHaveLength(1);
      const text = o.files[0]!.text;
      expect(text).toMatch(expected[frequency]!);
      expect(text).toContain("$action = New-ScheduledTaskAction -Execute 'C:\\Tools\\report.exe' -Argument '--all'");
      expect(text).toContain("Register-ScheduledTask -TaskName 'Nightly report' -Trigger $trigger -Action $action");
      expect(o.items).toHaveLength(1);
      expect(o.items[0]!.subject).toMatch(/^Scheduled task: .*[^.]$/);
      expect(o.items[0]!.written).toHaveLength(1);
      expect(o.privileges).toHaveLength(1);
      expect(o.manualSteps.some(s => s.includes('angle brackets'))).toBe(false);
    }
  });

  it('keeps marked placeholders when the name or the program is missing, and says so', () => {
    for (const details of [{ name: '', program: '', arguments: '' }, { name: 'x', program: '', arguments: '' }, { name: '', program: 'x.exe', arguments: '' }]) {
      const o = taskScript({ ...base, details });
      expect(o.ok).toBe(true);
      const text = o.files[0]!.text;
      if (details.name === '') expect(text).toContain("-TaskName '<TASK NAME>'");
      if (details.program === '') expect(text).toContain("-Execute '<PROGRAM>'");
      expect(text).toContain('# Template:');
      expect(o.manualSteps[0]).toContain('angle brackets');
    }
  });

  it('never writes a task name or program with a line break', () => {
    const o = taskScript({ ...base, details: { name: `a${C(0x0a)}Stop-Computer`, program: `b${C(0x2028)}Stop-Computer`, arguments: `c${C(0x0d)}Stop-Computer` } });
    expect(o.ok).toBe(true);
    expect(o.files[0]!.text).not.toContain('Stop-Computer');
    expect(o.files[0]!.text).toContain("'<TASK NAME>'");
    expect(o.items[0]!.remarks.filter(r => r.includes('placeholder')).length).toBeGreaterThanOrEqual(2);
  });

  it('quotes hostile details as single literals', () => {
    const o = taskScript({ ...base, details: { name: "it's", program: "C:\\a'b\\x.exe", arguments: `$(calc) ${C(0x2019)}; Stop-Computer` } });
    const text = o.files[0]!.text;
    expect(text).toContain("-TaskName 'it''s'");
    expect(text).toContain("-Execute 'C:\\a''b\\x.exe'");
    expect(text).toContain(`-Argument '$(calc) ${C(0x2019)}${C(0x2019)}; Stop-Computer'`);
  });

  it('refuses schedules it does not offer and input the scheduling engine rejects', () => {
    for (const frequency of ['monthly', 'days'] as const) {
      const o = taskScript({ ...base, frequency });
      expect(o.ok).toBe(false);
      expect(o.files).toEqual([]);
    }
    const badTime = taskScript({ ...base, time: '25:00' });
    expect(badTime.ok).toBe(false);
    expect(badTime.refusals).toEqual([expect.stringMatching(/^Time: /)]);
    expect(taskScript({ ...base, startDate: '2026-02-30' }).refusals).toEqual([expect.stringMatching(/^Start date: /)]);
    expect(taskScript({ ...base, zone: 'Mars/Olympus' }).refusals).toEqual([expect.stringMatching(/^Time zone: /)]);
    expect(taskScript({ ...base, frequency: 'minutes', every: '0' }).refusals).toEqual([expect.stringMatching(/^Every: /)]);
    expect(taskScript({ ...base, frequency: 'hourly', every: '24' }).refusals).toEqual([expect.stringMatching(/^Every: /)]);
    expect(taskScript({ ...base, frequency: 'weekly', weekday: '7' }).refusals).toEqual([expect.stringMatching(/^Day of the week: /)]);
  });

  it('refuses the stop-parsing token as a task name, program or arguments', () => {
    for (const details of [{ name: '--%', program: 'x.exe', arguments: '' }, { name: 'x', program: '--%', arguments: 'a | calc' }, { name: 'x', program: 'x.exe', arguments: '--%' }]) {
      const o = taskScript({ ...base, details });
      expect(o.ok).toBe(false);
      expect(o.files).toEqual([]);
      expect(o.refusals).toHaveLength(1);
    }
    expect(taskScript({ ...base, details: { name: 'a--%', program: '--% x', arguments: ' --%x' } }).ok).toBe(true);
  });

  it('passes on the engine warnings and conditions', () => {
    const o = taskScript({ ...base, frequency: 'minutes', every: '7' });
    expect(o.ok).toBe(true);
    expect(o.items[0]!.remarks.some(r => r.includes('Every 7 minutes'))).toBe(true);
    expect(o.assumptions.some(a => a.includes('America/New_York'))).toBe(true);
    expect(o.notCovered.some(n => n.includes('Monthly'))).toBe(true);
  });
});
