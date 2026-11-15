/** Provider-neutral data, Terraform variables and the AWS VPC target. */
import { describe, expect, it } from 'vitest';
import type { ExportItem, ExportOutput } from '../../src/core/infra/model';
import { NEUTRAL_FORMAT, NEUTRAL_VERSION, neutralData, neutralItems, neutralJson } from '../../src/core/infra/neutral';
import { resolvePlan, WHOLE_PLAN, type ExportScope } from '../../src/core/infra/source';
import { AWS_MAX_SUBNETS, AWS_PROVIDER_CONSTRAINT, awsTerraform, checkTagValue, TAG_VALUE_MAX, TERRAFORM_CONSTRAINT, terraformVariables, type AwsOptions } from '../../src/core/infra/terraform';
import { examplePlan } from '../../src/core/plan/example';
import { blankVlan, type Plan, type Vlan } from '../../src/core/plan/model';

const C = (...codes: number[]) => String.fromCharCode(...codes);
const BS = C(92);
const HQ: ExportScope = { siteId: 's1', vrfId: '', namespaceId: '' };
const AWS: AwsOptions = { siteId: 's1', vrfId: 'r1', blockId: 'b1', ipv6: 'none', ipv6BlockId: 'b2', metadataTags: true };

function changed(change: (p: Plan) => void): Plan {
  const p = examplePlan();
  change(p);
  return p;
}

function vlan(id: string, fields: Partial<Omit<Vlan, 'ipv4' | 'ipv6'>> & { ipv4?: Partial<Vlan['ipv4']>; ipv6?: Partial<Vlan['ipv6']> }): Vlan {
  const v = blankVlan(id, { siteId: 's1', namespaceId: 'n1', vrfId: 'r1' });
  const { ipv4, ipv6, ...rest } = fields;
  return { ...v, ...rest, ipv4: { ...v.ipv4, ...ipv4 }, ipv6: { ...v.ipv6, ...ipv6 } };
}

const byId = (p: Plan, id: string) => p.vlans.find(v => v.id === id)!;
const data = (p: Plan, scope: ExportScope = WHOLE_PLAN) => {
  const r = resolvePlan(p);
  if (!r.ok) throw new Error(r.refusals.join(' '));
  return neutralData(r.value, scope);
};
const fileText = (o: ExportOutput, name: string) => {
  const f = o.files.find(x => x.name === name);
  if (!f) throw new Error(`no file ${name}`);
  return f.text;
};
const item = (o: ExportOutput, start: string): ExportItem => {
  const found = o.items.find(i => i.subject.startsWith(start));
  if (!found) throw new Error(`no item ${start}: ${o.items.map(i => i.subject).join(', ')}`);
  return found;
};
const note = (i: ExportItem, field: string) => i.notes.find(n => n.field === field);
const aws = (p: Plan, over: Partial<AwsOptions> = {}) => awsTerraform(p, { ...AWS, ...over });
const tf = (o: ExportOutput) => fileText(o, 'netforge_aws.tf');
/** The body of one resource block, from its header line to its closing brace. */
function resource(text: string, type: string, name: string): string {
  const head = `resource "${type}" "${name}" {\n`;
  const start = text.indexOf(head);
  if (start < 0) throw new Error(`no resource ${type}.${name}`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start + head.length, end);
}
const resources = (text: string) => [...text.matchAll(/^resource "([^"]+)" "([^"]+)" \{$/gm)].map(m => ({ type: m[1]!, name: m[2]! }));

describe('neutralData', () => {
  it('holds the whole plan, keyed by plan ids, in canonical form', () => {
    const d = data(examplePlan());
    expect(Object.keys(d.sites)).toEqual(['s1', 's2']);
    expect(Object.keys(d.vrfs)).toEqual(['r1', 'r2', 'r3']);
    expect(Object.keys(d.vlan_namespaces)).toEqual(['n1', 'n2']);
    expect(Object.keys(d.vlans)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10']);
    expect(d.vlans.v1).toEqual({
      vlan_id: 10, name: 'Users', site: 's1', vrf: 'r1', vlan_namespace: 'n1', description: '', notes: '', hosts_target: 200,
      ipv4_network: '10.10.10.0/24', ipv4_netmask: '255.255.255.0', ipv4_gateway: '10.10.10.1',
      ipv4_dhcp_pools: [{ first: '10.10.10.100', last: '10.10.10.250' }],
      ipv6_prefixes: ['2001:db8:10:10::/64'], ipv6_gateway: 'fe80::1',
      reserved: [{ family: 4, first: '10.10.10.2', last: '10.10.10.20', label: 'Printers and access points' }],
    });
    expect(d.vrfs.r1).toEqual({ name: 'Global', site: null, exchanges_routes_with: [], description: 'Corporate routing table, shared by both sites.', notes: '' });
    expect(d.vrfs.r2!.site).toBe('s1');
    expect(d.vlan_namespaces.n1).toEqual({ name: 'HQ switches', site: 's1', description: '' });
    expect(d.sites.s1!.parent_blocks.map(b => [b.id, b.network, b.family, b.vrf])).toEqual([['b1', '10.10.0.0/16', 4, 'r1'], ['b2', '2001:db8:10::/48', 6, 'r1'], ['b3', '192.168.100.0/24', 4, 'r2']]);
    expect(d.sites.s1!.parent_blocks[0]!.reserved).toEqual([{ family: 4, first: '10.10.255.0', last: '10.10.255.255', label: 'Future WAN links' }]);
  });

  it('writes nulls and empty lists for a VLAN without networks', () => {
    const v = data(examplePlan()).vlans.v5!;
    expect(v).toMatchObject({ vlan_id: 40, hosts_target: 80, ipv4_network: null, ipv4_netmask: null, ipv4_gateway: null, ipv4_dhcp_pools: [], ipv6_prefixes: [], ipv6_gateway: null, reserved: [] });
    expect(data(examplePlan()).vlans.v6!.hosts_target).toBeNull();
  });

  it('canonicalizes what was typed', () => {
    const d = data(changed(p => {
      const v = byId(p, 'v3');
      v.ipv4.network = ' 10.10.30.0/25 ';
      v.ipv6.prefixes = ['2001:0DB8:0010:0030:0000:0000:0000:0000/64'];
      v.ipv6.gateway = '2001:DB8:10:30:0:0:0:1';
      v.reserved = [{ range: '10.10.30.8/30', label: ' block ' }, { range: '2001:db8:10:30::ff', label: 'v6' }, { range: '10.10.30.20', label: '' }];
      v.name = '  Servers  ';
      v.description = ' d ';
      v.notes = ' n ';
      v.ipv4.dhcp = ['10.10.30.40 - 10.10.30.50', '10.10.30.51-10.10.30.60', '10.10.30.100'];
      p.sites[0]!.blocks[1]!.network = '2001:DB8:0010::/48';
    }));
    const v = d.vlans.v3!;
    expect(v.name).toBe('Servers');
    expect(v.description).toBe('d');
    expect(v.notes).toBe('n');
    expect(v.ipv4_network).toBe('10.10.30.0/25');
    expect(v.ipv4_netmask).toBe('255.255.255.128');
    expect(v.ipv6_prefixes).toEqual(['2001:db8:10:30::/64']);
    expect(v.ipv6_gateway).toBe('2001:db8:10:30::1');
    expect(v.ipv4_dhcp_pools).toEqual([{ first: '10.10.30.40', last: '10.10.30.60' }, { first: '10.10.30.100', last: '10.10.30.100' }]);
    expect(v.reserved).toEqual([
      { family: 4, first: '10.10.30.8', last: '10.10.30.11', label: 'block' },
      { family: 4, first: '10.10.30.20', last: '10.10.30.20', label: '' },
      { family: 6, first: '2001:db8:10:30::ff', last: '2001:db8:10:30::ff', label: 'v6' },
    ]);
    expect(d.sites.s1!.parent_blocks[1]!.network).toBe('2001:db8:10::/48');
  });

  it('filters by site: the VLANs there, and what they use', () => {
    const d = data(examplePlan(), HQ);
    expect(Object.keys(d.vlans)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
    expect(Object.keys(d.sites)).toEqual(['s1']);
    expect(Object.keys(d.vrfs)).toEqual(['r1', 'r2']);
    expect(Object.keys(d.vlan_namespaces)).toEqual(['n1']);
  });

  it('filters by VRF, including the parent blocks', () => {
    const d = data(examplePlan(), { siteId: '', vrfId: 'r2', namespaceId: '' });
    expect(Object.keys(d.vlans)).toEqual(['v6']);
    expect(Object.keys(d.vrfs)).toEqual(['r2']);
    expect(Object.keys(d.sites)).toEqual(['s1']);
    expect(d.sites.s1!.parent_blocks.map(b => b.id)).toEqual(['b3']);
    const both = data(examplePlan(), { siteId: 's2', vrfId: 'r1', namespaceId: '' });
    expect(Object.keys(both.vlans)).toEqual(['v7', 'v8', 'v10']);
    expect(both.sites.s2!.parent_blocks.map(b => b.id)).toEqual(['b4', 'b5']);
  });

  it('filters by VLAN namespace', () => {
    const d = data(examplePlan(), { siteId: '', vrfId: '', namespaceId: 'n2' });
    expect(Object.keys(d.vlans)).toEqual(['v7', 'v8', 'v9', 'v10']);
    expect(Object.keys(d.vlan_namespaces)).toEqual(['n2']);
    expect(Object.keys(d.sites)).toEqual(['s2']);
    expect(Object.keys(d.vrfs)).toEqual(['r1', 'r3']);
  });

  it('includes a site, VRF or namespace the scope names even when no VLAN uses it', () => {
    const p = changed(x => {
      x.sites.push({ id: 's3', name: 'Empty', description: '', notes: '', blocks: [] });
      x.vrfs.push({ id: 'r9', name: 'Spare', siteId: '', exchangesWith: [], description: '', notes: '' });
      x.namespaces.push({ id: 'n9', name: 'Spare', siteId: '', description: '' });
    });
    expect(Object.keys(data(p, { siteId: 's3', vrfId: '', namespaceId: '' }).sites)).toEqual(['s3']);
    expect(Object.keys(data(p, { siteId: '', vrfId: 'r9', namespaceId: '' }).vrfs)).toEqual(['r9']);
    expect(Object.keys(data(p, { siteId: '', vrfId: '', namespaceId: 'n9' }).vlan_namespaces)).toEqual(['n9']);
    expect(Object.keys(data(p).sites)).toEqual(['s1', 's2', 's3']);
    expect(Object.keys(data(p, HQ).vrfs)).toEqual(['r1', 'r2']);
  });

  it('lists one exact item for every site, VRF, namespace and VLAN', () => {
    const items = neutralItems(data(examplePlan(), HQ));
    expect(items.map(i => i.subject)).toEqual([
      'Site Headquarters', 'VRF Global', 'VRF Guest HQ', 'VLAN namespace HQ switches',
      'VLAN 10 Users', 'VLAN 20 Voice', 'VLAN 30 Servers', 'VLAN 99 Management', 'VLAN 40 Cameras', 'VLAN 200 Guest',
    ]);
    expect(items.every(i => i.fidelity === 'exact' && i.notes.length === 0 && i.written.length === 1)).toBe(true);
    expect(neutralItems(data(changed(p => { byId(p, 'v1').name = ''; }))).some(i => i.subject === 'VLAN 10')).toBe(true);
  });
});

describe('neutralJson', () => {
  it('writes one JSON document with a format name, a version and the data', () => {
    const o = neutralJson(examplePlan(), WHOLE_PLAN);
    expect(o.ok).toBe(true);
    expect(o.files.map(f => [f.name, f.mime])).toEqual([['netforge-network.json', 'application/json']]);
    const doc = JSON.parse(o.files[0]!.text);
    expect(Object.keys(doc)).toEqual(['format', 'version', 'plan', 'sites', 'vrfs', 'vlan_namespaces', 'vlans']);
    expect(doc.format).toBe(NEUTRAL_FORMAT);
    expect(doc.version).toBe(NEUTRAL_VERSION);
    expect(doc.plan).toEqual({ name: 'Example network', description: 'Headquarters and a branch office.' });
    const { format: _f, version: _v, plan: _p, ...rest } = doc;
    expect(rest).toEqual(data(examplePlan()));
    expect(o.counts).toEqual({ exact: 17, approximate: 0, unsupported: 0 });
    expect(o.files[0]!.text.endsWith('}\n')).toBe(true);
  });

  it('keeps hostile text as data', () => {
    const name = `${C(34)}}, "vlans": {} ${BS} ${C(0)} ${C(0x2028)} ${String.fromCodePoint(0x1f600)}`;
    const o = neutralJson(changed(p => { byId(p, 'v1').name = name; p.name = name; }), HQ);
    const doc = JSON.parse(o.files[0]!.text);
    expect(doc.vlans.v1.name).toBe(name);
    expect(doc.plan.name).toBe(name);
    expect(Object.keys(doc.vlans)).toHaveLength(6);
  });

  it('refuses a plan with errors, an unknown scope and an empty selection', () => {
    const broken = neutralJson(changed(p => { byId(p, 'v2').vlanId = '10'; }), WHOLE_PLAN);
    expect(broken.ok).toBe(false);
    expect(broken.files).toEqual([]);
    expect(neutralJson(examplePlan(), { siteId: 'nope', vrfId: '', namespaceId: '' }).ok).toBe(false);
    expect(neutralJson(examplePlan(), { siteId: '', vrfId: 'nope', namespaceId: '' }).ok).toBe(false);
    expect(neutralJson(examplePlan(), { siteId: '', vrfId: '', namespaceId: 'nope' }).ok).toBe(false);
    const empty = neutralJson(examplePlan(), { siteId: 's1', vrfId: 'r3', namespaceId: '' });
    expect(empty.ok).toBe(false);
    expect(empty.refusals).toHaveLength(1);
  });
});

describe('terraformVariables', () => {
  it('writes declarations and an HCL values file', () => {
    const o = terraformVariables(examplePlan(), HQ, 'hcl');
    expect(o.ok).toBe(true);
    expect(o.files.map(f => f.name)).toEqual(['netforge_variables.tf', 'netforge.auto.tfvars']);
    const decl = o.files[0]!.text;
    expect([...decl.matchAll(/^variable "([a-z_]+)" \{$/gm)].map(m => m[1])).toEqual(['netforge_sites', 'netforge_vrfs', 'netforge_vlan_namespaces', 'netforge_vlans']);
    expect(decl).not.toMatch(/^(resource|provider|module|data|output) /m);
    const values = o.files[1]!.text;
    expect([...values.matchAll(/^([a-z_]+) = \{$/gm)].map(m => m[1])).toEqual(['netforge_sites', 'netforge_vrfs', 'netforge_vlan_namespaces', 'netforge_vlans']);
    expect(values).toContain('    ipv4_network   = "10.10.10.0/24"');
    expect(values).toContain('    vlan_id        = 10');
    expect(values).toContain('    ipv4_network    = null');
    expect(values).toContain('    ipv6_prefixes = ["2001:db8:10:10::/64"]\n    ipv6_gateway  = "fe80::1"\n    reserved = [');
    expect(o.counts).toEqual({ exact: 10, approximate: 0, unsupported: 0 });
  });

  it('declares every attribute the values carry, and nothing else', () => {
    const decl = terraformVariables(examplePlan(), WHOLE_PLAN, 'hcl').files[0]!.text;
    const d = data(examplePlan());
    const declared = (variable: string) => {
      const start = decl.indexOf(`variable "${variable}"`);
      const end = decl.indexOf('\n}\n', start);
      return [...decl.slice(start, end).matchAll(/^ +([a-z0-9_]+) += /gm)].map(m => m[1]!).filter(n => n !== 'description' || true);
    };
    const keys = (value: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(value)) value.forEach(v => keys(v, out));
      else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keys(v, out); }
      return out;
    };
    const attrs = (map: Record<string, unknown>) => keys(Object.values(map));
    expect(new Set(declared('netforge_sites').filter(n => n !== 'type'))).toEqual(new Set([...attrs(d.sites), 'description']));
    expect(new Set(declared('netforge_vrfs').filter(n => n !== 'type'))).toEqual(new Set([...attrs(d.vrfs), 'description']));
    expect(new Set(declared('netforge_vlan_namespaces').filter(n => n !== 'type'))).toEqual(new Set([...attrs(d.vlan_namespaces), 'description']));
    expect(new Set(declared('netforge_vlans').filter(n => n !== 'type'))).toEqual(new Set([...attrs(d.vlans), 'description']));
  });

  it('carries the same data in the JSON values file', () => {
    const o = terraformVariables(examplePlan(), HQ, 'json');
    expect(o.files.map(f => [f.name, f.mime])).toEqual([['netforge_variables.tf', 'text/plain'], ['netforge.auto.tfvars.json', 'application/json']]);
    const d = data(examplePlan(), HQ);
    expect(JSON.parse(o.files[1]!.text)).toEqual({ netforge_sites: d.sites, netforge_vrfs: d.vrfs, netforge_vlan_namespaces: d.vlan_namespaces, netforge_vlans: d.vlans });
    expect(o.files[0]!.text).toBe(terraformVariables(examplePlan(), HQ, 'hcl').files[0]!.text);
    expect(o.items).toEqual(terraformVariables(examplePlan(), HQ, 'hcl').items);
  });

  it('escapes template sequences and quotes in the HCL values', () => {
    const o = terraformVariables(changed(p => { byId(p, 'v1').name = `\${file("x")} %{if true} ${BS}`; byId(p, 'v1').notes = 'line 1\nline 2'; }), HQ, 'hcl');
    const values = o.files[1]!.text;
    expect(values).toContain(`name           = "$\${file(${BS}"x${BS}")} %%{if true} ${BS}${BS}"`);
    expect(values).toContain(`notes          = "line 1${BS}nline 2"`);
    expect(values.split('\n').some(l => l === 'line 2"')).toBe(false);
  });

  it('writes null for text with a lone surrogate, in both formats, and reports it', () => {
    const p = changed(x => { byId(x, 'v1').name = `a${C(0xd800)}`; byId(x, 'v2').notes = C(0xdc00); x.sites[0]!.blocks[0]!.reserved[0]!.label = C(0xdbff); });
    for (const format of ['hcl', 'json'] as const) {
      const o = terraformVariables(p, HQ, format);
      expect(o.ok).toBe(true);
      const first = o.items[0]!;
      expect(first.fidelity).toBe('approximate');
      expect(first.notes).toHaveLength(1);
      expect(first.notes[0]!.fidelity).toBe('unsupported');
      expect(first.notes[0]!.detail).toContain('3 values');
      expect(first.notes[0]!.detail).toContain('vlans.v1.name');
      expect(first.notes[0]!.detail).toContain('vlans.v2.notes');
      expect(first.notes[0]!.detail).toContain('sites.s1.parent_blocks[0].reserved[0].label');
      expect(o.counts.approximate).toBe(1);
      expect(o.files[1]!.text).not.toMatch(/[\ud800-\udfff]/);
      if (format === 'json') {
        const doc = JSON.parse(o.files[1]!.text);
        expect(doc.netforge_vlans.v1.name).toBeNull();
        expect(doc.netforge_vlans.v2.notes).toBeNull();
        expect(doc.netforge_vlans.v2.name).toBe('Voice');
        expect(doc.netforge_sites.s1.parent_blocks[0].reserved[0].label).toBeNull();
        expect(o.files[1]!.text).not.toContain(`${BS}ud800`);
      } else expect(o.files[1]!.text).toContain('    name           = null');
    }
    expect(terraformVariables(examplePlan(), HQ, 'hcl').items[0]!.subject).toBe('Site Headquarters');
    const one = terraformVariables(changed(x => { byId(x, 'v1').name = C(0xd800); }), HQ, 'hcl');
    expect(one.items[0]!.notes[0]!.detail).toContain('One value');
  });

  it('refuses a plan with errors, an unknown scope and an empty selection', () => {
    expect(terraformVariables(changed(p => { byId(p, 'v2').vlanId = '10'; }), WHOLE_PLAN, 'hcl').ok).toBe(false);
    expect(terraformVariables(examplePlan(), { siteId: 'nope', vrfId: '', namespaceId: '' }, 'hcl').ok).toBe(false);
    expect(terraformVariables(examplePlan(), { siteId: 's1', vrfId: 'r3', namespaceId: '' }, 'json').ok).toBe(false);
  });
});

describe('checkTagValue', () => {
  it('accepts letters of any script, digits, spaces and + - = . _ : / @', () => {
    for (const ok of ['', 'Users', 'a b', 'A+b-c=d.e_f:g/h@i', '10.10.10.1', `Z${C(0xfc)}rich`, C(0x4e2d, 0x6587), '0123456789']) expect(checkTagValue(ok), ok).toBeNull();
  });

  it('refuses other characters', () => {
    for (const bad of ['a!b', 'a,b', 'a;b', 'a"b', 'a\nb', 'a\tb', 'a#b', '${x}', 'a&b', 'a(b)', "a'b", 'a*b', `a${BS}b`, '<x>', 'a|b', String.fromCodePoint(0x1f600), C(0)]) expect(checkTagValue(bad), JSON.stringify(bad)).not.toBeNull();
  });

  it('allows 256 characters and no more, counting code points', () => {
    expect(TAG_VALUE_MAX).toBe(256);
    expect(checkTagValue('x'.repeat(256))).toBeNull();
    expect(checkTagValue('x'.repeat(257))).not.toBeNull();
    expect(checkTagValue(String.fromCodePoint(0x20000).repeat(256))).toBeNull();
    expect(checkTagValue(String.fromCodePoint(0x20000).repeat(257))).not.toBeNull();
  });
});

describe('awsTerraform', () => {
  it('writes a terraform block, the zone variable, one VPC and one subnet per VLAN network', () => {
    const o = aws(examplePlan());
    expect(o.ok).toBe(true);
    expect(o.files.map(f => f.name)).toEqual(['netforge_aws.tf']);
    const text = tf(o);
    expect(text).toContain(`  required_version = "${TERRAFORM_CONSTRAINT}"`);
    expect(text).toContain('      source  = "hashicorp/aws"');
    expect(text).toContain(`      version = "${AWS_PROVIDER_CONSTRAINT}"`);
    expect(AWS_PROVIDER_CONSTRAINT).toBe('~> 6.0');
    expect(TERRAFORM_CONSTRAINT).toBe('>= 1.5.0');
    expect(resources(text)).toEqual([
      { type: 'aws_vpc', name: 'netforge_headquarters_global' },
      { type: 'aws_subnet', name: 'vlan_10_users' }, { type: 'aws_subnet', name: 'vlan_20_voice' },
      { type: 'aws_subnet', name: 'vlan_30_servers' }, { type: 'aws_subnet', name: 'vlan_99_management' },
    ]);
    expect(resource(text, 'aws_vpc', 'netforge_headquarters_global')).toBe('  cidr_block = "10.10.0.0/16"\n  tags = {\n    Name            = "Headquarters"\n    "netforge:site" = "Headquarters"\n    "netforge:vrf"  = "Global"\n  }');
    expect(resource(text, 'aws_subnet', 'vlan_10_users')).toBe([
      '  vpc_id            = aws_vpc.netforge_headquarters_global.id',
      '  cidr_block        = "10.10.10.0/24"',
      '  availability_zone = var.netforge_availability_zones["vlan_10_users"]',
      '  tags = {',
      '    Name                       = "Users"',
      '    "netforge:site"            = "Headquarters"',
      '    "netforge:vrf"             = "Global"',
      '    "netforge:vlan-id"         = "10"',
      '    "netforge:planned-gateway" = "10.10.10.1"',
      '  }',
    ].join('\n'));
    expect([...text.matchAll(/^variable "([a-z_0-9]+)" \{$/gm)].map(m => m[1])).toEqual(['netforge_availability_zones']);
    expect(text).toContain('# Keys expected in netforge_availability_zones: vlan_10_users, vlan_20_voice, vlan_30_servers, vlan_99_management\n');
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 40 Cameras']);
    expect(o.privileges).toEqual([]);
  });

  it('never writes a zone, a provider, routing or any resource type but the three it documents', () => {
    for (const o of [aws(examplePlan()), aws(examplePlan(), { ipv6: 'byoip' }), aws(examplePlan(), { siteId: 's2', blockId: 'b4', ipv6: 'byoip', ipv6BlockId: 'b5' })]) {
      const text = tf(o);
      const allowed = new Set(['aws_vpc', 'aws_subnet', 'aws_vpc_ipv6_cidr_block_association']);
      expect(resources(text).every(r => allowed.has(r.type))).toBe(true);
      expect(text).not.toMatch(/^(provider|module|data|output|locals|import|moved|removed) /m);
      const zones = text.split('\n').filter(l => l.includes('availability_zone'));
      expect(zones.length).toBeGreaterThan(0);
      for (const l of zones) expect(l).toMatch(/^( {2}availability_zone = var\.netforge_availability_zones\["[a-z0-9_]+"\]|variable "netforge_availability_zones" \{|# Keys expected in netforge_availability_zones: [a-z0-9_, ]+)$/);
      expect(text).not.toMatch(/[a-z]{2}-(north|south|east|west|central)[a-z]*-[0-9]/);
      expect(text).not.toMatch(/default\s*=/);
      expect(text).not.toMatch(/route_table|internet_gateway|nat_gateway|map_public_ip|region|access_key|profile/);
    }
  });

  it('labels the VPC approximate with a note on its meaning, and a subnet with a VLAN ID approximate', () => {
    const o = aws(examplePlan());
    const vpc = item(o, 'VPC for site Headquarters, VRF Global');
    expect(vpc.fidelity).toBe('approximate');
    expect(note(vpc, 'Meaning')?.fidelity).toBe('approximate');
    expect(note(vpc, 'Reserved space')?.fidelity).toBe('unsupported');
    expect(note(vpc, 'Route exchange')).toBeUndefined();
    const mgmt = item(o, 'VLAN 99 Management');
    expect(mgmt.fidelity).toBe('approximate');
    expect(mgmt.notes.map(n => [n.field, n.fidelity])).toEqual([['VLAN ID', 'approximate']]);
    expect(note(mgmt, 'VLAN ID')!.detail).toContain('kept as a tag');
    expect(o.counts).toEqual({ exact: 0, approximate: 5, unsupported: 0 });
    const bare = aws(changed(p => { p.sites[0]!.blocks[0]!.reserved = []; }));
    expect(item(bare, 'VPC for').notes.map(n => n.field)).toEqual(['Meaning']);
  });

  it('reports route exchange from either side', () => {
    expect(note(item(aws(changed(p => { p.vrfs[0]!.exchangesWith = ['r2']; })), 'VPC for'), 'Route exchange')?.fidelity).toBe('unsupported');
    expect(note(item(aws(changed(p => { p.vrfs[1]!.exchangesWith = ['r1']; })), 'VPC for'), 'Route exchange')?.fidelity).toBe('unsupported');
    expect(note(item(aws(changed(p => { p.vrfs.push({ id: 'r9', name: 'Lab', siteId: '', exchangesWith: ['r2'], description: '', notes: '' }); })), 'VPC for'), 'Route exchange')).toBeUndefined();
  });

  it('refuses without one site, one VRF and an IPv4 parent block of that site and VRF', () => {
    const refusedFor = (over: Partial<AwsOptions>, p: Plan = examplePlan()) => {
      const o = aws(p, over);
      expect(o.ok, JSON.stringify(over)).toBe(false);
      expect(o.files).toEqual([]);
      expect(o.notCovered.length).toBeGreaterThan(0);
      return o.refusals;
    };
    expect(refusedFor({ siteId: '' })).toHaveLength(1);
    expect(refusedFor({ vrfId: '' })).toHaveLength(1);
    expect(refusedFor({ siteId: '', vrfId: '' })).toHaveLength(2);
    expect(refusedFor({ siteId: 'nope' })).toHaveLength(1);
    expect(refusedFor({ vrfId: 'nope' })).toHaveLength(1);
    const noBlock = refusedFor({ blockId: '' });
    expect(noBlock).toHaveLength(1);
    for (const over of [{ blockId: 'nope' }, { blockId: 'b3' }, { blockId: 'b2' }, { blockId: 'b4' }, { vrfId: 'r2', blockId: 'b1' }]) {
      expect(refusedFor(over), JSON.stringify(over)).toEqual(noBlock);
      expect(aws(examplePlan(), over).items).toEqual([]);
    }
    expect(aws(examplePlan(), { vrfId: 'r2', blockId: 'b3' }).ok).toBe(true);
  });

  it('refuses a plan with errors before anything else', () => {
    const o = aws(changed(p => { byId(p, 'v2').vlanId = '10'; }));
    expect(o.ok).toBe(false);
    expect(o.refusals[0]).toContain('error');
  });

  it('accepts a VPC CIDR block from /16 to /28 only', () => {
    const withBlock = (network: string, vlanNet: string) => aws(changed(p => {
      p.sites[0]!.blocks[0]!.network = network;
      p.sites[0]!.blocks[0]!.reserved = [];
      p.vlans = [vlan('v1', { vlanId: '10', name: 'Users', ipv4: { network: vlanNet } })];
    }));
    expect(withBlock('10.0.0.0/15', '10.0.0.0/24').ok).toBe(false);
    expect(withBlock('10.0.0.0/8', '10.0.0.0/24').ok).toBe(false);
    expect(withBlock('10.10.0.0/16', '10.10.0.0/24').ok).toBe(true);
    expect(withBlock('10.10.0.0/28', '10.10.0.0/28').ok).toBe(true);
    const tooSmall = withBlock('10.10.0.0/29', '10.10.0.0/29');
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.refusals[0]).toContain('/16 to /28');
    expect(withBlock('10.10.0.0/30', '10.10.0.0/30').ok).toBe(false);
  });

  it('writes no subnet for a network outside the VPC block or longer than /28', () => {
    const o = aws(changed(p => {
      p.sites[0]!.blocks.push({ id: 'bx', network: '10.30.0.0/16', vrfId: 'r1', description: '', reserved: [] });
      p.vlans.push(vlan('o1', { vlanId: '300', name: 'Elsewhere', ipv4: { network: '10.30.1.0/24' } }));
      p.vlans.push(vlan('o2', { vlanId: '301', name: 'Tiny', ipv4: { network: '10.10.200.0/29' } }));
      p.vlans.push(vlan('o3', { vlanId: '302', name: 'Smallest', ipv4: { network: '10.10.201.0/28' } }));
      p.vlans.push(vlan('o4', { vlanId: '303', name: 'Link', ipv4: { network: '10.10.202.0/31' } }));
    }));
    const text = tf(o);
    const outside = item(o, 'VLAN 300 Elsewhere');
    expect(outside.fidelity).toBe('unsupported');
    expect(outside.written).toEqual([]);
    expect(outside.notes.map(n => n.field)).toEqual(['Subnet']);
    expect(outside.notes[0]!.detail).toContain('not inside');
    const tiny = item(o, 'VLAN 301 Tiny');
    expect(tiny.fidelity).toBe('unsupported');
    expect(tiny.notes[0]!.detail).toContain('/16 to /28');
    expect(item(o, 'VLAN 303 Link').fidelity).toBe('unsupported');
    expect(item(o, 'VLAN 302 Smallest').fidelity).toBe('approximate');
    expect(text).not.toContain('10.30.1.0/24');
    expect(text).not.toContain('10.10.200.0/29');
    expect(text).not.toContain('10.10.202.0/31');
    expect(text).toContain('"10.10.201.0/28"');
    expect(text).not.toContain('vlan_300');
    expect(text).not.toContain('vlan_301');
    expect(text).toContain('vlan_302_smallest');
    expect(o.counts.unsupported).toBe(3);
  });

  it('refuses when no VLAN can become a subnet, and still explains each one', () => {
    const o = aws(changed(p => {
      p.sites[0]!.blocks.push({ id: 'bx', network: '10.30.0.0/16', vrfId: 'r1', description: '', reserved: [] });
      p.vlans = [vlan('o1', { vlanId: '300', name: 'Elsewhere', ipv4: { network: '10.30.1.0/24' } }), vlan('o2', { vlanId: '301', name: 'Waiting' })];
    }));
    expect(o.ok).toBe(false);
    expect(o.files).toEqual([]);
    expect(o.items.map(i => [i.subject, i.fidelity])).toEqual([['VPC for site Headquarters, VRF Global', 'approximate'], ['VLAN 300 Elsewhere', 'unsupported']]);
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 301 Waiting']);
  });

  it('says nothing about a gateway on the first host address and reports any other', () => {
    expect(note(item(aws(examplePlan()), 'VLAN 10 Users'), 'Gateway')).toBeUndefined();
    for (const gw of ['10.10.10.2', '10.10.10.254', '10.10.10.7']) {
      const o = aws(changed(p => { byId(p, 'v1').ipv4.gateway = gw; byId(p, 'v1').reserved = []; }));
      const n = note(item(o, 'VLAN 10 Users'), 'Gateway');
      expect(n?.fidelity, gw).toBe('unsupported');
      expect(n!.detail).toContain(gw);
      expect(n!.detail).toContain('10.10.10.1,');
      expect(tf(o)).toContain(`"netforge:planned-gateway" = "${gw}"`);
    }
    const none = aws(changed(p => { byId(p, 'v4').ipv4.gateway = ''; }));
    expect(note(item(none, 'VLAN 99 Management'), 'Gateway')).toBeUndefined();
    expect(resource(tf(none), 'aws_subnet', 'vlan_99_management')).not.toContain('planned-gateway');
    const off = aws(changed(p => { byId(p, 'v3').ipv4.network = '10.10.30.128/25'; byId(p, 'v3').ipv4.gateway = '10.10.30.129'; byId(p, 'v3').reserved = []; }));
    expect(note(item(off, 'VLAN 30 Servers'), 'Gateway')).toBeUndefined();
  });

  it('reports DHCP pools, reserved addresses and a description, none of which AWS holds', () => {
    const o = aws(examplePlan());
    const users = item(o, 'VLAN 10 Users');
    expect(note(users, 'DHCP pools')?.fidelity).toBe('unsupported');
    expect(note(users, 'Reserved addresses')?.fidelity).toBe('unsupported');
    expect(note(users, 'Description')).toBeUndefined();
    const servers = item(o, 'VLAN 30 Servers');
    expect(note(servers, 'DHCP pools')).toBeUndefined();
    expect(note(servers, 'Description')?.fidelity).toBe('unsupported');
    expect(tf(o)).not.toContain('Static addressing only.');
    expect(tf(o)).not.toContain('10.10.10.100');
    const voice = item(o, 'VLAN 20 Voice');
    expect(note(voice, 'Reserved addresses')).toBeUndefined();
    const two = aws(changed(p => { byId(p, 'v2').ipv4.dhcp = ['10.10.20.50 - 10.10.20.60', '10.10.20.80 - 10.10.20.90']; }));
    expect(note(item(two, 'VLAN 20 Voice'), 'DHCP pools')!.detail).toContain('2 pools');
  });

  it('notes capacity only when the plan needs more than the subnet size minus five', () => {
    const cap = (hosts: string, network = '10.10.10.0/24') => note(item(aws(changed(p => { const v = byId(p, 'v1'); v.hosts = hosts; v.ipv4.network = network; if (network !== '10.10.10.0/24') { v.ipv4.dhcp = []; v.reserved = []; v.ipv4.gateway = ''; } })), 'VLAN 10 Users'), 'Capacity');
    expect(cap('251')).toBeUndefined();
    expect(cap('200')).toBeUndefined();
    expect(cap('')).toBeUndefined();
    expect(cap('252')?.fidelity).toBe('approximate');
    expect(cap('252')!.detail).toContain('251');
    expect(cap('254')!.detail).toContain('254');
    expect(cap('11', '10.10.10.0/28')).toBeUndefined();
    expect(cap('12', '10.10.10.0/28')!.detail).toContain('leaving 11');
  });

  it('gives every resource a unique lowercase identifier, whatever the names are', () => {
    const o = aws(changed(p => {
      p.namespaces.push({ id: 'n3', name: 'Lab', siteId: 's1', description: '' }, { id: 'n4', name: 'Lab 2', siteId: 's1', description: '' });
      p.vlans = [
        vlan('a', { vlanId: '10', name: 'Users', ipv4: { network: '10.10.1.0/24' } }),
        vlan('b', { vlanId: '10', name: 'users', namespaceId: 'n3', ipv4: { network: '10.10.2.0/24' } }),
        vlan('c', { vlanId: '10', name: 'USERS!', namespaceId: 'n4', ipv4: { network: '10.10.3.0/24' } }),
        vlan('d', { vlanId: '11', name: 'Users 2', ipv4: { network: '10.10.4.0/24' } }),
        vlan('e', { vlanId: '12', name: '', ipv4: { network: '10.10.5.0/24' } }),
        vlan('f', { vlanId: '13', name: '!!!', ipv4: { network: '10.10.6.0/24' } }),
        vlan('g', { vlanId: '14', name: `${C(0x4e2d, 0x6587)}`, ipv4: { network: '10.10.7.0/24' } }),
        vlan('h', { vlanId: '15', name: 'a'.repeat(100), ipv4: { network: '10.10.8.0/24' } }),
        vlan('i', { vlanId: '16', name: '9 lives -- "x" ${y}', ipv4: { network: '10.10.9.0/24' } }),
      ];
    }));
    const names = resources(tf(o)).map(r => r.name);
    expect(names).toEqual([
      'netforge_headquarters_global', 'vlan_10_users', 'vlan_10_users_2', 'vlan_10_users_3', 'vlan_11_users_2', 'vlan_12', 'vlan_13', 'vlan_14',
      `vlan_15_${'a'.repeat(40)}`, 'vlan_16_9_lives_x_y',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const n of names.slice(1)) expect(tf(o)).toContain(`var.netforge_availability_zones["${n}"]`);
  });

  it('names the VPC from the site and VRF, with a fallback', () => {
    const o = aws(changed(p => { p.sites[0]!.name = C(0x4e2d); p.vrfs[0]!.name = '!!'; }));
    expect(resources(tf(o))[0]).toEqual({ type: 'aws_vpc', name: 'netforge_vpc' });
    expect(tf(o)).toContain('vpc_id            = aws_vpc.netforge_vpc.id');
  });

  it('keeps plan text inside quoted strings', () => {
    const marker = 'Zed Marker';
    const hostile = `x${C(34)} } resource "aws_instance" "y" { ${BS}`;
    const o = aws(changed(p => { byId(p, 'v1').name = marker; byId(p, 'v2').name = hostile; byId(p, 'v3').description = '${file("x")}'; p.sites[0]!.name = 'HQ: main/site'; }));
    const text = tf(o);
    for (const line of text.split('\n').filter(l => l.includes(marker) || l.includes('HQ: main/site'))) expect(line).toMatch(/^ +(Name|"netforge:site") += "[^"]*"$/);
    expect(resources(text).some(r => r.type === 'aws_instance')).toBe(false);
    expect(text).not.toContain('"aws_instance"');
    expect(text).not.toContain('file(');
    expect(note(item(o, 'VLAN 20'), 'Tag Name')?.fidelity).toBe('unsupported');
    expect(resource(text, 'aws_subnet', 'vlan_20_x_resource_aws_instance_y')).not.toContain('Name ');
    expect(text.split('\n').filter(l => l.startsWith('#')).every(l => !l.includes(marker))).toBe(true);
  });

  it('leaves out a tag value AWS would not accept and says so', () => {
    const o = aws(changed(p => { byId(p, 'v1').name = 'Users (floor 2)'; byId(p, 'v2').name = 'x'.repeat(257); byId(p, 'v3').name = `a${C(0xd800)}`; byId(p, 'v4').name = 'x'.repeat(256); p.vrfs[0]!.name = 'Global, shared'; }));
    const text = tf(o);
    for (const label of ['VLAN 10', 'VLAN 20', 'VLAN 30']) {
      const i = item(o, label);
      expect(note(i, 'Tag Name')?.fidelity, label).toBe('unsupported');
      expect(note(i, 'Tag netforge:vrf')?.fidelity).toBe('unsupported');
    }
    expect(note(item(o, 'VLAN 99'), 'Tag Name')).toBeUndefined();
    expect(note(item(o, 'VPC for'), 'Tag netforge:vrf')?.fidelity).toBe('unsupported');
    expect(note(item(o, 'VPC for'), 'Tag Name')).toBeUndefined();
    expect(text).not.toContain('floor 2');
    expect(text).not.toContain('Global, shared');
    expect(text).not.toContain('netforge:vrf');
    expect(text).toContain(`Name                       = "${'x'.repeat(256)}"`);
    expect(text).not.toContain('x'.repeat(257));
    expect(text).not.toMatch(/[\ud800-\udfff]/);
    expect(text).toContain('"netforge:vlan-id"         = "10"');
  });

  it('writes only the Name tag when metadata tags are off', () => {
    const o = aws(examplePlan(), { metadataTags: false });
    const text = tf(o);
    expect(text).not.toContain('netforge:');
    expect(resource(text, 'aws_subnet', 'vlan_10_users')).toContain('  availability_zone = var.netforge_availability_zones["vlan_10_users"]\n  tags = {\n    Name = "Users"\n  }');
    expect(resource(text, 'aws_vpc', 'netforge_headquarters_global')).toContain('    Name = "Headquarters"');
    expect(note(item(o, 'VLAN 10 Users'), 'VLAN ID')!.detail).toContain('not written');
    const unnamed = aws(changed(p => { byId(p, 'v4').name = ''; }), { metadataTags: false });
    expect(resource(tf(unnamed), 'aws_subnet', 'vlan_99')).not.toContain('tags');
    expect(resource(tf(aws(changed(p => { byId(p, 'v4').name = ''; }))), 'aws_subnet', 'vlan_99')).toContain('"netforge:vlan-id"');
  });

  it('reports IPv6 as unsupported when it is off', () => {
    const o = aws(examplePlan());
    const text = tf(o);
    expect(text).not.toContain('ipv6');
    expect(text).not.toContain('2001:db8');
    const users = item(o, 'VLAN 10 Users');
    expect(note(users, 'IPv6')?.fidelity).toBe('unsupported');
    expect(note(users, 'IPv6 gateway')?.fidelity).toBe('unsupported');
    expect(note(users, 'More IPv6 prefixes')).toBeUndefined();
    expect(note(item(o, 'VLAN 99 Management'), 'IPv6')).toBeUndefined();
    expect(note(item(o, 'VLAN 99 Management'), 'IPv6 gateway')).toBeUndefined();
  });

  it('writes /64 prefixes inside a BYOIP block, with the pool variable and the dependency', () => {
    const o = aws(examplePlan(), { ipv6: 'byoip' });
    const text = tf(o);
    expect([...text.matchAll(/^variable "([a-z_0-9]+)" \{$/gm)].map(m => m[1])).toEqual(['netforge_availability_zones', 'netforge_ipv6_pool']);
    expect(resource(text, 'aws_vpc_ipv6_cidr_block_association', 'netforge_headquarters_global_ipv6')).toBe('  vpc_id          = aws_vpc.netforge_headquarters_global.id\n  ipv6_pool       = var.netforge_ipv6_pool\n  ipv6_cidr_block = "2001:db8:10::/48"');
    const users = resource(text, 'aws_subnet', 'vlan_10_users');
    expect(users).toContain('  ipv6_cidr_block   = "2001:db8:10:10::/64"\n  depends_on        = [aws_vpc_ipv6_cidr_block_association.netforge_headquarters_global_ipv6]\n');
    const mgmt = resource(text, 'aws_subnet', 'vlan_99_management');
    expect(mgmt).not.toContain('ipv6');
    expect(mgmt).not.toContain('depends_on');
    expect(note(item(o, 'VLAN 10 Users'), 'IPv6')).toBeUndefined();
    expect(note(item(o, 'VLAN 10 Users'), 'IPv6 gateway')?.fidelity).toBe('unsupported');
    expect(item(o, 'VLAN 10 Users').written).toHaveLength(2);
    expect(item(o, 'IPv6 CIDR block 2001:db8:10::/48').fidelity).toBe('exact');
    expect(o.manualSteps.some(s => s.includes('netforge_ipv6_pool'))).toBe(true);
    expect(aws(examplePlan()).manualSteps.some(s => s.includes('netforge_ipv6_pool'))).toBe(false);
  });

  it('accepts a VPC IPv6 block from /44 to /60 in steps of four only', () => {
    const withBlock6 = (network: string, prefix: string) => aws(changed(p => {
      p.sites[0]!.blocks[1]!.network = network;
      p.sites[1]!.blocks[1]!.network = 'fd00:20::/48';
      p.vlans = [vlan('v1', { vlanId: '10', name: 'Users', ipv4: { network: '10.10.10.0/24' }, ipv6: { prefixes: [prefix] } })];
    }), { ipv6: 'byoip' });
    for (const [network, ok] of [['2001:db8::/40', false], ['2001:db8::/43', false], ['2001:db8:10::/44', true], ['2001:db8:10::/47', false], ['2001:db8:10::/48', true], ['2001:db8:10::/52', true],
      ['2001:db8:10::/56', true], ['2001:db8:10:10::/60', true], ['2001:db8:10:10::/61', false], ['2001:db8:10:10::/62', false], ['2001:db8:10:10::/64', false]] as const) {
      const o = withBlock6(network, '2001:db8:10:10::/64');
      expect(o.ok, network).toBe(ok);
      if (!ok) expect(o.refusals[0]).toContain('/44 to /60');
    }
  });

  it('refuses BYOIP without an IPv6 parent block of that site and VRF', () => {
    for (const ipv6BlockId of ['', 'nope', 'b1', 'b5', 'b3']) expect(aws(examplePlan(), { ipv6: 'byoip', ipv6BlockId }).ok, ipv6BlockId).toBe(false);
    expect(aws(examplePlan(), { ipv6: 'none', ipv6BlockId: 'nope' }).ok).toBe(true);
  });

  it('writes one /64 inside the block and reports every other IPv6 prefix', () => {
    const o = aws(changed(p => {
      p.sites[0]!.blocks.push({ id: 'b9', network: '2001:db8:99::/48', vrfId: 'r1', description: '', reserved: [] });
      byId(p, 'v1').ipv6 = { prefixes: ['2001:db8:10:10::/64', '2001:db8:10:11::/64', '2001:db8:10:12::/64'], gateway: '', fixed: false };
      byId(p, 'v2').ipv6 = { prefixes: ['2001:db8:10:100::/56'], gateway: '', fixed: false };
      byId(p, 'v3').ipv6 = { prefixes: ['2001:db8:99:30::/64'], gateway: '2001:db8:99:30::1', fixed: false };
    }), { ipv6: 'byoip' });
    const text = tf(o);
    const users = item(o, 'VLAN 10 Users');
    expect(note(users, 'IPv6')).toBeUndefined();
    expect(note(users, 'More IPv6 prefixes')?.fidelity).toBe('unsupported');
    expect(note(users, 'More IPv6 prefixes')!.detail).toContain('2001:db8:10:11::/64, 2001:db8:10:12::/64');
    expect(note(users, 'IPv6 gateway')).toBeUndefined();
    expect(resource(text, 'aws_subnet', 'vlan_10_users')).toContain('ipv6_cidr_block   = "2001:db8:10:10::/64"');
    expect(text).not.toContain('2001:db8:10:11::/64');
    const voice = item(o, 'VLAN 20 Voice');
    expect(note(voice, 'IPv6')?.fidelity).toBe('unsupported');
    expect(note(voice, 'IPv6')!.detail).toContain('/64');
    expect(resource(text, 'aws_subnet', 'vlan_20_voice')).not.toContain('ipv6');
    expect(resource(text, 'aws_subnet', 'vlan_20_voice')).not.toContain('depends_on');
    const servers = item(o, 'VLAN 30 Servers');
    expect(note(servers, 'IPv6')!.detail).toContain('not inside');
    expect(note(servers, 'IPv6 gateway')?.fidelity).toBe('unsupported');
    expect(text).not.toContain('2001:db8:99');
  });

  it('skips a VLAN without an IPv4 network, even when it has IPv6', () => {
    const o = aws(changed(p => { byId(p, 'v5').ipv6.prefixes = ['2001:db8:10:40::/64']; }), { ipv6: 'byoip' });
    expect(o.skipped.map(s => s.subject)).toEqual(['VLAN 40 Cameras']);
    expect(tf(o)).not.toContain('2001:db8:10:40');
    expect(o.items.some(i => i.subject.startsWith('VLAN 40'))).toBe(false);
  });

  it('exports only the chosen site and VRF', () => {
    const branch = aws(examplePlan(), { siteId: 's2', blockId: 'b4' });
    expect(resources(tf(branch)).map(r => r.name)).toEqual(['netforge_branch_office_global', 'vlan_10_users', 'vlan_20_voice']);
    expect(tf(branch)).not.toContain('10.10.');
    expect(branch.skipped.map(s => s.subject)).toEqual(['VLAN 50 Printers']);
    const guest = aws(examplePlan(), { vrfId: 'r2', blockId: 'b3' });
    expect(resources(tf(guest)).map(r => r.name)).toEqual(['netforge_headquarters_guest_hq', 'vlan_200_guest']);
    expect(resource(tf(guest), 'aws_vpc', 'netforge_headquarters_guest_hq')).toContain('cidr_block = "192.168.100.0/24"');
  });

  it('writes at most AWS_MAX_SUBNETS subnets, and that many in reasonable time', () => {
    const big = (count: number) => changed(p => {
      p.vlans = [];
      for (let i = 0; i < count; i++) p.vlans.push(vlan(`x${i}`, { vlanId: String(i + 2), name: `Net ${i}`, ipv4: { network: `10.10.${Math.floor(i / 16)}.${(i % 16) * 16}/28`, gateway: `10.10.${Math.floor(i / 16)}.${(i % 16) * 16 + 1}` } }));
      p.sites[0]!.blocks[0]!.reserved = [];
    });
    expect(AWS_MAX_SUBNETS).toBe(2000);
    const started = Date.now();
    const o = aws(big(2000));
    expect(o.ok).toBe(true);
    expect(resources(tf(o))).toHaveLength(2001);
    expect(o.items).toHaveLength(2001);
    expect(Date.now() - started).toBeLessThan(15_000);
    const over = aws(big(2001));
    expect(over.ok).toBe(false);
    expect(over.refusals[0]).toContain('2,000');
  });
});

describe('awsTerraform and neutralData, more boundaries', () => {
  it('writes no subnet for a network below the VPC block', () => {
    const o = aws(changed(p => {
      p.sites[0]!.blocks.push({ id: 'bx', network: '10.30.0.0/16', vrfId: 'r1', description: '', reserved: [] });
      p.vlans.push(vlan('o1', { vlanId: '300', name: 'Inside', ipv4: { network: '10.30.1.0/24' } }));
    }), { blockId: 'bx' });
    expect(resources(tf(o)).map(r => r.name)).toEqual(['netforge_headquarters_global', 'vlan_300_inside']);
    for (const label of ['VLAN 10 Users', 'VLAN 20 Voice', 'VLAN 30 Servers', 'VLAN 99 Management']) {
      expect(item(o, label).fidelity, label).toBe('unsupported');
      expect(item(o, label).notes[0]!.detail).toContain('not inside');
    }
  });

  it('reports a second IPv6 prefix, and none when there is one', () => {
    const o = aws(changed(p => { byId(p, 'v1').ipv6.prefixes = ['2001:db8:10:10::/64', '2001:db8:10:11::/64']; }), { ipv6: 'byoip' });
    expect(note(item(o, 'VLAN 10 Users'), 'More IPv6 prefixes')!.detail).toContain('2001:db8:10:11::/64');
    expect(note(item(o, 'VLAN 20 Voice'), 'More IPv6 prefixes')).toBeUndefined();
    const off = aws(changed(p => { byId(p, 'v1').ipv6.prefixes = ['2001:db8:10:10::/64', '2001:db8:10:11::/64']; }));
    expect(note(item(off, 'VLAN 10 Users'), 'More IPv6 prefixes')).toBeUndefined();
    expect(note(item(off, 'VLAN 10 Users'), 'IPv6')!.detail).toContain('2001:db8:10:10::/64, 2001:db8:10:11::/64');
  });

  it('refuses an IPv6 block that belongs to another VRF of the same site', () => {
    const p = changed(x => { x.sites[0]!.blocks.push({ id: 'b8', network: 'fd00:8::/48', vrfId: 'r2', description: '', reserved: [] }); });
    expect(aws(p, { ipv6: 'byoip', ipv6BlockId: 'b8' }).ok).toBe(false);
    expect(aws(p, { ipv6: 'byoip', ipv6BlockId: 'b2' }).ok).toBe(true);
  });

  it('writes null for the site of a namespace that spans sites', () => {
    const d = data(changed(x => { x.namespaces.push({ id: 'n9', name: 'Stretched', siteId: '', description: '' }); }));
    expect(d.vlan_namespaces.n9).toEqual({ name: 'Stretched', site: null, description: '' });
    expect(d.vlan_namespaces.n2!.site).toBe('s2');
  });
});
