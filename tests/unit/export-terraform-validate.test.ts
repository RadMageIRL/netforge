/**
 * Generated Terraform against the Terraform CLI itself (tests/fixtures/terraform-validate.json,
 * made by scripts/oracles/terraform_validate.mjs with Terraform 1.17.2 and hashicorp/aws 6.73.0).
 *
 * For every case the CLI ran "terraform validate" (syntax, references, and for AWS files the
 * provider's schema), then "terraform plan" and "terraform show -json":
 * - AWS files: the planned resources, CIDR blocks, tags, IPv6 blocks, Availability Zones read
 *   from the variable, and the references between resources must equal what the plan states.
 *   The plan ran with placeholder credentials and contacted nothing; nothing was applied.
 * - Variable files: the values Terraform read from the .tfvars file (HCL or JSON) must equal the
 *   data that went in, string for string.
 *
 * The fixture holds a hash of each case's files, so this test fails when the generator's output
 * changes and the CLI has not been run again.
 *
 * Regenerate (Terraform CLI in local/tools/terraform, see local/docs/TEST_PLAN.md):
 *
 *   NETFORGE_WRITE_TF_CASES=<cases.json> npx vitest run tests/unit/export-terraform-validate.test.ts
 *   node scripts/oracles/terraform_validate.mjs <cases.json> tests/fixtures/terraform-validate.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate, hclValue } from '../../src/core/infra/hcl';
import { neutralData } from '../../src/core/infra/neutral';
import { resolvePlan, vlanLabel, WHOLE_PLAN, type ExportScope } from '../../src/core/infra/source';
import { AWS_PROVIDER_CONSTRAINT, awsTerraform, checkTagValue, TERRAFORM_CONSTRAINT, terraformVariables, type AwsOptions } from '../../src/core/infra/terraform';
import { examplePlan } from '../../src/core/plan/example';
import { blankVlan, type Plan } from '../../src/core/plan/model';

const C = (...codes: number[]) => String.fromCharCode(...codes);
const BS = C(92);
const Q = C(34);

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
  'plain', '${', '%{', '$${', '%%{', '${x}', '%{if true}yes%{endif}', '$${x}', '%%{x}', '$$${x}', '%%%{x}', '$', '%', '$$', '%%', 'end$', 'end%', `end${BS}`, BS, `${BS}${BS}`,
  Q, `${Q}${Q}`, `${BS}${Q}`, `a${Q}b`, `${BS}n`, `${BS}u0041`, '\n', '\r', '\t', '\r\n', 'line 1\nline 2', C(0), C(1), C(0x1b), C(0x1f), C(0x7f), C(0x80), C(0x85), C(0x9f),
  C(0x2028), C(0x2029), C(0x200e), C(0x202e), C(0x2066), C(0xfeff), String.fromCodePoint(0x1f600), String.fromCodePoint(0x10ffff), C(0xe9), C(0x4e2d, 0x6587),
  `${Q}} resource ${Q}x${Q} ${Q}y${Q} {`, `${Q}\n}\nresource ${Q}aws_instance${Q} ${Q}evil${Q} {\n  ami = ${Q}x`, '<<EOT', '<<-EOT\nx\nEOT', '# comment', '// comment', '/* comment */',
  '${file("/etc/passwd")}', '${var.secret}', '%{ for x in y }${x}%{ endfor }', '$ {x}', '}${', 'null', 'true', '0', `C:${BS}Users${BS}x`, 'tab\there', `it's`, ' leading and trailing ',
  `mixed ${C(0)}$\{${Q}${BS}%{${C(0x2028)}`,
];
const FRIENDLY = ['Users', 'Voice 2', 'A+b-c=d.e_f:g/h@i', `Z${C(0xfc)}rich`, C(0x4e2d, 0x6587), 'x'.repeat(256), 'Core'];

function hostilePlan(r: () => number, tagFriendly: boolean): Plan {
  const p = examplePlan();
  const hostile = () => HOSTILE[Math.floor(r() * HOSTILE.length)]!;
  const text = () => (tagFriendly && r() < 0.5 ? FRIENDLY[Math.floor(r() * FRIENDLY.length)]! : hostile());
  p.name = hostile();
  p.description = hostile();
  p.sites.forEach((s, index) => {
    if (r() < 0.5) s.name = `S${index} ${text()}`;
    s.description = hostile();
    s.notes = hostile();
    for (const b of s.blocks) {
      b.description = hostile();
      for (const e of b.reserved) e.label = hostile();
    }
  });
  p.vrfs.forEach((v, index) => {
    if (r() < 0.5) v.name = `V${index} ${text()}`;
    v.description = hostile();
    v.notes = hostile();
  });
  for (const n of p.namespaces) n.description = hostile();
  for (const v of p.vlans) {
    if (r() < 0.8) v.name = text();
    v.description = hostile();
    v.notes = hostile();
    for (const e of v.reserved) e.label = hostile();
  }
  return p;
}

/** One site and VRF with `count` /24 VLAN networks inside 10.50.0.0/16. */
function widePlan(count: number): Plan {
  const p = examplePlan();
  p.sites = [{ id: 's1', name: 'Wide', description: '', notes: '', blocks: [{ id: 'b1', network: '10.50.0.0/16', vrfId: 'r1', description: '', reserved: [] }] }];
  p.vrfs = [p.vrfs[0]!];
  p.namespaces = [p.namespaces[0]!];
  p.vlans = [];
  for (let i = 0; i < count; i++) {
    const v = blankVlan(`v${i + 1}`, { siteId: 's1', namespaceId: 'n1', vrfId: 'r1' });
    v.vlanId = String(i + 2);
    v.name = `Net ${i + 2}`;
    v.ipv4.network = `10.50.${i}.0/24`;
    v.ipv4.gateway = `10.50.${i}.1`;
    p.vlans.push(v);
  }
  return p;
}

function smallestPlan(): Plan {
  const p = widePlan(1);
  p.sites[0]!.blocks[0]!.network = '10.60.0.0/28';
  p.vlans[0]!.ipv4.network = '10.60.0.0/28';
  p.vlans[0]!.ipv4.gateway = '10.60.0.1';
  p.vlans[0]!.name = '';
  return p;
}

interface TfFile {
  readonly name: string;
  readonly text: string;
}

interface Case {
  readonly id: string;
  readonly kind: 'aws' | 'variables';
  readonly files: readonly TfFile[];
  /** aws: resources and values Terraform must plan. variables: the values Terraform must read, by variable name. */
  readonly expected: unknown;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return hasLoneSurrogate(value) ? null : value;
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, strip(v)]));
  return value;
}

function awsCase(id: string, plan: Plan, options: AwsOptions): Case {
  const out = awsTerraform(plan, options);
  if (!out.ok) throw new Error(`${id}: ${out.refusals.join(' ')}`);
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
  const vpcName = /^aws_vpc\.([a-z0-9_]+) with CIDR block (\S+)$/.exec(written('aws_vpc.')[0]!.written[0]!)!;
  const block = site.blocks.find(b => b.id === options.blockId)!;
  if (vpcName[2] !== block.network.trim()) throw new Error(`${id}: VPC block differs from the plan`);
  const assocItem = written('aws_vpc_ipv6_cidr_block_association.')[0];
  const assoc = assocItem ? { name: /^aws_vpc_ipv6_cidr_block_association\.([a-z0-9_]+) /.exec(assocItem.written[0]!)![1]!, cidr: site.blocks.find(b => b.id === options.ipv6BlockId)!.network.trim() } : null;
  const subnets = written('aws_subnet.').map(x => {
    const m = /^aws_subnet\.([a-z0-9_]+) with CIDR block (\S+)$/.exec(x.written[0]!)!;
    const v = plan.vlans.find(c => c.siteId === options.siteId && c.vrfId === options.vrfId && vlanLabel(c) === x.subject)!;
    if (m[2] !== v.ipv4.network.trim()) throw new Error(`${id}: subnet block differs from the plan`);
    return {
      name: m[1]!, cidr: v.ipv4.network.trim(), ipv6: x.written[1] ? v.ipv6.prefixes[0]!.trim() : null,
      tags: tags([['Name', v.name.trim()], ['netforge:site', site.name.trim()], ['netforge:vrf', vrf.name.trim()], ['netforge:vlan-id', v.vlanId.trim()], ['netforge:planned-gateway', v.ipv4.gateway.trim()]]),
    };
  });
  return {
    id, kind: 'aws', files: out.files.map(f => ({ name: f.name, text: f.text })),
    expected: {
      terraform: TERRAFORM_CONSTRAINT, provider: AWS_PROVIDER_CONSTRAINT,
      vpc: { name: vpcName[1]!, cidr: block.network.trim(), tags: tags([['Name', site.name.trim()], ['netforge:site', site.name.trim()], ['netforge:vrf', vrf.name.trim()]]) },
      assoc, subnets,
    },
  };
}

function variablesCase(id: string, plan: Plan, scope: ExportScope, format: 'hcl' | 'json'): Case {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) throw new Error(`${id}: ${resolved.refusals.join(' ')}`);
  const d = strip(neutralData(resolved.value, scope)) as Record<string, unknown>;
  const out = terraformVariables(plan, scope, format);
  if (!out.ok) throw new Error(`${id} refused`);
  return {
    id, kind: 'variables', files: out.files.map(f => ({ name: f.name, text: f.text })),
    expected: { netforge_sites: d.sites, netforge_vrfs: d.vrfs, netforge_vlan_namespaces: d.vlan_namespaces, netforge_vlans: d.vlans },
  };
}

const HQ: AwsOptions = { siteId: 's1', vrfId: 'r1', blockId: 'b1', ipv6: 'none', ipv6BlockId: '', metadataTags: true };
const TARGETS: readonly AwsOptions[] = [
  HQ,
  { ...HQ, ipv6: 'byoip', ipv6BlockId: 'b2' },
  { siteId: 's2', vrfId: 'r1', blockId: 'b4', ipv6: 'byoip', ipv6BlockId: 'b5', metadataTags: false },
  { siteId: 's1', vrfId: 'r2', blockId: 'b3', ipv6: 'none', ipv6BlockId: '', metadataTags: true },
  { siteId: 's2', vrfId: 'r3', blockId: 'b6', ipv6: 'none', ipv6BlockId: '', metadataTags: false },
];
const SCOPES: readonly ExportScope[] = [WHOLE_PLAN, { siteId: 's1', vrfId: '', namespaceId: '' }, { siteId: '', vrfId: 'r1', namespaceId: '' }, { siteId: '', vrfId: '', namespaceId: 'n2' }];

function buildCases(): Case[] {
  const cases: Case[] = [];
  const names = ['ipv4', 'byoip-ipv6', 'branch-ipv6-no-tags', 'guest-vrf-24', 'branch-guest-no-tags'];
  TARGETS.forEach((t, i) => cases.push(awsCase(`aws-example-${names[i]}`, examplePlan(), t)));
  cases.push(awsCase('aws-200-subnets', widePlan(200), HQ));
  cases.push(awsCase('aws-smallest', smallestPlan(), HQ));
  const r = prng(20261115);
  for (let i = 0; i < 10; i++) cases.push(awsCase(`aws-hostile-${i}`, hostilePlan(r, true), TARGETS[i % TARGETS.length]!));
  cases.push(variablesCase('variables-example-hcl', examplePlan(), WHOLE_PLAN, 'hcl'));
  cases.push(variablesCase('variables-example-json', examplePlan(), WHOLE_PLAN, 'json'));
  for (let i = 0; i < 6; i++) {
    const plan = hostilePlan(r, false);
    cases.push(variablesCase(`variables-hostile-${i}-hcl`, plan, SCOPES[i % SCOPES.length]!, 'hcl'));
    cases.push(variablesCase(`variables-hostile-${i}-json`, plan, SCOPES[i % SCOPES.length]!, 'json'));
  }
  // Every hostile string on its own, as a map of strings, through the HCL writer.
  const strings = Object.fromEntries(HOSTILE.map((s, i) => [`s${i}`, s]));
  cases.push({
    id: 'strings-hcl', kind: 'variables',
    files: [{ name: 'strings.tf', text: 'variable "netforge_strings" {\n  type = map(string)\n}\n' }, { name: 'strings.auto.tfvars', text: `netforge_strings = ${hclValue(strings)}\n` }],
    expected: { netforge_strings: strings },
  });
  return cases;
}

const hashOf = (c: Case) => createHash('sha256').update(c.files.map(f => `${f.name}\n${f.text}`).join('\n--\n'), 'utf8').digest('hex');

interface Recorded {
  readonly id: string;
  readonly kind: string;
  readonly hash: string;
  readonly validate: boolean;
  readonly plan: boolean;
  readonly matches: boolean;
  readonly problems: readonly string[];
  readonly canonicalFormat: boolean;
}

interface Fixture {
  readonly terraform: string;
  readonly provider: { readonly source: string; readonly version: string; readonly constraint: string };
  readonly applied: boolean;
  readonly missingZoneKey: { readonly planFailed: boolean; readonly summary: string };
  readonly cases: readonly Recorded[];
}

const cases = buildCases();

describe('Terraform CLI validation of generated configurations', () => {
  it('builds the same cases on every run', () => {
    expect(buildCases().map(hashOf)).toEqual(cases.map(hashOf));
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
    expect(cases.filter(c => c.kind === 'aws')).toHaveLength(17);
    expect(cases.filter(c => c.kind === 'variables')).toHaveLength(15);
  });

  const target = process.env.NETFORGE_WRITE_TF_CASES;
  if (target) {
    it('writes the cases for the Terraform CLI', () => {
      writeFileSync(target, JSON.stringify({ cases: cases.map(c => ({ ...c, hash: hashOf(c) })) }), 'utf8');
      expect(cases.length).toBeGreaterThan(0);
    });
    return;
  }

  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'terraform-validate.json'), 'utf8')) as Fixture;

  it('was produced by a real Terraform CLI and the declared provider, without applying anything', () => {
    expect(fixture.terraform).toMatch(/^1\.[0-9]+\.[0-9]+$/);
    expect(fixture.provider.source).toBe('registry.terraform.io/hashicorp/aws');
    expect(fixture.provider.constraint).toBe(AWS_PROVIDER_CONSTRAINT);
    expect(fixture.provider.version).toMatch(/^6\.[0-9]+\.[0-9]+$/);
    expect(fixture.applied).toBe(false);
  });

  it('covers exactly the current generator output', () => {
    expect(fixture.cases.map(c => [c.id, c.hash])).toEqual(cases.map(c => [c.id, hashOf(c)]));
  });

  it('every case validates, plans and matches the plan data', () => {
    for (const c of fixture.cases) {
      expect([c.id, c.validate, c.plan, c.matches, c.problems]).toEqual([c.id, true, true, true, []]);
    }
  });

  it('a missing Availability Zone key fails at plan time instead of being guessed', () => {
    expect(fixture.missingZoneKey.planFailed).toBe(true);
    expect(fixture.missingZoneKey.summary).toContain('Invalid index');
  });
});
