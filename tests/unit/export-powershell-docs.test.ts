/**
 * The generated DHCP script against the cmdlet reference Microsoft publishes for the DhcpServer
 * module (learn.microsoft.com/powershell/module/dhcpserver, Windows Server 2025 pages, read
 * 2026-11-14). The tables below are copied from those pages: parameter names, which are
 * mandatory, which parameter set they belong to, and the accepted values of -State.
 *
 * This is a documentation check. The module is not installed on the development machine, so
 * nothing here binds parameters against the real cmdlets, and no command is run.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DHCP_OPTIONS, dhcpScript, type DhcpOptions } from '../../src/core/infra/powershell';
import { examplePlan } from '../../src/core/plan/example';
import type { Plan } from '../../src/core/plan/model';

interface Documented {
  /** Parameters that the syntax block marks mandatory. */
  readonly mandatory: readonly string[];
  /** Every other parameter NetForge may use, with the parameter set it belongs to ('all' when shared). */
  readonly optional: Readonly<Record<string, string>>;
  /** The parameter set NetForge uses. */
  readonly set: string;
}

const COMMON = ['PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'];
const all = (names: readonly string[]) => Object.fromEntries(names.map(n => [n, 'all']));

const DOCUMENTED: Readonly<Record<string, Documented>> = {
  'Add-DhcpServerv4Scope': {
    set: 'Default', mandatory: ['StartRange', 'EndRange', 'Name', 'SubnetMask'],
    optional: all(['ComputerName', 'Description', 'State', 'SuperscopeName', 'MaxBootpClients', 'ActivatePolicies', 'NapEnable', 'NapProfile', 'Delay', 'LeaseDuration', 'Type', ...COMMON]),
  },
  'Add-DhcpServerv4ExclusionRange': {
    set: 'Default', mandatory: ['ScopeId', 'StartRange', 'EndRange'], optional: all(['ComputerName', ...COMMON]),
  },
  'Set-DhcpServerv4OptionValue': {
    // Two sets: OptionIds (-OptionId and -Value, both mandatory) and CommonOptions, which has no mandatory parameter.
    set: 'CommonOptions', mandatory: [],
    optional: {
      ...all(['ScopeId', 'PolicyName', 'Force', 'ReservedIP', 'UserClass', 'ComputerName', ...COMMON]),
      DnsDomain: 'CommonOptions', DnsServer: 'CommonOptions', Router: 'CommonOptions', WinsServer: 'CommonOptions', Wpad: 'CommonOptions',
      OptionId: 'OptionIds', Value: 'OptionIds', VendorClass: 'OptionIds',
    },
  },
  'Add-DhcpServerv4Reservation': {
    set: 'Default', mandatory: ['ScopeId', 'IPAddress', 'ClientId'], optional: all(['ComputerName', 'Name', 'Description', 'Type', ...COMMON]),
  },
};

/** "Accepted values: Active, InActive" on the Add-DhcpServerv4Scope page. */
const STATE_VALUES = ['Active', 'InActive'];
/** The ClientId form in the documented examples: "F0-DE-F1-7A-00-5E". */
const CLIENT_ID = /^'[0-9a-f]{2}(-[0-9a-f]{2}){5}'$/;

interface Command {
  readonly name: string;
  readonly params: Map<string, string>;
}

/** Splits a generated command line into its name and -Parameter value pairs. Values are single-quoted literals or bare words. */
function parse(line: string): Command {
  const m = /^([A-Za-z0-9-]+)(.*)$/.exec(line)!;
  const params = new Map<string, string>();
  const re = / -([A-Za-z]+) ((?:\('(?:[^']|'')*'\)|'(?:[^']|'')*'|[0-9.]+(?:, [0-9.]+)*|[A-Za-z]+))/y;
  let at = 0;
  const rest = m[2]!;
  while (at < rest.length) {
    re.lastIndex = at;
    const p = re.exec(rest);
    if (!p) throw new Error(`cannot read "${rest.slice(at, at + 40)}" in ${line}`);
    if (params.has(p[1]!)) throw new Error(`-${p[1]} twice in ${line}`);
    params.set(p[1]!, p[2]!);
    at = re.lastIndex;
  }
  return { name: m[1]!, params };
}

function commands(text: string): Command[] {
  return text.split('\n').filter(l => l !== '' && !l.startsWith('#') && !l.startsWith('$ErrorActionPreference')).map(parse);
}

const HQ = { siteId: 's1', vrfId: '', namespaceId: '' };
const FULL: DhcpOptions = {
  ...DEFAULT_DHCP_OPTIONS, scope: HQ, computerName: 'dhcp01.corp.example', dnsServers: '10.10.30.10, 10.10.30.11', dnsDomain: 'corp.example',
  reservations: '10.10.10.5 00:11:22:33:44:55 printer one\n10.10.20.60 AABB.CCDD.EEFF\n192.168.100.20 aabbccddeeff guest kiosk',
};

function hostile(): Plan {
  const plan = examplePlan();
  plan.vlans[0]!.name = "O'Brien's --% users $(x) `y`";
  plan.vlans[0]!.description = '--%';
  plan.vlans[1]!.name = '--%';
  plan.vlans[1]!.description = 'a -State Active -Name b';
  return plan;
}

const CASES: readonly [string, Plan, DhcpOptions][] = [
  ['the example plan with no options', examplePlan(), { ...DEFAULT_DHCP_OPTIONS, scope: HQ }],
  ['the example plan with every option', examplePlan(), FULL],
  ['the example plan, active scopes', examplePlan(), { ...FULL, activate: true }],
  ['hostile names and descriptions', hostile(), FULL],
];

describe.each(CASES)('documented DhcpServer parameters: %s', (_name, plan, options) => {
  const out = dhcpScript(plan, options);
  const list = out.ok ? commands(out.files[0]!.text) : [];

  it('generates a script', () => {
    expect(out.ok).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it('uses only the four documented cmdlets', () => {
    expect([...new Set(list.map(c => c.name))].filter(n => !Object.hasOwn(DOCUMENTED, n))).toEqual([]);
  });

  it('gives every mandatory parameter and only documented parameters of one parameter set', () => {
    for (const c of list) {
      const doc = DOCUMENTED[c.name]!;
      for (const required of doc.mandatory) expect(c.params.has(required), `${c.name} -${required}`).toBe(true);
      for (const used of c.params.keys()) {
        const set = doc.mandatory.includes(used) ? 'all' : doc.optional[used];
        expect(set, `${c.name} -${used} is documented`).toBeDefined();
        expect(set === 'all' || set === doc.set, `${c.name} -${used} belongs to ${doc.set}`).toBe(true);
      }
    }
  });

  it('writes -State with a documented value and addresses as bare dotted quads', () => {
    for (const c of list) {
      if (c.name === 'Add-DhcpServerv4Scope') expect(STATE_VALUES).toContain(c.params.get('State'));
      for (const p of ['ScopeId', 'StartRange', 'EndRange', 'SubnetMask', 'IPAddress', 'Router']) {
        const v = c.params.get(p);
        if (v !== undefined) expect(v).toMatch(/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/);
      }
      const dns = c.params.get('DnsServer');
      if (dns !== undefined) expect(dns).toMatch(/^[0-9.]+(, [0-9.]+)*$/);
      const id = c.params.get('ClientId');
      if (id !== undefined) expect(id).toMatch(CLIENT_ID);
    }
  });

  it('sets options at scope level: -ScopeId is given and -ReservedIP, -PolicyName and -Force are not', () => {
    for (const c of list.filter(x => x.name === 'Set-DhcpServerv4OptionValue')) {
      expect(c.params.has('ScopeId')).toBe(true);
      for (const p of ['ReservedIP', 'PolicyName', 'Force', 'OptionId', 'Value']) expect(c.params.has(p)).toBe(false);
      expect(c.params.has('Router') || c.params.has('DnsServer') || c.params.has('DnsDomain')).toBe(true);
    }
  });

  it('creates each scope before its exclusions, options and reservations', () => {
    const seen = new Set<string>();
    for (const c of list) {
      if (c.name === 'Add-DhcpServerv4Scope') {
        const start = c.params.get('StartRange')!.split('.').map(Number);
        const mask = c.params.get('SubnetMask')!.split('.').map(Number);
        seen.add(start.map((b, i) => b & mask[i]!).join('.'));
      } else expect(seen.has(c.params.get('ScopeId')!), `${c.name} for ${c.params.get('ScopeId')}`).toBe(true);
    }
  });
});

describe('the default state', () => {
  it('is InActive, spelled as the documentation lists it', () => {
    const out = dhcpScript(examplePlan(), { ...DEFAULT_DHCP_OPTIONS, scope: HQ });
    const scopes = commands(out.files[0]!.text).filter(c => c.name === 'Add-DhcpServerv4Scope');
    expect(scopes.length).toBe(3);
    for (const c of scopes) expect(c.params.get('State')).toBe('InActive');
  });
});
