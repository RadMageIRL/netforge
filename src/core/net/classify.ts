/**
 * Address classification from the IANA special-purpose address registries (bundled; see
 * registry-data.ts for sources and dates). An address can match several registry blocks, so the
 * result lists every match and a set of properties instead of forcing one category.
 *
 * "Globally reachable" here is the registry's column: whether an address of that type may be
 * reachable across the Internet. It says nothing about whether a particular address is actually
 * routed today, which depends on allocation and routing announcements that NetForge cannot see.
 */
import { makePrefix, parsePrefixText, prefixToRange, type Family, type IpPrefix, type IpRange } from './address';
import { IPV6_ADDRESS_SPACE, SPECIAL_PURPOSE } from './registry-data';
import type { AddressSpaceRow, RegistryFlag, RegistryRow, RegistryTag } from './registry-types';

export interface RegistryBlock extends RegistryRow {
  readonly prefix: IpPrefix;
  readonly range: IpRange;
}

function toPrefix(block: string): IpPrefix {
  const p = parsePrefixText(block);
  if (!p.ok || p.value.hostBitsSet) throw new Error(`Registry block ${block} is not a valid network`);
  return p.value.prefix;
}

export const REGISTRY_BLOCKS: readonly RegistryBlock[] = SPECIAL_PURPOSE.map(row => {
  const prefix = toPrefix(row.block);
  return { ...row, prefix, range: prefixToRange(prefix) };
});

const ADDRESS_SPACE = IPV6_ADDRESS_SPACE.map(row => ({ ...row, range: prefixToRange(toPrefix(row.block)) }));

/** IPv4 multicast (RFC 5771) and the sub-blocks with distinct scope rules. Not part of the special-purpose registry. */
const IPV4_MULTICAST = prefixToRange(makePrefix(4, 0xe0000000n, 4));
const IPV4_MULTICAST_SCOPES: readonly { range: IpRange; label: string }[] = [
  { range: prefixToRange(makePrefix(4, 0xe0000000n, 24)), label: 'Local Network Control Block, never forwarded off the link (RFC 5771)' },
  { range: prefixToRange(makePrefix(4, 0xe8000000n, 8)), label: 'Source-Specific Multicast (RFC 4607)' },
  { range: prefixToRange(makePrefix(4, 0xef000000n, 8)), label: 'Administratively scoped, organization-local (RFC 2365)' },
];

/** IPv6 multicast scope values (RFC 4291 section 2.7, RFC 7346). */
const IPV6_SCOPES: Readonly<Record<number, string>> = {
  0x1: 'Interface-local',
  0x2: 'Link-local',
  0x3: 'Realm-local',
  0x4: 'Admin-local',
  0x5: 'Site-local',
  0x8: 'Organization-local',
  0xe: 'Global',
  0x0: 'Reserved',
  0xf: 'Reserved',
};

export type Property =
  | RegistryTag
  | 'multicast'
  | 'global-unicast'
  | 'unique-local'
  | 'reserved-by-ietf'
  | 'site-local-deprecated';

export const PROPERTY_LABELS: Readonly<Record<Property, string>> = {
  'private-use': 'Private / local use',
  'shared-address-space': 'Shared address space (carrier-grade NAT)',
  'loopback': 'Loopback',
  'link-local': 'Link-local',
  'documentation': 'Documentation',
  'benchmarking': 'Benchmarking',
  'reserved': 'Reserved',
  'unspecified': 'Unspecified',
  'this-network': 'This network',
  'limited-broadcast': 'Limited broadcast',
  'protocol-assignment': 'IETF protocol assignment',
  'anycast': 'Anycast',
  'translation': 'IPv4/IPv6 translation',
  'tunneling': 'Tunneling',
  'discard': 'Discard-only',
  'ipv4-mapped': 'IPv4-mapped',
  'deprecated': 'Deprecated',
  'multicast': 'Multicast',
  'global-unicast': 'Global unicast space',
  'unique-local': 'Unique local (ULA)',
  'reserved-by-ietf': 'Reserved by IETF',
  'site-local-deprecated': 'Site-local (deprecated)',
};

export type Reachability = RegistryFlag | 'not-listed';

export interface Classification {
  readonly family: Family;
  readonly value: bigint;
  /** Every special-purpose block containing the address, most specific first. */
  readonly matches: readonly RegistryBlock[];
  readonly properties: readonly Property[];
  /**
   * The registry's Globally Reachable value from the most specific block that states one.
   * 'not-listed' means no special-purpose block covers the address.
   */
  readonly globallyReachable: Reachability;
  /** The block that decided `globallyReachable`, if any. */
  readonly reachabilityFrom: RegistryBlock | null;
  /** One sentence on what `globallyReachable` means for this address. */
  readonly reachabilityNote: string;
  /** IPv6 address space allocation (2000::/3 Global Unicast and so on). */
  readonly addressSpace: AddressSpaceRow | null;
  readonly multicastScope: string | null;
  /** For an IPv4-mapped IPv6 address, the classification of the IPv4 address inside it. */
  readonly embeddedIPv4: Classification | null;
}

const ROUTING_NOTE = 'Whether a particular address is routed on the Internet depends on who holds it and what they announce, which NetForge cannot check offline.';

export function classifyAddress(family: Family, value: bigint): Classification {
  const matches = REGISTRY_BLOCKS
    .filter(b => b.family === family && b.range.first <= value && value <= b.range.last)
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const properties = new Set<Property>();
  for (const m of matches) for (const t of m.tags) properties.add(t);

  let addressSpace: AddressSpaceRow | null = null;
  let multicastScope: string | null = null;
  if (family === 6) {
    const space = ADDRESS_SPACE.find(s => s.range.first <= value && value <= s.range.last) ?? null;
    addressSpace = space ? { block: space.block, allocation: space.allocation, reference: space.reference, notes: space.notes } : null;
    if (space?.allocation === 'Multicast') {
      properties.add('multicast');
      const scope = Number((value >> 112n) & 0xfn);
      multicastScope = `${IPV6_SCOPES[scope] ?? 'Unassigned'} scope (${scope.toString(16)})`;
    } else if (space?.allocation === 'Global Unicast') properties.add('global-unicast');
    else if (space?.allocation === 'Unique Local Unicast') properties.add('unique-local');
    else if (space?.block === 'fec0::/10') properties.add('site-local-deprecated');
    else if (space?.allocation === 'Reserved by IETF') properties.add('reserved-by-ietf');
  } else if (IPV4_MULTICAST.first <= value && value <= IPV4_MULTICAST.last) {
    properties.add('multicast');
    multicastScope = IPV4_MULTICAST_SCOPES.find(s => s.range.first <= value && value <= s.range.last)?.label ?? 'Multicast (RFC 5771)';
  }

  const decider = matches.find(m => m.globallyReachable !== 'unspecified') ?? null;
  let globallyReachable: Reachability;
  let reachabilityNote: string;
  if (decider) {
    globallyReachable = decider.globallyReachable;
    const where = `${decider.block} (${decider.name})`;
    reachabilityNote = globallyReachable === 'true'
      ? `The registry marks ${where} as globally reachable (RFC 8190): traffic to addresses of this type may be forwarded beyond an administrative domain. ${ROUTING_NOTE}`
      : globallyReachable === 'false'
        ? `The registry marks ${where} as not globally reachable (RFC 8190): traffic to addresses of this type is not forwarded beyond an administrative domain.`
        : `The registry says global reachability does not apply to ${where}; see its RFC.`;
  } else if (matches.length > 0) {
    globallyReachable = 'unspecified';
    reachabilityNote = `The registry gives no reachability for ${matches[0].block} (${matches[0].name}).`;
  } else {
    globallyReachable = 'not-listed';
    if (properties.has('multicast')) reachabilityNote = 'Multicast is outside the special-purpose registry; how far a group reaches depends on its scope.';
    else if (properties.has('reserved-by-ietf') || properties.has('site-local-deprecated')) reachabilityNote = `This space is ${addressSpace?.allocation ?? 'reserved'} in the IPv6 address space registry and is not assigned for general use.`;
    else reachabilityNote = `Not a special-purpose address: ordinary unicast space. ${ROUTING_NOTE}`;
  }

  const embeddedIPv4 = family === 6 && value >> 32n === 0xffffn ? classifyAddress(4, value & 0xffffffffn) : null;
  return {
    family, value, matches, properties: [...properties], globallyReachable, reachabilityFrom: decider,
    reachabilityNote, addressSpace, multicastScope, embeddedIPv4,
  };
}

/** Special-purpose blocks that overlap a prefix, with how they relate to it. */
export function blocksOverlapping(prefix: IpPrefix): { block: RegistryBlock; relation: 'contains-prefix' | 'inside-prefix' | 'equal' }[] {
  const r = prefixToRange(prefix);
  return REGISTRY_BLOCKS
    .filter(b => b.family === prefix.family && b.range.first <= r.last && r.first <= b.range.last)
    .map(block => ({
      block,
      relation: block.range.first === r.first && block.range.last === r.last ? 'equal' as const
        : block.range.first <= r.first && r.last <= block.range.last ? 'contains-prefix' as const : 'inside-prefix' as const,
    }))
    .sort((a, b) => (a.block.range.first < b.block.range.first ? -1 : a.block.range.first > b.block.range.first ? 1 : a.block.prefix.length - b.block.prefix.length));
}
