/**
 * Terraform previews for a network plan.
 *
 * 1. Variables: the provider-neutral data as typed Terraform variables with their values, for any
 *    provider or module. Nothing in it is specific to a cloud.
 * 2. AWS: one VPC and its subnets (hashicorp/aws). A VPC is not a site, a VRF or a VLAN: it has no
 *    VLAN IDs, no broadcast domain, no gateway address of your choosing and no DHCP pools. The
 *    export maps one parent block of one site and VRF to a VPC and each VLAN network inside it to
 *    a subnet, and reports everything the plan says that AWS cannot hold. It never writes an
 *    Availability Zone, a route table, a gateway or any other resource the plan does not describe.
 *
 * Nothing is applied or planned by NetForge. Plan text only ever appears inside HCL strings
 * written by hcl.ts. Resource names (and the comment that lists them) carry a slug of a name:
 * lowercase letters, digits and underscores only, never the text itself.
 */
import { formatInteger } from '../format';
import { parsePrefixText, prefixSize, prefixToRange, type IpPrefix } from '../net/address';
import { toJsonText } from '../export/files';
import type { Plan } from '../plan/model';
import { HclRaw, hasLoneSurrogate, hclValue, type HclValue } from './hcl';
import { ItemBuilder, output, refused, type ExportItem, type ExportOutput, type Skipped } from './model';
import { neutralData, neutralItems, type NeutralData } from './neutral';
import { cidr, ip4, ip6, resolvePlan, scopedVlans, scopeProblem, type ExportScope } from './source';
import { slug } from './text';

export type ValuesFormat = 'hcl' | 'json';

const VARIABLES_TF = `# NetForge preview: variable declarations for a network plan.
# These variables hold data only. They create nothing until your own configuration uses them.

variable "netforge_sites" {
  description = "Sites of the network plan, by plan id, with the address blocks each may use."
  type = map(object({
    name        = string
    description = string
    notes       = string
    parent_blocks = list(object({
      id          = string
      network     = string
      family      = number
      vrf         = string
      description = string
      reserved = list(object({
        family = number
        first  = string
        last   = string
        label  = string
      }))
    }))
  }))
}

variable "netforge_vrfs" {
  description = "Routing domains (VRFs), by plan id. site is null for a VRF available at every site."
  type = map(object({
    name                  = string
    site                  = string
    exchanges_routes_with = list(string)
    description           = string
    notes                 = string
  }))
}

variable "netforge_vlan_namespaces" {
  description = "Switching domains in which VLAN IDs are unique, by plan id. site is null for one that spans sites."
  type = map(object({
    name        = string
    site        = string
    description = string
  }))
}

variable "netforge_vlans" {
  description = "VLANs, by plan id. site, vrf and vlan_namespace are keys of the other variables. Networks and gateways are null when the plan has none."
  type = map(object({
    vlan_id        = number
    name           = string
    site           = string
    vrf            = string
    vlan_namespace = string
    description    = string
    notes          = string
    hosts_target   = number
    ipv4_network   = string
    ipv4_netmask   = string
    ipv4_gateway   = string
    ipv4_dhcp_pools = list(object({
      first = string
      last  = string
    }))
    ipv6_prefixes = list(string)
    ipv6_gateway  = string
    reserved = list(object({
      family = number
      first  = string
      last   = string
      label  = string
    }))
  }))
}
`;

/** Replaces strings that cannot be stored (a lone surrogate) with null and reports where. */
function storable(value: unknown, path: string, dropped: string[]): unknown {
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) { dropped.push(path); return null; }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => storable(v, `${path}[${i}]`, dropped));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = storable(v, path === '' ? k : `${path}.${k}`, dropped);
    return out;
  }
  return value;
}

/** Typed variable declarations plus the plan's values as a .tfvars file (HCL or JSON syntax). */
export function terraformVariables(plan: Plan, scope: ExportScope, format: ValuesFormat): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const problem = scopeProblem(plan, scope);
  if (problem) return refused([problem]);
  const raw = neutralData(resolved.value, scope);
  if (Object.keys(raw.vlans).length === 0) return refused(['No VLAN is in this selection.']);
  const dropped: string[] = [];
  const data = storable(raw, '', dropped) as NeutralData;
  const values = {
    netforge_sites: data.sites, netforge_vrfs: data.vrfs, netforge_vlan_namespaces: data.vlan_namespaces, netforge_vlans: data.vlans,
  } as unknown as { readonly [key: string]: HclValue };
  const valuesFile = format === 'json'
    ? { name: 'netforge.auto.tfvars.json', kind: 'Terraform variable values (JSON)', mime: 'application/json', text: toJsonText(values) }
    : {
      name: 'netforge.auto.tfvars', kind: 'Terraform variable values (HCL)', mime: 'text/plain',
      text: `# NetForge preview: values for the variables in netforge_variables.tf.\n\n${Object.entries(values).map(([k, v]) => `${k} = ${hclValue(v)}`).join('\n\n')}\n`,
    };
  const items = neutralItems(raw).map(item => item);
  const extra: ExportItem[] = dropped.length === 0 ? [] : [
    new ItemBuilder('Text that cannot be stored').wrote('null in place of each value').unsupported('Text', `${dropped.length === 1 ? 'One value has' : `${dropped.length} values have`} half of a surrogate pair, which a UTF-8 file cannot hold: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ', ...' : ''}.`).build(),
  ];
  return output({
    files: [{ name: 'netforge_variables.tf', kind: 'Terraform (HCL)', mime: 'text/plain', text: VARIABLES_TF }, valuesFile],
    items: [...extra, ...items],
    assumptions: [
      'Terraform 1.0 or later, or OpenTofu. No provider is needed: the files declare variables and give them values, and create no resources.',
      'Map keys are the plan\'s own ids. Text from the plan appears only inside strings, where "${" and "%{" are escaped so nothing is evaluated.',
      'Networks, gateways and ranges are written in canonical form.',
    ],
    manualSteps: ['Put both files in a Terraform configuration and refer to var.netforge_vlans and the other variables from your own resources or modules.'],
    notCovered: ['Resources of any kind. The AWS target writes a VPC and subnets; everything else is yours to write against these variables.'],
  });
}

export type Ipv6Mode = 'none' | 'byoip';

export interface AwsOptions {
  /** One site and one VRF: a VPC is built from one of that site's parent blocks in that VRF. */
  readonly siteId: string;
  readonly vrfId: string;
  /** The id of the IPv4 parent block that becomes the VPC's CIDR block. */
  readonly blockId: string;
  readonly ipv6: Ipv6Mode;
  /** For 'byoip': the id of the IPv6 parent block that becomes the VPC's IPv6 CIDR block. */
  readonly ipv6BlockId: string;
  /** Write the plan's site, VRF, VLAN ID and gateway as netforge: tags. */
  readonly metadataTags: boolean;
}

export const AWS_PROVIDER_CONSTRAINT = '~> 6.0';
export const TERRAFORM_CONSTRAINT = '>= 1.5.0';
export const AWS_MAX_SUBNETS = 2000;

/** Characters AWS accepts in tag values across services: letters, digits, spaces and + - = . _ : / @ */
const TAG_VALUE = /^[\p{L}\p{N} +\-=._:/@]*$/u;
export const TAG_VALUE_MAX = 256;

export function checkTagValue(value: string): string | null {
  if ([...value].length > TAG_VALUE_MAX) return `it is longer than ${TAG_VALUE_MAX} characters`;
  if (!TAG_VALUE.test(value)) return 'it has characters AWS tags do not accept everywhere (letters, digits, spaces and + - = . _ : / @ are accepted)';
  return null;
}

function inside(outer: IpPrefix, inner: IpPrefix): boolean {
  const o = prefixToRange(outer);
  const i = prefixToRange(inner);
  return outer.family === inner.family && o.first <= i.first && i.last <= o.last;
}

class Names {
  private readonly used = new Set<string>();
  take(base: string): string {
    let name = base;
    for (let n = 2; this.used.has(name); n++) name = `${base}_${n}`;
    this.used.add(name);
    return name;
  }
}

const AWS_NOT_COVERED: readonly string[] = [
  'Availability Zones are never chosen: each subnet reads its zone from a variable you fill in.',
  'Route tables, routes, internet gateways, NAT gateways, VPC peering, transit gateways, VPN and Direct Connect.',
  'Security groups, network ACLs, DHCP option sets, VPC endpoints and flow logs.',
  'The provider block: region, credentials and profile are yours to configure.',
  'Subnet CIDR reservations, secondary VPC CIDR blocks and IPv6-only subnets.',
];

/** AWS VPC and subnet resources for one site and VRF. */
export function awsTerraform(plan: Plan, options: AwsOptions): ExportOutput {
  const resolved = resolvePlan(plan);
  if (!resolved.ok) return refused(resolved.refusals);
  const site = plan.sites.find(s => s.id === options.siteId);
  const vrf = plan.vrfs.find(v => v.id === options.vrfId);
  const refusals: string[] = [];
  if (!site) refusals.push('Choose one site. A VPC is built from one site\'s address block.');
  if (!vrf) refusals.push('Choose one VRF. Networks of different VRFs can overlap, and a VPC has a single address space.');
  if (!site || !vrf) return refused(refusals, { notCovered: AWS_NOT_COVERED });
  const scope: ExportScope = { siteId: site.id, vrfId: vrf.id, namespaceId: '' };
  const problem = scopeProblem(plan, scope);
  if (problem) return refused([problem]);

  const block = site.blocks.find(b => b.id === options.blockId && b.vrfId === vrf.id);
  const parsedBlock = block ? parsePrefixText(block.network.trim()) : null;
  if (!block || !parsedBlock || !parsedBlock.ok || parsedBlock.value.prefix.family !== 4) {
    return refused(['Choose the IPv4 parent block that becomes the VPC\'s CIDR block. The plan must hold it: add a parent block for this site and VRF in the planner. NetForge does not invent a VPC range.'], { notCovered: AWS_NOT_COVERED });
  }
  const vpcCidr = parsedBlock.value.prefix;
  if (vpcCidr.length < 16 || vpcCidr.length > 28) {
    return refused([`${cidr(vpcCidr)} cannot be a VPC CIDR block: AWS accepts /16 to /28. Choose or add a parent block in that range.`], { notCovered: AWS_NOT_COVERED });
  }
  let vpc6: IpPrefix | null = null;
  if (options.ipv6 === 'byoip') {
    const b6 = site.blocks.find(b => b.id === options.ipv6BlockId && b.vrfId === vrf.id);
    const p6 = b6 ? parsePrefixText(b6.network.trim()) : null;
    if (!b6 || !p6 || !p6.ok || p6.value.prefix.family !== 6) {
      return refused(['Choose the IPv6 parent block that the VPC takes from your BYOIP address pool, or turn IPv6 off for this export.'], { notCovered: AWS_NOT_COVERED });
    }
    vpc6 = p6.value.prefix;
    if (vpc6.length < 44 || vpc6.length > 60 || vpc6.length % 4 !== 0) {
      return refused([`${cidr(vpc6)} cannot be a VPC IPv6 CIDR block: AWS accepts /44 to /60 in steps of 4 from a BYOIP pool.`], { notCovered: AWS_NOT_COVERED });
    }
  }

  const vlans = scopedVlans(resolved.value, scope);
  if (vlans.length > AWS_MAX_SUBNETS) return refused([`This selection has ${formatInteger(vlans.length)} VLANs. The AWS export writes at most ${formatInteger(AWS_MAX_SUBNETS)} subnets.`]);
  const names = new Names();
  const vpcName = names.take(`netforge_${slug(`${site.name} ${vrf.name}`) || 'vpc'}`);
  const items: ExportItem[] = [];
  const skipped: Skipped[] = [];
  const blocks: string[] = [];

  const tags = (item: ItemBuilder, entries: readonly (readonly [string, string, string])[]): HclValue => {
    const out: Record<string, HclValue> = {};
    for (const [key, value, field] of entries) {
      if (value === '') continue;
      if (key !== 'Name' && !options.metadataTags) continue;
      const bad = hasLoneSurrogate(value) ? 'it has half of a surrogate pair' : checkTagValue(value);
      if (bad) { item.unsupported(`Tag ${key}`, `The ${field} is not written as a tag: ${bad}.`); continue; }
      out[key] = value;
    }
    return out;
  };

  const vpcItem = new ItemBuilder(`VPC for site ${site.name.trim() || '(unnamed)'}, VRF ${vrf.name.trim() || '(unnamed)'}`);
  const vpcBody: Record<string, HclValue> = { cidr_block: cidr(vpcCidr) };
  vpcItem.wrote(`aws_vpc.${vpcName} with CIDR block ${cidr(vpcCidr)}`);
  const vpcTags = tags(vpcItem, [['Name', site.name.trim(), 'site name'], ['netforge:site', site.name.trim(), 'site name'], ['netforge:vrf', vrf.name.trim(), 'VRF name']]);
  if (Object.keys(vpcTags as object).length > 0) vpcBody.tags = vpcTags;
  vpcItem.approximate('Meaning', 'A VPC stands in for the site\'s address block in this VRF. It is not a VRF or a VLAN: there are no VLAN IDs and no layer 2 adjacency between subnets.');
  if (vrf.exchangesWith.length > 0 || plan.vrfs.some(v => v.exchangesWith.includes(vrf.id))) vpcItem.unsupported('Route exchange', 'The plan says this VRF exchanges routes with another. No peering, transit gateway or routes are written.');
  if (block.reserved.length > 0) vpcItem.unsupported('Reserved space', `The parent block has ${block.reserved.length === 1 ? '1 reserved entry' : `${block.reserved.length} reserved entries`}, which a VPC cannot record.`);
  items.push(vpcItem.build());
  blocks.push(`resource "aws_vpc" "${vpcName}" ${hclValue(vpcBody)}`);
  let assocName = '';
  if (vpc6) {
    assocName = names.take(`${vpcName}_ipv6`);
    blocks.push(`resource "aws_vpc_ipv6_cidr_block_association" "${assocName}" ${hclValue({ vpc_id: new HclRaw(`aws_vpc.${vpcName}.id`), ipv6_pool: new HclRaw('var.netforge_ipv6_pool'), ipv6_cidr_block: cidr(vpc6) })}`);
    items.push(new ItemBuilder(`IPv6 CIDR block ${cidr(vpc6)}`).wrote(`aws_vpc_ipv6_cidr_block_association.${assocName} from the BYOIP pool in var.netforge_ipv6_pool`).build());
  }

  const zoneKeys: string[] = [];
  for (const v of vlans) {
    if (v.net4 === null) { skipped.push({ subject: v.label, reason: 'it has no IPv4 network. Subnets in this export need an IPv4 CIDR block.' }); continue; }
    const item = new ItemBuilder(v.label);
    if (!inside(vpcCidr, v.net4)) { item.unsupported('Subnet', `${cidr(v.net4)} is not inside the VPC CIDR block ${cidr(vpcCidr)}.`); items.push(item.build()); continue; }
    if (v.net4.length < 16 || v.net4.length > 28) { item.unsupported('Subnet', `${cidr(v.net4)} cannot be an AWS subnet: AWS accepts /16 to /28.`); items.push(item.build()); continue; }
    const key = names.take(v.number === null ? `subnet_${slug(v.name) || 'unnamed'}` : `vlan_${v.number}${slug(v.name) ? `_${slug(v.name)}` : ''}`);
    zoneKeys.push(key);
    const body: Record<string, HclValue> = {
      vpc_id: new HclRaw(`aws_vpc.${vpcName}.id`),
      cidr_block: cidr(v.net4),
      availability_zone: new HclRaw(`var.netforge_availability_zones["${key}"]`),
    };
    item.wrote(`aws_subnet.${key} with CIDR block ${cidr(v.net4)}`);
    const net = prefixToRange(v.net4);
    const awsUsable = prefixSize(4, v.net4.length) - 5n;
    if (v.number !== null) item.approximate('VLAN ID', `VLAN ${v.number} has no meaning in a VPC. ${options.metadataTags ? 'It is kept as a tag only.' : 'It is not written.'}`);
    if (v.gateway4 !== null && v.gateway4 !== net.first + 1n) item.unsupported('Gateway', `The plan's gateway is ${ip4(v.gateway4)}. In AWS the subnet's router is always the first host address, ${ip4(net.first + 1n)}, and cannot be changed.`);
    if (v.pools.length > 0) item.unsupported('DHCP pools', `AWS assigns addresses itself from the whole subnet; the ${v.pools.length === 1 ? 'pool' : `${v.pools.length} pools`} in the plan cannot be set.`);
    if (v.reserved4.length > 0) item.unsupported('Reserved addresses', `${v.reserved4.length === 1 ? '1 reserved range is' : `${v.reserved4.length} reserved ranges are`} not written.`);
    const hosts = /^[0-9]{1,15}$/.test(v.vlan.hosts.trim()) ? BigInt(v.vlan.hosts.trim()) : null;
    if (hosts !== null && hosts > awsUsable) item.approximate('Capacity', `The plan asks for ${formatInteger(hosts)} addresses. AWS reserves five addresses in every subnet, leaving ${formatInteger(awsUsable)} in ${cidr(v.net4)}.`);
    if (v.net6.length > 0) {
      const first = v.net6[0]!;
      if (!vpc6) item.unsupported('IPv6', `${v.net6.map(cidr).join(', ')} not written: IPv6 is off for this export. AWS gives a VPC its IPv6 range, or takes it from a BYOIP pool.`);
      else if (first.length !== 64) item.unsupported('IPv6', `${cidr(first)} is not written: this export writes /64 subnet prefixes only.`);
      else if (!inside(vpc6, first)) item.unsupported('IPv6', `${cidr(first)} is not inside the VPC's IPv6 CIDR block ${cidr(vpc6)}.`);
      else {
        body.ipv6_cidr_block = cidr(first);
        body.depends_on = new HclRaw(`[aws_vpc_ipv6_cidr_block_association.${assocName}]`);
        item.wrote(`IPv6 CIDR block ${cidr(first)}`);
      }
      if (vpc6 && v.net6.length > 1) item.unsupported('More IPv6 prefixes', `A subnet in this export has one IPv6 CIDR block; ${v.net6.slice(1).map(cidr).join(', ')} not written.`);
      if (v.gateway6) item.unsupported('IPv6 gateway', `The plan's IPv6 gateway ${ip6(v.gateway6.value)} cannot be set: the AWS router chooses its own address.`);
    }
    const subnetTags = tags(item, [
      ['Name', v.name, 'VLAN name'],
      ['netforge:site', site.name.trim(), 'site name'],
      ['netforge:vrf', vrf.name.trim(), 'VRF name'],
      ['netforge:vlan-id', v.number === null ? '' : String(v.number), 'VLAN ID'],
      ['netforge:planned-gateway', v.gateway4 === null ? '' : ip4(v.gateway4), 'gateway'],
    ]);
    if (Object.keys(subnetTags as object).length > 0) body.tags = subnetTags;
    if (v.vlan.description.trim() !== '') item.unsupported('Description', 'A subnet has no description field; the plan\'s description is not written.');
    items.push(item.build());
    blocks.push(`resource "aws_subnet" "${key}" ${hclValue(body)}`);
  }
  if (zoneKeys.length === 0) return refused([`No VLAN of this site and VRF has an IPv4 network inside ${cidr(vpcCidr)} that AWS accepts, so there is nothing to write.`], { items, skipped, notCovered: AWS_NOT_COVERED });

  const head = [
    '# NetForge preview: an AWS VPC and subnets generated from a network plan.',
    '# NetForge has not run terraform plan or terraform apply. Review every block before you do.',
    '# A VPC is not an on-premises VLAN or VRF. Read the notes that came with this export.',
    '',
    'terraform {',
    `  required_version = "${TERRAFORM_CONSTRAINT}"`,
    '',
    '  required_providers {',
    '    aws = {',
    '      source  = "hashicorp/aws"',
    `      version = "${AWS_PROVIDER_CONSTRAINT}"`,
    '    }',
    '  }',
    '}',
    '',
    'variable "netforge_availability_zones" {',
    '  description = "The Availability Zone of each subnet, by subnet key. A network plan holds no Availability Zones, so every key needs a value."',
    '  type        = map(string)',
    '}',
    '',
    `# Keys expected in netforge_availability_zones: ${zoneKeys.join(', ')}`,
    ...(vpc6 ? ['', 'variable "netforge_ipv6_pool" {', '  description = "The ID of the BYOIP IPv6 address pool that holds the VPC IPv6 CIDR block."', '  type        = string', '}'] : []),
    '',
  ];
  return output({
    files: [{ name: 'netforge_aws.tf', kind: 'Terraform (HCL)', mime: 'text/plain', text: `${head.join('\n')}\n${blocks.join('\n\n')}\n` }],
    items, skipped,
    assumptions: [
      `Terraform ${TERRAFORM_CONSTRAINT} with the hashicorp/aws provider ${AWS_PROVIDER_CONSTRAINT}.`,
      'An AWS VPC is not a VLAN, a VRF or a site. This export uses a VPC as the container for one site\'s address block in one VRF, and a subnet for each VLAN network inside it. Subnets are routed to each other by the VPC; nothing here gives them layer 2 adjacency.',
      'AWS reserves five addresses in every subnet: the network address, the next three (router, DNS, future use) and the last. Addresses the plan gives to a gateway, a pool or a reservation may be among them.',
      'Tags named netforge:... record the plan\'s values. They configure nothing.',
      ...(vpc6 ? ['IPv6: the VPC takes its IPv6 CIDR block from your own BYOIP address pool, which must hold the planned range. Without BYOIP, AWS chooses the range and the plan\'s prefixes cannot be used.'] : []),
    ],
    manualSteps: [
      `Give every subnet an Availability Zone: set netforge_availability_zones for ${zoneKeys.length === 1 ? 'the key' : `all ${formatInteger(zoneKeys.length)} keys`} listed in the file.`,
      ...(vpc6 ? ['Set netforge_ipv6_pool to the ID of your BYOIP IPv6 pool.'] : []),
      'Configure the aws provider (region and credentials) yourself.',
      'Add routing, gateways and security rules; without them the subnets reach nothing outside the VPC.',
      'Run terraform plan and read it before any apply.',
    ],
    notCovered: AWS_NOT_COVERED,
  });
}
