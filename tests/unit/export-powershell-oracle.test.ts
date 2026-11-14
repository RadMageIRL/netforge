/**
 * Generated PowerShell exports against two independent readings.
 *
 * 1. A brute-force model written here: for seeded random plans, the commands a DHCP script must
 *    contain are worked out address by address (an address is leasable exactly when a plan pool
 *    holds it), and the generated text, read back by a small parser of PowerShell's quoting rules,
 *    must match. This part always runs.
 * 2. Windows PowerShell's own parser (tests/fixtures/export-ps-oracle.json, made by
 *    scripts/oracles/export_ps_oracle.ps1). It parsed the same scripts without running anything;
 *    the commands, parameters and string values it read must match the same model, so quoting is
 *    proven to round-trip in the real language. The fixture is tied to the generator by a SHA-256
 *    of every script. Regenerate on Windows:
 *
 *   NETFORGE_WRITE_EXPORT_PS_CASES=<cases.json> npx vitest run tests/unit/export-powershell-oracle.test.ts
 *   powershell -NoProfile -File scripts/oracles/export_ps_oracle.ps1 <cases.json> tests/fixtures/export-ps-oracle.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dhcpScript, reportScript, type DhcpOptions } from '../../src/core/infra/powershell';
import { WHOLE_PLAN } from '../../src/core/infra/source';
import { taskScript, type TaskOptions } from '../../src/core/infra/task';
import type { Plan } from '../../src/core/plan/model';
import { makePlan, type VlanSpec } from '../plan-helpers';

const C = (code: number) => String.fromCharCode(code);
const QUOTES = [0x27, 0x2018, 0x2019, 0x201a, 0x201b].map(C);
const isQuote = (ch: string) => QUOTES.includes(ch);

/** Deterministic random numbers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text a plan may hold that PowerShell would treat specially if it were not quoted. No control characters. */
const TEXTS = [
  'Users', 'Voice', 'Guest WiFi', 'Floor 2, east wing',
  "O'Brien", `a${C(0x2018)}b${C(0x2019)}c`, `x${C(0x201a)}y${C(0x201b)}z`, "''", "'", QUOTES.join(''),
  "'; Remove-Item C:\\ -Recurse -Force; '", `${C(0x2019)}; Stop-Computer; ${C(0x2019)}`,
  '$(Get-Process)', '`n`$x`;calc', 'a;b', '# not a comment', '"double" quotes', '$env:TEMP ${x} @{a=1} @(1)',
  '-Force -Confirm:$false', 'a | b > c & d && e', '{ Stop-Computer }', "it's -Name 'x' -State Active",
  `B${C(0xfc)}ro ${String.fromCodePoint(0x1f600)} ${C(0x4e2d)}`, 'trailing backslash\\', '<# #>', '@"', "@'", '--%', `${C(0x2013)}Name ${C(0x2015)}x`,
];

const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

interface GenVlan {
  readonly number: number;
  readonly name: string;
  readonly description: string;
  readonly network: number;
  readonly length: number;
  readonly gateway: number | null;
  /** Inclusive [first, last] pairs, in the order they are written into the plan. */
  readonly pools: readonly (readonly [number, number])[];
}

interface GenReservation { readonly address: number; readonly mac: string; readonly name: string }

interface GenCase {
  readonly id: string;
  readonly siteName: string;
  readonly vrfName: string;
  readonly vlans: readonly GenVlan[];
  readonly computerName: string;
  readonly dns: readonly string[];
  readonly domain: string;
  readonly activate: boolean;
  readonly reservations: readonly GenReservation[];
}

function generateCase(index: number): GenCase {
  const r = rng(0x5eed + index * 7919);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
  const text = () => (r() < 0.75 ? pick(TEXTS) : '');
  const vlans: GenVlan[] = [];
  const count = 1 + Math.floor(r() * 4);
  for (let k = 0; k < count; k++) {
    const length = 22 + Math.floor(r() * 9);
    const network = ((10 << 24) | ((index % 250) << 16) | ((k * 4) << 8)) >>> 0;
    const size = 2 ** (32 - length);
    const firstHost = network + 1;
    const lastHost = network + size - 2;
    const hosts = lastHost - firstHost + 1;
    const mode = Math.floor(r() * 4);
    const gateway = mode === 0 ? null : mode === 1 ? firstHost : mode === 2 ? lastHost : firstHost + Math.floor(r() * hosts);
    const used = new Set<number>();
    const pools: [number, number][] = [];
    const want = k === 0 ? 1 + Math.floor(r() * 3) : Math.floor(r() * 4);
    for (let attempt = 0; attempt < 12 && pools.length < want; attempt++) {
      const edge = r();
      const a = edge < 0.15 ? firstHost : firstHost + Math.floor(r() * hosts);
      const b = edge > 0.85 ? lastHost : Math.min(lastHost, a + Math.floor(r() * Math.max(1, hosts / 3)));
      let free = true;
      for (let x = a; x <= b && free; x++) if (used.has(x) || x === gateway) free = false;
      if (!free) continue;
      for (let x = a; x <= b; x++) used.add(x);
      pools.push([a, b]);
    }
    vlans.push({ number: 10 * (k + 1) + Math.floor(r() * 9), name: text(), description: text(), network, length, gateway, pools });
  }
  const reservations: GenReservation[] = [];
  const withPools = vlans.filter(v => v.pools.length > 0);
  const wanted = Math.floor(r() * 3);
  for (let n = 0; n < wanted && withPools.length > 0; n++) {
    const v = pick(withPools);
    const hosts = 2 ** (32 - v.length) - 2;
    const address = v.network + 1 + Math.floor(r() * hosts);
    if (address === v.gateway || reservations.some(x => x.address === address)) continue;
    const mac = Array.from({ length: 6 }, (_, i) => (i === 5 ? n + 1 : Math.floor(r() * 256)).toString(16).padStart(2, '0')).join('');
    reservations.push({ address, mac, name: text() });
  }
  return {
    id: `dhcp-${index}`, siteName: pick(TEXTS), vrfName: pick(TEXTS), vlans,
    computerName: pick(['', '', 'dhcp01', 'dhcp-01.corp.example', '192.0.2.10']),
    dns: pick([[], [], ['10.9.9.1'], ['10.9.9.1', '10.9.9.2', '192.0.2.53']]),
    domain: pick(['', '', 'corp.example', 'a-b.c1.example']),
    activate: r() < 0.3,
    reservations,
  };
}

const MAC_FORMS: readonly ((m: string) => string)[] = [
  m => m.match(/../g)!.join('-'), m => m.match(/../g)!.join(':').toUpperCase(), m => m, m => m.match(/..../g)!.join('.'),
];

function toPlan(c: GenCase): Plan {
  const specs: VlanSpec[] = c.vlans.map((v, i) => ({
    id: `v${i + 1}`, vlanId: String(v.number), name: v.name, description: v.description,
    ipv4: {
      network: `${dotted(v.network)}/${v.length}`, gateway: v.gateway === null ? '' : dotted(v.gateway),
      dhcp: v.pools.map(([a, b]) => (a === b ? dotted(a) : `${dotted(a)} - ${dotted(b)}`)),
    },
  }));
  // Written in reverse so the export has to sort by VLAN ID.
  return makePlan(specs.reverse(), {
    sites: [{ id: 's1', name: c.siteName, description: '', notes: '', blocks: [] }],
    vrfs: [{ id: 'r1', name: c.vrfName, siteId: '', exchangesWith: [], description: '', notes: '' }],
  });
}

function toOptions(c: GenCase): DhcpOptions {
  return {
    scope: WHOLE_PLAN, computerName: c.computerName, dnsServers: c.dns.join(', '), dnsDomain: c.domain, activate: c.activate,
    reservations: c.reservations.map((x, i) => `${dotted(x.address)} ${MAC_FORMS[i % MAC_FORMS.length]!(x.mac)}${x.name === '' ? '' : ` ${x.name}`}`).join('\n'),
  };
}

/** One parameter as both readers report it: its name, how its value was written, and the values. */
interface Param { readonly p: string; readonly t: string; readonly v: readonly string[] }
interface Command { readonly name: string; readonly params: readonly Param[] }

/** A quoted string. The stop-parsing token is the one value written in parentheses. */
const quotedType = (value: string) => (value === '--%' ? 'Paren:SingleQuoted' : 'SingleQuoted');
const q = (p: string, value: string): Param => ({ p, t: quotedType(value), v: [value] });
const b = (p: string, ...values: string[]): Param => ({ p, t: 'BareWord', v: values });

/** The commands a DHCP script must hold for a case, worked out address by address. */
function expectedDhcp(c: GenCase): Command[] {
  const target = c.computerName === '' ? [] : [q('ComputerName', c.computerName)];
  const out: Command[] = [];
  for (const v of [...c.vlans].sort((x, y) => x.number - y.number)) {
    if (v.pools.length === 0) continue;
    const scopeId = dotted(v.network);
    const size = 2 ** (32 - v.length);
    const firstHost = v.network + 1;
    const lastHost = v.network + size - 2;
    const maskBits = '1'.repeat(v.length) + '0'.repeat(32 - v.length);
    const mask = [0, 8, 16, 24].map(i => parseInt(maskBits.slice(i, i + 8), 2)).join('.');
    out.push({ name: 'Add-DhcpServerv4Scope', params: [
      ...target, q('Name', v.name === '' ? `VLAN ${v.number}` : v.name), b('StartRange', dotted(firstHost)), b('EndRange', dotted(lastHost)), b('SubnetMask', mask),
      b('State', c.activate ? 'Active' : 'InActive'), ...(v.description === '' ? [] : [q('Description', v.description)]),
    ] });
    const leasable = (x: number) => v.pools.some(([a, z]) => x >= a && x <= z);
    let runStart: number | null = null;
    for (let x = firstHost; x <= lastHost + 1; x++) {
      const excluded = x <= lastHost && !leasable(x);
      if (excluded && runStart === null) runStart = x;
      if (!excluded && runStart !== null) {
        out.push({ name: 'Add-DhcpServerv4ExclusionRange', params: [...target, b('ScopeId', scopeId), b('StartRange', dotted(runStart)), b('EndRange', dotted(x - 1))] });
        runStart = null;
      }
    }
    const options: Param[] = [];
    if (v.gateway !== null) options.push(b('Router', dotted(v.gateway)));
    if (c.dns.length > 0) options.push(b('DnsServer', ...c.dns));
    if (c.domain !== '') options.push(q('DnsDomain', c.domain));
    if (options.length > 0) out.push({ name: 'Set-DhcpServerv4OptionValue', params: [...target, b('ScopeId', scopeId), ...options] });
    for (const x of c.reservations) {
      if (x.address < v.network || x.address > v.network + size - 1) continue;
      out.push({ name: 'Add-DhcpServerv4Reservation', params: [
        ...target, b('ScopeId', scopeId), b('IPAddress', dotted(x.address)), q('ClientId', x.mac.match(/../g)!.join('-')), ...(x.name === '' ? [] : [q('Name', x.name)]),
      ] });
    }
  }
  return out;
}

type Cell = { readonly k: string; readonly t: string; readonly v: readonly string[] };

/** The rows a report script must hold for a case. */
function expectedReport(c: GenCase): Cell[][] {
  const s = (k: string, value: string): Cell => ({ k, t: quotedType(value), v: [value] });
  const none = (k: string): Cell => ({ k, t: 'Variable', v: ['null'] });
  return [...c.vlans].sort((x, y) => x.number - y.number).map(v => {
    const merged: [number, number][] = [];
    for (const [a, z] of [...v.pools].sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a === last[1] + 1) last[1] = z;
      else merged.push([a, z]);
    }
    return [
      s('Site', c.siteName), s('Vrf', c.vrfName), { k: 'VlanId', t: 'Number', v: [String(v.number)] }, s('Name', v.name),
      s('IPv4Network', `${dotted(v.network)}/${v.length}`), v.gateway === null ? none('IPv4Gateway') : s('IPv4Gateway', dotted(v.gateway)),
      { k: 'DhcpPools', t: 'Array', v: merged.map(([a, z]) => `${dotted(a)} - ${dotted(z)}`) },
      { k: 'IPv6Prefixes', t: 'Array', v: [] }, none('IPv6Gateway'), { k: 'Reserved', t: 'Array', v: [] }, s('Description', v.description),
    ];
  });
}

/** Reads one generated command line by PowerShell's rules for bare words and single-quoted strings. */
function parseCommand(line: string): Command {
  let i = 0;
  const word = () => { const start = i; while (i < line.length && line[i] !== ' ' && line[i] !== ',') i++; return line.slice(start, i); };
  const name = word();
  const params: { p: string; t: string; v: string[] }[] = [];
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === ',') i++;
    if (i >= line.length) break;
    const ch = line[i]!;
    const current = params[params.length - 1];
    if (line.startsWith("('--%')", i)) {
      if (!current || current.v.length > 0) throw new Error(`unexpected string in: ${line}`);
      current.t = 'Paren:SingleQuoted';
      current.v.push('--%');
      i += 7;
    } else if (isQuote(ch)) {
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
      if (i < line.length && line[i] !== ' ') throw new Error(`text directly after a string in: ${line}`);
      if (!current || current.v.length > 0) throw new Error(`unexpected string in: ${line}`);
      current.t = 'SingleQuoted';
      current.v.push(value);
    } else if (ch === '-' && /[A-Za-z]/.test(line[i + 1] ?? '')) {
      i++;
      params.push({ p: word(), t: 'Switch', v: [] });
    } else {
      if (!current || current.t.endsWith('SingleQuoted')) throw new Error(`unexpected bare word in: ${line}`);
      current.t = 'BareWord';
      current.v.push(word());
    }
  }
  return { name, params };
}

const DHCP_COMMANDS = ['Add-DhcpServerv4Scope', 'Add-DhcpServerv4ExclusionRange', 'Set-DhcpServerv4OptionValue', 'Add-DhcpServerv4Reservation'];

function readDhcpText(text: string): Command[] {
  const out: Command[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#') || line === "$ErrorActionPreference = 'Stop'") continue;
    if (!DHCP_COMMANDS.includes(line.split(' ')[0]!)) throw new Error(`unexpected line: ${line}`);
    out.push(parseCommand(line));
  }
  return out;
}

/** Parameters of the four cmdlets as documented by Microsoft for the DhcpServer module. */
const DOCUMENTED: Readonly<Record<string, readonly string[]>> = {
  'Add-DhcpServerv4Scope': ['Name', 'StartRange', 'EndRange', 'SubnetMask', 'State', 'Description', 'ComputerName', 'LeaseDuration', 'SuperscopeName', 'MaxBootpClients', 'ActivatePolicies', 'PassThru', 'NapEnable', 'NapProfile', 'Delay', 'Type', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'],
  'Add-DhcpServerv4ExclusionRange': ['ScopeId', 'StartRange', 'EndRange', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'],
  'Set-DhcpServerv4OptionValue': ['ScopeId', 'Router', 'DnsServer', 'DnsDomain', 'WinsServer', 'Wpad', 'OptionId', 'Value', 'ReservedIP', 'VendorClass', 'UserClass', 'PolicyName', 'Force', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'],
  'Add-DhcpServerv4Reservation': ['ScopeId', 'IPAddress', 'ClientId', 'Name', 'Description', 'Type', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm'],
};

const DHCP_CASES = 220;
const REPORT_CASES = 40;

const dhcpCases = Array.from({ length: DHCP_CASES }, (_, i) => generateCase(i));
const dhcpOutputs = dhcpCases.map(c => dhcpScript(toPlan(c), toOptions(c)));
const reportCases = Array.from({ length: REPORT_CASES }, (_, i) => ({ ...generateCase(1000 + i), id: `report-${i}` }));
const reportOutputs = reportCases.map(c => reportScript(toPlan(c), WHOLE_PLAN));

const TASK_BASE: TaskOptions = { frequency: 'daily', time: '02:30', weekday: '1', every: '15', startDate: '2026-11-16', zone: 'UTC', details: { name: '', program: '', arguments: '' } };
const taskCases: { id: string; options: TaskOptions }[] = [
  { id: 'task-daily-template', options: TASK_BASE },
  { id: 'task-weekdays', options: { ...TASK_BASE, frequency: 'weekdays', details: { name: 'Nightly report', program: 'C:\\Program Files\\Tool\\run.exe', arguments: '--all' } } },
  { id: 'task-weekly', options: { ...TASK_BASE, frequency: 'weekly', weekday: '5', details: { name: TEXTS[4]!, program: TEXTS[10]!, arguments: TEXTS[12]! } } },
  { id: 'task-hourly', options: { ...TASK_BASE, frequency: 'hourly', every: '6', details: { name: TEXTS[5]!, program: TEXTS[6]!, arguments: TEXTS[9]! } } },
  { id: 'task-minutes', options: { ...TASK_BASE, frequency: 'minutes', every: '15', details: { name: TEXTS[20]!, program: TEXTS[21]!, arguments: TEXTS[17]! } } },
  ...[11, 13, 14, 15, 16, 18, 22, 25, 26, 28, 7].map((n, i) => ({ id: `task-text-${i}`, options: { ...TASK_BASE, frequency: (['daily', 'weekdays', 'weekly'] as const)[i % 3]!, details: { name: `Job ${i}`, program: TEXTS[n]!, arguments: TEXTS[(n + 3) % TEXTS.length]! } } })),
];
const taskOutputs = taskCases.map(c => taskScript(c.options));

const allTexts = [
  ...dhcpCases.map((c, i) => ({ id: c.id, text: dhcpOutputs[i]!.files[0]?.text ?? '' })),
  ...reportCases.map((c, i) => ({ id: c.id, text: reportOutputs[i]!.files[0]?.text ?? '' })),
  ...taskCases.map((c, i) => ({ id: c.id, text: taskOutputs[i]!.files[0]?.text ?? '' })),
];

describe('generated cases', () => {
  it('are all exportable, deterministic and varied', () => {
    for (const o of [...dhcpOutputs, ...reportOutputs, ...taskOutputs]) expect(o.ok, o.refusals.join(' | ')).toBe(true);
    expect(dhcpScript(toPlan(dhcpCases[7]!), toOptions(dhcpCases[7]!)).files[0]!.text).toBe(dhcpOutputs[7]!.files[0]!.text);
    const stats = { multiPool: 0, noGateway: 0, reservations: 0, computer: 0, active: 0, touchesStart: 0, touchesEnd: 0, single: 0 };
    for (const c of dhcpCases) {
      if (c.computerName !== '') stats.computer++;
      if (c.activate) stats.active++;
      stats.reservations += c.reservations.length;
      for (const v of c.vlans) {
        if (v.pools.length > 1) stats.multiPool++;
        if (v.pools.length > 0 && v.gateway === null) stats.noGateway++;
        if (v.pools.some(([a]) => a === v.network + 1)) stats.touchesStart++;
        if (v.pools.some(([, z]) => z === v.network + 2 ** (32 - v.length) - 2)) stats.touchesEnd++;
        if (v.pools.some(([a, z]) => a === z)) stats.single++;
      }
    }
    for (const [name, n] of Object.entries(stats)) expect(n, name).toBeGreaterThan(10);
    const used = new Set(dhcpCases.flatMap(c => c.vlans.flatMap(v => [v.name, v.description])));
    for (const t of TEXTS) expect(used.has(t), t).toBe(true);
  });
});

describe('DHCP scripts against the address-by-address model', () => {
  it('hold exactly the expected commands, parameters and values', () => {
    dhcpCases.forEach((c, i) => {
      expect(readDhcpText(dhcpOutputs[i]!.files[0]!.text), c.id).toEqual(expectedDhcp(c));
    });
  });

  it('lease exactly the addresses of the plan pools: exclusions are the complement, disjoint, ordered and inside the host range', () => {
    let checked = 0;
    dhcpCases.forEach((c, i) => {
      const cmds = readDhcpText(dhcpOutputs[i]!.files[0]!.text);
      const value = (cmd: Command, p: string) => cmd.params.find(x => x.p === p)!.v[0]!;
      const toInt = (text: string) => text.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
      for (const v of c.vlans) {
        if (v.pools.length === 0) continue;
        const scopeId = dotted(v.network);
        const scope = cmds.find(x => x.name === 'Add-DhcpServerv4Scope' && value(x, 'StartRange') === dotted(v.network + 1))!;
        const start = toInt(value(scope, 'StartRange'));
        const end = toInt(value(scope, 'EndRange'));
        expect(start).toBe(v.network + 1);
        expect(end).toBe(v.network + 2 ** (32 - v.length) - 2);
        const exclusions = cmds.filter(x => x.name === 'Add-DhcpServerv4ExclusionRange' && value(x, 'ScopeId') === scopeId).map(x => [toInt(value(x, 'StartRange')), toInt(value(x, 'EndRange'))] as const);
        let previousEnd = start - 2;
        for (const [a, z] of exclusions) {
          expect(a).toBeGreaterThanOrEqual(start);
          expect(z).toBeLessThanOrEqual(end);
          expect(a).toBeLessThanOrEqual(z);
          expect(a).toBeGreaterThan(previousEnd + 1);
          previousEnd = z;
        }
        for (let x = start; x <= end; x++) {
          const inPool = v.pools.some(([a, z]) => x >= a && x <= z);
          const isExcluded = exclusions.some(([a, z]) => x >= a && x <= z);
          if (inPool === isExcluded) throw new Error(`${c.id}: ${dotted(x)} is ${inPool ? 'in a pool but excluded' : 'outside the pools but leasable'}`);
          checked++;
        }
        if (v.gateway !== null) expect(exclusions.some(([a, z]) => v.gateway! >= a && v.gateway! <= z)).toBe(true);
      }
    });
    expect(checked).toBeGreaterThan(50_000);
  });

  it('use only documented parameter names', () => {
    for (const o of dhcpOutputs) {
      for (const cmd of readDhcpText(o.files[0]!.text)) for (const p of cmd.params) expect(DOCUMENTED[cmd.name], `${cmd.name} -${p.p}`).toContain(p.p);
    }
  });
});

interface Observed {
  id: string;
  sha256: string;
  parseErrors: string[];
  commands: { name: string; params: Param[] }[];
  tables: Cell[][];
  requires: { version: string | null; modules: string[]; elevation: boolean } | null;
  assignments: string[];
  typeNames: string[];
  risky: Record<string, number>;
}
interface Fixture {
  powershell: string;
  dhcpServerModuleInstalled: boolean;
  dhcpServerParameters: Record<string, string[]> | null;
  cases: Observed[];
}

const target = process.env.NETFORGE_WRITE_EXPORT_PS_CASES;

describe('PowerShell exports read by Windows PowerShell', () => {
  if (target) {
    it('writes the cases for scripts/oracles/export_ps_oracle.ps1', () => {
      writeFileSync(target, `${JSON.stringify({ cases: allTexts }, null, 1)}\n`);
      expect(allTexts.length).toBe(DHCP_CASES + REPORT_CASES + taskCases.length);
    });
    return;
  }

  const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'export-ps-oracle.json'), 'utf8')) as Fixture;
  const byId = new Map(fixture.cases.map(c => [c.id, c]));
  const NOTHING_RISKY = { expandableStrings: 0, subExpressions: 0, methodCalls: 0, scriptBlocks: 0, usingExpressions: 0, redirections: 0 };

  it('was made by Windows PowerShell from exactly the scripts generated now', () => {
    expect(fixture.powershell).toMatch(/^5\.1\./);
    expect(fixture.cases.map(c => c.id)).toEqual(allTexts.map(c => c.id));
    for (const c of allTexts) {
      expect(c.text.length, c.id).toBeGreaterThan(0);
      expect(byId.get(c.id)!.sha256, c.id).toBe(createHash('sha256').update(c.text, 'utf8').digest('hex'));
    }
  });

  it('parses every script without errors', () => {
    for (const c of fixture.cases) expect(c.parseErrors, c.id).toEqual([]);
  });

  it('reads the same commands, parameters and string values in DHCP scripts as the model expects', () => {
    for (const c of dhcpCases) {
      const seen = byId.get(c.id)!;
      expect(seen.commands, c.id).toEqual(expectedDhcp(c));
      expect(seen.risky, c.id).toEqual(NOTHING_RISKY);
      expect(seen.assignments, c.id).toEqual(['$ErrorActionPreference']);
      expect(seen.tables, c.id).toEqual([]);
      expect(seen.typeNames, c.id).toEqual([]);
      expect(seen.requires, c.id).toEqual({ version: '5.1', modules: ['DhcpServer'], elevation: c.computerName === '' });
    }
  });

  it('finds no command outside the four DHCP cmdlets in any DHCP script', () => {
    const names = new Set(dhcpCases.flatMap(c => byId.get(c.id)!.commands.map(x => x.name)));
    expect([...names].sort()).toEqual([...DHCP_COMMANDS].sort());
  });

  it('checks parameter names against the DhcpServer module when it is installed', () => {
    if (!fixture.dhcpServerModuleInstalled) {
      // Recorded on a machine without RSAT: only the parser and the documented names were checked.
      expect(fixture.dhcpServerParameters).toBeNull();
      return;
    }
    for (const c of dhcpCases) {
      for (const cmd of byId.get(c.id)!.commands) for (const p of cmd.params) expect(fixture.dhcpServerParameters![cmd.name], `${cmd.name} -${p.p}`).toContain(p.p);
    }
  });

  it('reads the report scripts as one hashtable per VLAN with the plan text intact, and only Format-Table and Format-List as commands', () => {
    for (const c of reportCases) {
      const seen = byId.get(c.id)!;
      expect(seen.tables.map(row => row.map(cell => ({ k: cell.k, t: cell.t, v: cell.v }))), c.id).toEqual(expectedReport(c));
      expect(seen.commands.map(x => x.name), c.id).toEqual(['Format-Table', 'Format-List']);
      expect(seen.risky, c.id).toEqual(NOTHING_RISKY);
      expect(seen.assignments, c.id).toEqual(['$netforgePlan']);
      expect(new Set(seen.typeNames), c.id).toEqual(new Set(['pscustomobject']));
      expect(seen.requires, c.id).toBeNull();
    }
  });

  it('reads the scheduled task scripts with the typed details intact and only ScheduledTasks commands', () => {
    const allowed = ['New-ScheduledTaskTrigger', 'New-ScheduledTaskAction', 'Register-ScheduledTask', 'New-TimeSpan'];
    taskCases.forEach(c => {
      const seen = byId.get(c.id)!;
      for (const cmd of seen.commands) expect(allowed, `${c.id}: ${cmd.name}`).toContain(cmd.name);
      const param = (command: string, p: string) => seen.commands.find(x => x.name === command)?.params.find(x => x.p === p) ?? null;
      const d = c.options.details;
      expect(param('Register-ScheduledTask', 'TaskName'), c.id).toEqual(q('TaskName', d.name === '' ? '<TASK NAME>' : d.name));
      expect(param('New-ScheduledTaskAction', 'Execute'), c.id).toEqual(q('Execute', d.program === '' ? '<PROGRAM>' : d.program));
      expect(param('New-ScheduledTaskAction', 'Argument'), c.id).toEqual(d.arguments === '' ? null : q('Argument', d.arguments));
      expect(seen.risky.expandableStrings + seen.risky.subExpressions + seen.risky.scriptBlocks + seen.risky.methodCalls, c.id).toBe(0);
    });
  });
});
