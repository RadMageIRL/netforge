/**
 * Generated HCL against an independent parser: python-hcl2 (tests/fixtures/export-hcl-oracle.json,
 * made by scripts/oracles/export_hcl_oracle.py). The parser reads every generated file; string
 * values are decoded by the oracle from the HCL native syntax specification (not by NetForge's
 * writer) and must equal the data that went in; and the AWS files must hold exactly the resources,
 * arguments, references and tags expected, with every argument name on a list written from the
 * provider documentation.
 *
 * python-hcl2 8.2.0 reads an escaped template opener only when a closing brace follows it, which
 * the HCL specification does not require. Files it cannot read for that reason are read with the
 * openers swapped for marker characters and swapped back before decoding; the fixture records
 * which cases ("mode": "markers") and shows the limitation on fixed inputs ("probes").
 *
 * This is a syntax and structure check. It is not "terraform validate": no Terraform binary ran,
 * and nothing was checked against the provider's schema.
 *
 * Regenerate (python-hcl2 installed in <dir> with pip install --target <dir> python-hcl2):
 *
 *   NETFORGE_WRITE_HCL_CASES=<cases.json> npx vitest run tests/unit/export-terraform-oracle.test.ts
 *   PYTHONPATH=<dir> python scripts/oracles/export_hcl_oracle.py <cases.json> tests/fixtures/export-hcl-oracle.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate, hclValue, type HclValue } from '../../src/core/infra/hcl';
import { neutralData } from '../../src/core/infra/neutral';
import { resolvePlan, vlanLabel, WHOLE_PLAN, type ExportScope } from '../../src/core/infra/source';
import { AWS_PROVIDER_CONSTRAINT, awsTerraform, checkTagValue, TERRAFORM_CONSTRAINT, terraformVariables, type AwsOptions } from '../../src/core/infra/terraform';
import { examplePlan } from '../../src/core/plan/example';
import type { Plan } from '../../src/core/plan/model';

const C = (...codes: number[]) => String.fromCharCode(...codes);
const BS = C(92);
const Q = C(34);

/** A small seeded generator (mulberry32), so the cases are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text chosen to break a quoted string, start a template, or hide in a file. */
const HOSTILE: readonly string[] = [
  '', 'plain', '${', '%{', '$${', '%%{', '${x}', '%{if true}yes%{endif}', '$${x}', '%%{x}', '$$${x}', '%%%{x}', '$', '%', '$$', '%%', 'end$', 'end%', `end${BS}`, BS, `${BS}${BS}`,
  Q, `${Q}${Q}`, `${BS}${Q}`, `a${Q}b`, `${BS}n`, `${BS}u0041`, `${BS}t${BS}r`, '\n', '\r', '\t', '\r\n', 'line 1\nline 2', C(0), C(1), C(0x1b), C(0x1f), C(0x7f), C(0x80), C(0x85), C(0x9f),
  C(0x2028), C(0x2029), C(0x200e), C(0x200f), C(0x202a), C(0x202e), C(0x2066), C(0x2069), C(0xfeff), String.fromCodePoint(0x1f600), String.fromCodePoint(0x10ffff), C(0xe9), C(0x4e2d, 0x6587),
  `${Q}} resource ${Q}x${Q} ${Q}y${Q} {`, `${Q}\n}\nresource ${Q}aws_instance${Q} ${Q}evil${Q} {\n  ami = ${Q}x`, '<<EOT', '<<-EOT\nx\nEOT', '# comment', '// comment', '/* comment */', '*/', '/*',
  '${file("/etc/passwd")}', '${var.secret}', '%{ for x in y }${x}%{ endfor }', '$ {x}', '% {x}', '{$}', '}${', 'a = b', '[1, 2]', '{ a = 1 }', 'null', 'true', '0', '-1', '1e9',
  `C:${BS}Users${BS}x`, `${BS}${BS}server${BS}share`, 'tab\there', `it's`, '`backtick`', '~> 6.0', 'a,b;c', ' leading and trailing ', `mixed ${C(0)}$\{${Q}${BS}%{${C(0x2028)}`,
];
const ATOMS = ['$', '%', '{', '}', BS, Q, '\n', '\r', '\t', 'a', 'Z', '0', ' ', 'n', 'u', '#', '/', '*', '<', '=', C(0), C(0x7f), C(0x2028), C(0xfeff), C(0xe9), String.fromCodePoint(0x1f600)];
const KEYS = ['a', 'name', 'Name', '_x', 'vlan_10', 'netforge:site', 'a-b', 'a.b', 'a b', '1a', 'k${x}', `k${Q}q`, `k${BS}`, 'k#', C(0xe9), 'x/y', 'k%{'];

function hostile(r: () => number): string {
  if (r() < 0.6) return HOSTILE[Math.floor(r() * HOSTILE.length)]!;
  let s = '';
  for (let n = Math.floor(r() * 12); n > 0; n--) s += ATOMS[Math.floor(r() * ATOMS.length)]!;
  return s;
}

function randomValue(r: () => number, depth: number): HclValue {
  const pick = r();
  if (depth >= 3 || pick < 0.5) {
    if (pick < 0.36) return hostile(r);
    if (pick < 0.42) return Math.floor(r() * 5000);
    if (pick < 0.46) return null;
    return r() < 0.5;
  }
  if (pick < 0.72) {
    const list: HclValue[] = [];
    for (let n = Math.floor(r() * 4); n > 0; n--) list.push(randomValue(r, depth + 1));
    return list;
  }
  const out: Record<string, HclValue> = {};
  for (let n = 1 + Math.floor(r() * 4); n > 0; n--) out[KEYS[Math.floor(r() * KEYS.length)]!] = randomValue(r, depth + 1);
  return out;
}

interface Case {
  readonly id: string;
  readonly kind: 'value' | 'tfvars' | 'tfvars-json' | 'declarations' | 'aws';
  readonly text: string;
  readonly expected: unknown;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return hasLoneSurrogate(value) ? null : value;
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]));
  return value;
}

const SCOPES: readonly ExportScope[] = [WHOLE_PLAN, { siteId: 's1', vrfId: '', namespaceId: '' }, { siteId: 's2', vrfId: '', namespaceId: '' }, { siteId: '', vrfId: 'r1', namespaceId: '' }, { siteId: '', vrfId: '', namespaceId: 'n2' }];

/** The example plan with hostile text in names, descriptions, notes and labels. */
function hostilePlan(r: () => number, tagFriendly: boolean): Plan {
  const p = examplePlan();
  const friendly = ['Users', 'Voice 2', 'A+b-c=d.e_f:g/h@i', `Z${C(0xfc)}rich`, C(0x4e2d, 0x6587), 'x'.repeat(256), 'Core'];
  const text = () => (tagFriendly && r() < 0.5 ? friendly[Math.floor(r() * friendly.length)]! : hostile(r));
  p.name = hostile(r);
  p.description = hostile(r);
  p.sites.forEach((s, index) => {
    if (r() < 0.5) s.name = `S${index} ${text()}`;
    s.description = hostile(r);
    if (r() < 0.3) s.notes = hostile(r);
    for (const b of s.blocks) {
      if (r() < 0.5) b.description = hostile(r);
      for (const e of b.reserved) e.label = hostile(r);
    }
  });
  p.vrfs.forEach((v, index) => {
    if (r() < 0.5) v.name = `V${index} ${text()}`;
    if (r() < 0.5) v.description = hostile(r);
    if (r() < 0.3) v.notes = hostile(r);
  });
  for (const n of p.namespaces) if (r() < 0.5) n.description = hostile(r);
  for (const v of p.vlans) {
    if (r() < 0.7) v.name = text();
    if (r() < 0.5) v.description = hostile(r);
    if (r() < 0.5) v.notes = hostile(r);
    for (const e of v.reserved) if (r() < 0.7) e.label = hostile(r);
    if (r() < 0.05) v.name = `half${C(0xd800)}`;
  }
  return p;
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  HOSTILE.forEach((s, i) => cases.push({ id: `string-${i}`, kind: 'value', text: `v = ${hclValue(s)}\n`, expected: { v: s } }));
  const r = prng(20261114);
  for (let i = 0; i < 160; i++) {
    const value = randomValue(r, 0);
    cases.push({ id: `value-${i}`, kind: 'value', text: `v = ${hclValue(value)}\n`, expected: { v: value } });
  }
  for (let i = 0; i < 40; i++) {
    const plan = hostilePlan(r, false);
    const scope = SCOPES[i % SCOPES.length]!;
    const resolved = resolvePlan(plan);
    if (!resolved.ok) throw new Error(`tfvars-${i}: ${resolved.refusals.join(' ')}`);
    const d = strip(neutralData(resolved.value, scope)) as Record<string, unknown>;
    const expected = { netforge_sites: d.sites, netforge_vrfs: d.vrfs, netforge_vlan_namespaces: d.vlan_namespaces, netforge_vlans: d.vlans };
    const hcl = terraformVariables(plan, scope, 'hcl');
    const json = terraformVariables(plan, scope, 'json');
    if (!hcl.ok || !json.ok) throw new Error(`tfvars-${i} refused`);
    cases.push({ id: `tfvars-${i}`, kind: 'tfvars', text: hcl.files[1]!.text, expected });
    cases.push({ id: `tfvars-json-${i}`, kind: 'tfvars-json', text: json.files[1]!.text, expected });
    if (i === 0) cases.push({ id: 'declarations', kind: 'declarations', text: hcl.files[0]!.text, expected: ['netforge_sites', 'netforge_vrfs', 'netforge_vlan_namespaces', 'netforge_vlans'] });
  }
  const targets: readonly AwsOptions[] = [
    { siteId: 's1', vrfId: 'r1', blockId: 'b1', ipv6: 'none', ipv6BlockId: '', metadataTags: true },
    { siteId: 's1', vrfId: 'r1', blockId: 'b1', ipv6: 'byoip', ipv6BlockId: 'b2', metadataTags: true },
    { siteId: 's2', vrfId: 'r1', blockId: 'b4', ipv6: 'byoip', ipv6BlockId: 'b5', metadataTags: false },
    { siteId: 's1', vrfId: 'r2', blockId: 'b3', ipv6: 'none', ipv6BlockId: '', metadataTags: true },
    { siteId: 's2', vrfId: 'r3', blockId: 'b6', ipv6: 'none', ipv6BlockId: '', metadataTags: false },
  ];
  for (let i = 0; i < 60; i++) {
    const plan = hostilePlan(r, true);
    const options = targets[i % targets.length]!;
    const out = awsTerraform(plan, options);
    if (!out.ok) throw new Error(`aws-${i}: ${out.refusals.join(' ')}`);
    const site = plan.sites.find(s => s.id === options.siteId)!;
    const vrf = plan.vrfs.find(v => v.id === options.vrfId)!;
    const tags = (entries: readonly (readonly [string, string])[]) => {
      const t: Record<string, string> = {};
      for (const [key, value] of entries) {
        if (value === '' || (key !== 'Name' && !options.metadataTags) || hasLoneSurrogate(value) || checkTagValue(value) !== null) continue;
        t[key] = value;
      }
      return t;
    };
    const written = (prefix: string) => out.items.filter(x => x.written[0]?.startsWith(prefix));
    const vpcItem = written('aws_vpc.')[0]!;
    const vpcName = /^aws_vpc\.([a-z0-9_]+) with CIDR block (\S+)$/.exec(vpcItem.written[0]!)!;
    const assocItem = written('aws_vpc_ipv6_cidr_block_association.')[0];
    const assoc = assocItem ? { name: /^aws_vpc_ipv6_cidr_block_association\.([a-z0-9_]+) /.exec(assocItem.written[0]!)![1]!, cidr: /^IPv6 CIDR block (\S+)$/.exec(assocItem.subject)![1]! } : null;
    const subnets = written('aws_subnet.').map(x => {
      const m = /^aws_subnet\.([a-z0-9_]+) with CIDR block (\S+)$/.exec(x.written[0]!)!;
      const v = plan.vlans.find(c => c.siteId === options.siteId && c.vrfId === options.vrfId && vlanLabel(c) === x.subject)!;
      const six = x.written[1] ? /^IPv6 CIDR block (\S+)$/.exec(x.written[1])![1]! : null;
      return {
        name: m[1]!, cidr: m[2]!, planned: v.ipv4.network.trim(), ipv6: six,
        tags: tags([['Name', v.name.trim()], ['netforge:site', site.name.trim()], ['netforge:vrf', vrf.name.trim()], ['netforge:vlan-id', v.vlanId.trim()], ['netforge:planned-gateway', v.ipv4.gateway.trim()]]),
      };
    });
    cases.push({
      id: `aws-${i}`, kind: 'aws', text: out.files[0]!.text,
      expected: {
        terraform: TERRAFORM_CONSTRAINT, provider: AWS_PROVIDER_CONSTRAINT,
        vpc: { name: vpcName[1]!, cidr: vpcName[2]!, tags: tags([['Name', site.name.trim()], ['netforge:site', site.name.trim()], ['netforge:vrf', vrf.name.trim()]]) },
        assoc, subnets,
      },
    });
  }
  return cases;
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Fixture {
  readonly parser: string;
  readonly probes: Readonly<Record<string, string>>;
  readonly results: readonly { readonly id: string; readonly kind: string; readonly sha256: string; readonly mode: 'direct' | 'markers'; readonly parsed: boolean; readonly problems: readonly string[] }[];
}

describe('generated HCL against python-hcl2', () => {
  const cases = buildCases();
  const target = process.env.NETFORGE_WRITE_HCL_CASES;
  if (target) writeFileSync(target, JSON.stringify({ cases }));

  it('builds a few hundred distinct cases', () => {
    expect(cases.length).toBeGreaterThan(300);
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
  });

  it('covers every kind of file and both IPv6 modes', () => {
    const count = (kind: string) => cases.filter(c => c.kind === kind).length;
    expect(count('value')).toBe(HOSTILE.length + 160);
    expect(count('tfvars')).toBe(40);
    expect(count('tfvars-json')).toBe(40);
    expect(count('declarations')).toBe(1);
    expect(count('aws')).toBe(60);
    const awsCases = cases.filter(c => c.kind === 'aws').map(c => c.expected as { assoc: unknown; subnets: { ipv6: string | null; tags: Record<string, string>; cidr: string; planned: string }[] });
    expect(awsCases.some(c => c.assoc !== null)).toBe(true);
    expect(awsCases.some(c => c.assoc === null)).toBe(true);
    expect(awsCases.some(c => c.subnets.some(s => s.ipv6 !== null))).toBe(true);
    expect(awsCases.some(c => c.subnets.some(s => !('Name' in s.tags)))).toBe(true);
    expect(awsCases.some(c => c.subnets.some(s => 'Name' in s.tags && 'netforge:vlan-id' in s.tags))).toBe(true);
    for (const c of awsCases) for (const s of c.subnets) expect(s.cidr).toBe(s.planned);
  });

  const load = () => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'export-hcl-oracle.json'), 'utf8')) as Fixture;

  it('has a fixture made from exactly these cases', () => {
    const fixture = load();
    expect(fixture.parser).toMatch(/^python-hcl2 /);
    expect(fixture.results.map(r => r.id)).toEqual(cases.map(c => c.id));
    for (let i = 0; i < cases.length; i++) {
      expect(fixture.results[i]!.kind, cases[i]!.id).toBe(cases[i]!.kind);
      expect(fixture.results[i]!.sha256, cases[i]!.id).toBe(sha(cases[i]!.text));
    }
  });

  it('parses every file, and every value and structure is what was expected', () => {
    const fixture = load();
    for (const r of fixture.results) {
      expect(r.parsed, r.id).toBe(true);
      expect(r.problems, r.id).toEqual([]);
    }
  });

  it('uses the marker reading only for files with an escaped template opener, as the probes explain', () => {
    const fixture = load();
    expect(fixture.probes).toEqual({
      'escaped opener with a closing brace': 'parsed',
      'escaped opener without a closing brace': 'not parsed',
      'escaped directive opener without a closing brace': 'not parsed',
    });
    const byId = new Map(cases.map(c => [c.id, c]));
    const openers = [`${'$'}${'$'}{`, '%%{'];
    for (const r of fixture.results.filter(x => x.mode === 'markers')) {
      const text = byId.get(r.id)!.text;
      expect(openers.some(o => text.includes(o)), r.id).toBe(true);
      expect(r.kind === 'value' || r.kind === 'tfvars', r.id).toBe(true);
    }
    expect(fixture.results.filter(r => r.mode === 'direct').length).toBeGreaterThan(300);
    expect(fixture.results.filter(r => r.kind === 'aws' || r.kind === 'declarations').every(r => r.mode === 'direct')).toBe(true);
  });
});
