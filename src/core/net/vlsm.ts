/**
 * Deterministic IPv4 VLSM allocation.
 *
 * Strategy (documented, and what the tests pin down):
 * 1. Validate everything: the parent, every request, fixed allocation and reservation. Any
 *    problem stops allocation, so a result never mixes valid and invalid input.
 * 2. Fixed allocations and reservations are placed first, exactly where given.
 * 3. Each request gets the smallest prefix whose host capacity covers it. Normally a subnet loses
 *    its network and broadcast addresses; with the point-to-point option, 2-host requests get a
 *    /31 (RFC 3021) and 1-host requests a /32.
 * 4. Requests are placed largest block first; equal blocks go in order of requested hosts
 *    (more first), then in the order entered.
 * 5. Each block goes at the lowest address in the parent that is aligned to its size and free.
 * 6. A request that cannot be placed fails with the reason; the others are still placed.
 *
 * IPv6 is not handled here: host counts do not size IPv6 subnets. IPv6 planning splits a prefix
 * into equal prefixes (splitPrefix) instead.
 */
import { formatInteger } from '../format';
import { formatPrefix, formatRange, parsePrefixText, prefixSize, prefixToRange, rangeSize, type IpPrefix, type IpRange } from './address';
import { parseNetworkItem } from './list';
import { alignUp, largestBlock, mergeRanges, rangesOverlap, subtractRanges, summarizeRanges } from './ops';

export interface VlsmRequest {
  readonly name: string;
  /** Required usable hosts, as a number or as the text typed. */
  readonly hosts: number | string;
}

export interface VlsmFixed {
  readonly name: string;
  readonly network: string;
}

export interface VlsmReserved {
  readonly name: string;
  readonly range: string;
}

export interface VlsmInput {
  readonly parent: string;
  readonly requests: readonly VlsmRequest[];
  readonly fixed?: readonly VlsmFixed[];
  readonly reserved?: readonly VlsmReserved[];
  /** Use /31 for 2-host and /32 for 1-host requests. */
  readonly pointToPoint?: boolean;
}

export type VlsmSection = 'parent' | 'requests' | 'fixed' | 'reserved';

export type VlsmIssueCode =
  | 'parent-invalid'
  | 'parent-ipv6'
  | 'name-empty'
  | 'name-duplicate'
  | 'hosts-invalid'
  | 'hosts-too-many'
  | 'network-invalid'
  | 'network-ipv6'
  | 'host-bits'
  | 'outside-parent'
  | 'conflict';

export interface VlsmIssue {
  readonly section: VlsmSection;
  /** Row index within its section (0-based); -1 for the parent. */
  readonly index: number;
  readonly code: VlsmIssueCode;
  /** Location and problem: "Request 2 (Voice): enter a whole number...". */
  readonly message: string;
  /** The problem alone, without its location. */
  readonly detail: string;
}

export type VlsmBlockKind = 'request' | 'fixed' | 'reserved';

export interface VlsmBlock {
  readonly kind: VlsmBlockKind;
  readonly name: string;
  /** Row index within its section. */
  readonly index: number;
  readonly range: IpRange;
  /** Null for a reservation that is not one CIDR block. */
  readonly prefix: IpPrefix | null;
  readonly requestedHosts: number | null;
  /** Usable hosts in the block; null for reservations. */
  readonly hostCapacity: bigint | null;
  readonly firstUsable: bigint | null;
  readonly lastUsable: bigint | null;
}

export interface VlsmFailure {
  readonly index: number;
  readonly name: string;
  readonly hosts: number;
  readonly prefixLength: number;
  readonly code: 'larger-than-parent' | 'no-space';
  readonly message: string;
}

export interface VlsmSummary {
  readonly parentAddresses: bigint;
  readonly allocatedAddresses: bigint;
  readonly fixedAddresses: bigint;
  readonly reservedAddresses: bigint;
  readonly freeAddresses: bigint;
  readonly requestedHosts: number;
  readonly hostCapacity: bigint;
}

export interface VlsmResult {
  readonly issues: readonly VlsmIssue[];
  readonly notes: readonly string[];
  readonly parent: IpPrefix | null;
  /** Requests, fixed allocations and reservations, in address order. */
  readonly blocks: readonly VlsmBlock[];
  /** Requests that could not be placed, in the order they were attempted. */
  readonly failures: readonly VlsmFailure[];
  /** Request indexes in allocation order. */
  readonly order: readonly number[];
  /** Unallocated space as the fewest CIDR blocks. */
  readonly free: readonly IpPrefix[];
  readonly summary: VlsmSummary | null;
}

export const MAX_HOSTS = 2 ** 32 - 2;

/** Usable hosts in an IPv4 block: /32 has 1, /31 has 2 (RFC 3021), others lose network and broadcast. */
export function hostCapacity(length: number): bigint {
  if (length === 32) return 1n;
  if (length === 31) return 2n;
  return prefixSize(4, length) - 2n;
}

/** The longest prefix whose capacity covers `hosts`. */
export function prefixForHosts(hosts: number, pointToPoint = false): number {
  if (!Number.isInteger(hosts) || hosts < 1 || hosts > MAX_HOSTS) throw new RangeError(`Cannot size a subnet for ${hosts} hosts`);
  if (pointToPoint && hosts === 1) return 32;
  if (pointToPoint && hosts === 2) return 31;
  let length = 30;
  while (hostCapacity(length) < BigInt(hosts)) length--;
  return length;
}

function usableRange(prefix: IpPrefix): [bigint, bigint] {
  const r = prefixToRange(prefix);
  if (prefix.length >= 31) return [r.first, r.last];
  return [r.first + 1n, r.last - 1n];
}

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');

function parseHosts(value: number | string): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const t = value.trim();
  return /^[0-9]+$/.test(t) ? Number(t) : null;
}

export function allocateVlsm(input: VlsmInput): VlsmResult {
  const issues: VlsmIssue[] = [];
  const add = (section: VlsmSection, index: number, code: VlsmIssueCode, where: string, detail: string) => {
    issues.push({ section, index, code, detail, message: `${where}: ${detail}` });
  };
  const notes: string[] = [];
  const pointToPoint = input.pointToPoint ?? false;
  const fixedInput = input.fixed ?? [];
  const reservedInput = input.reserved ?? [];
  const empty = (parent: IpPrefix | null): VlsmResult => ({ issues, notes, parent, blocks: [], failures: [], order: [], free: [], summary: null });
  const who = (label: string, index: number, name: string) => `${label} ${index + 1}${name ? ` (${name})` : ''}`;

  // Parent
  const parentText = input.parent.trim();
  let parent: IpPrefix | null = null;
  if (parentText.includes(':')) {
    add('parent', -1, 'parent-ipv6', 'Parent network', 'VLSM sizes subnets by host count, which applies to IPv4 only. For IPv6, split the prefix into equal subnets in the Subnet Calculator.');
  } else {
    const p = parsePrefixText(parentText, 4);
    if (!p.ok) add('parent', -1, 'parent-invalid', 'Parent network', p.error.message);
    else {
      parent = p.value.prefix;
      if (p.value.hostBitsSet) notes.push(`${parentText} has host bits set, so the parent network is ${formatPrefix(parent)}.`);
    }
  }
  const parentRange = parent ? prefixToRange(parent) : null;

  // Names: requests and fixed allocations must be unique (ignoring case and surrounding space).
  const seen = new Map<string, string>();
  const checkName = (section: VlsmSection, index: number, raw: string, label: string): string => {
    const name = raw.trim();
    if (name === '') {
      add(section, index, 'name-empty', `${label} ${index + 1}`, 'enter a name.');
      return name;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) add(section, index, 'name-duplicate', `${label} ${index + 1}`, `the name "${name}" is already used by ${seen.get(key)}.`);
    else seen.set(key, `${label.toLowerCase()} ${index + 1}`);
    return name;
  };

  // Requests
  const requests = input.requests.map((r, index) => {
    const name = checkName('requests', index, r.name, 'Request');
    const hosts = parseHosts(r.hosts);
    if (hosts === null || hosts < 1) {
      add('requests', index, 'hosts-invalid', who('Request', index, name), 'enter a whole number of hosts of at least 1, such as 400.');
      return null;
    }
    if (hosts > MAX_HOSTS) {
      add('requests', index, 'hosts-too-many', who('Request', index, name), `${fmt(hosts)} hosts is more than any IPv4 subnet can hold (${fmt(MAX_HOSTS)}).`);
      return null;
    }
    return { index, name, hosts, length: prefixForHosts(hosts, pointToPoint) };
  });

  // Reservations
  const reservations: { index: number; name: string; range: IpRange }[] = [];
  reservedInput.forEach((r, index) => {
    const name = r.name.trim() || `Reserved ${index + 1}`;
    const item = parseNetworkItem(r.range, true);
    const where = who('Reservation', index, r.name.trim());
    if ('message' in item) {
      add('reserved', index, 'network-invalid', where, item.message);
      return;
    }
    if (item.family !== 4) {
      add('reserved', index, 'network-ipv6', where, 'only IPv4 ranges can be reserved in an IPv4 plan.');
      return;
    }
    if (item.hostBitsSet && item.prefix) {
      add('reserved', index, 'host-bits', where, `${r.range.trim()} has host bits set. Did you mean ${formatPrefix(item.prefix)}?`);
      return;
    }
    const range: IpRange = { family: 4, first: item.first, last: item.last };
    if (parentRange && (range.first < parentRange.first || range.last > parentRange.last)) {
      add('reserved', index, 'outside-parent', where, `${formatRange(range)} is not inside the parent ${formatPrefix(parent!)}.`);
      return;
    }
    reservations.push({ index, name, range });
  });

  // Fixed allocations
  const fixed: { index: number; name: string; prefix: IpPrefix; range: IpRange }[] = [];
  fixedInput.forEach((f, index) => {
    const name = checkName('fixed', index, f.name, 'Fixed allocation');
    const text = f.network.trim();
    const where = who('Fixed allocation', index, name);
    if (text.includes(':')) {
      add('fixed', index, 'network-ipv6', where, 'only IPv4 networks can be fixed in an IPv4 plan.');
      return;
    }
    const p = parsePrefixText(text, 4);
    if (!p.ok) {
      add('fixed', index, 'network-invalid', where, p.error.message);
      return;
    }
    if (p.value.hostBitsSet) {
      add('fixed', index, 'host-bits', where, `${text} has host bits set. Did you mean ${formatPrefix(p.value.prefix)}?`);
      return;
    }
    const range = prefixToRange(p.value.prefix);
    if (parentRange && (range.first < parentRange.first || range.last > parentRange.last)) {
      add('fixed', index, 'outside-parent', where, `${formatPrefix(p.value.prefix)} is not inside the parent ${formatPrefix(parent!)}.`);
      return;
    }
    const clashFixed = fixed.find(o => rangesOverlap(o.range, range));
    if (clashFixed) {
      add('fixed', index, 'conflict', where, `${formatPrefix(p.value.prefix)} overlaps fixed allocation "${clashFixed.name}" (${formatPrefix(clashFixed.prefix)}).`);
      return;
    }
    const clashReserved = reservations.find(o => rangesOverlap(o.range, range));
    if (clashReserved) {
      add('fixed', index, 'conflict', where, `${formatPrefix(p.value.prefix)} overlaps reservation "${clashReserved.name}" (${formatRange(clashReserved.range)}).`);
      return;
    }
    fixed.push({ index, name, prefix: p.value.prefix, range });
  });

  if (issues.length > 0 || !parent || !parentRange) return empty(parent);

  const blocks: VlsmBlock[] = [];
  for (const r of reservations) {
    blocks.push({ kind: 'reserved', name: r.name, index: r.index, range: r.range, prefix: null, requestedHosts: null, hostCapacity: null, firstUsable: null, lastUsable: null });
  }
  for (const f of fixed) {
    const [firstUsable, lastUsable] = usableRange(f.prefix);
    blocks.push({ kind: 'fixed', name: f.name, index: f.index, range: f.range, prefix: f.prefix, requestedHosts: null, hostCapacity: hostCapacity(f.prefix.length), firstUsable, lastUsable });
  }
  // Occupied space, kept sorted by first address.
  const occupied: IpRange[] = mergeRanges(blocks.map(b => b.range));

  const valid = requests.filter((r): r is NonNullable<typeof r> => r !== null);
  const order = [...valid].sort((a, b) => a.length - b.length || b.hosts - a.hosts || a.index - b.index);
  const failures: VlsmFailure[] = [];
  for (const req of order) {
    const size = prefixSize(4, req.length);
    if (req.length < parent.length) {
      failures.push({
        index: req.index, name: req.name, hosts: req.hosts, prefixLength: req.length, code: 'larger-than-parent',
        message: `${req.name} needs a /${req.length} (${fmt(size)} addresses for ${fmt(req.hosts)} hosts), which is larger than the parent ${formatPrefix(parent)}.`,
      });
      continue;
    }
    // `occupied` is sorted and disjoint, so one forward scan finds every clash in order.
    let candidate = parentRange.first;
    let placed: IpRange | null = null;
    let k = 0;
    while (candidate + size - 1n <= parentRange.last) {
      const end = candidate + size - 1n;
      while (k < occupied.length && occupied[k].last < candidate) k++;
      const clash = k < occupied.length && occupied[k].first <= end ? occupied[k] : null;
      if (!clash) {
        placed = { family: 4, first: candidate, last: end };
        break;
      }
      candidate = alignUp(clash.last + 1n, size);
    }
    if (!placed) {
      const freeNow = subtractRanges(parentRange, occupied);
      const largest = largestBlock(freeNow);
      const freeTotal = freeNow.reduce((s, r) => s + rangeSize(r), 0n);
      const detail = largest
        ? `The largest free aligned block is a /${largest.length} (${fmt(prefixSize(4, largest.length))} addresses), and ${fmt(freeTotal)} addresses are free in total.`
        : 'No free space is left in the parent.';
      failures.push({
        index: req.index, name: req.name, hosts: req.hosts, prefixLength: req.length, code: 'no-space',
        message: `${req.name} needs a /${req.length} (${fmt(size)} addresses for ${fmt(req.hosts)} hosts) but does not fit. ${detail}`,
      });
      continue;
    }
    const prefix: IpPrefix = { family: 4, network: placed.first, length: req.length };
    const [firstUsable, lastUsable] = usableRange(prefix);
    blocks.push({ kind: 'request', name: req.name, index: req.index, range: placed, prefix, requestedHosts: req.hosts, hostCapacity: hostCapacity(req.length), firstUsable, lastUsable });
    const at = occupied.findIndex(o => o.first > placed!.first);
    occupied.splice(at < 0 ? occupied.length : at, 0, placed);
  }

  blocks.sort((a, b) => (a.range.first < b.range.first ? -1 : a.range.first > b.range.first ? 1 : 0));
  const allocated = blocks.filter(b => b.kind === 'request');
  const freeRanges = subtractRanges(parentRange, blocks.map(b => b.range));
  const sum = (list: readonly VlsmBlock[]) => list.reduce((s, b) => s + rangeSize(b.range), 0n);
  const summary: VlsmSummary = {
    parentAddresses: prefixSize(4, parent.length),
    allocatedAddresses: sum(allocated),
    fixedAddresses: sum(blocks.filter(b => b.kind === 'fixed')),
    reservedAddresses: mergeRanges(blocks.filter(b => b.kind === 'reserved').map(b => b.range)).reduce((s, r) => s + rangeSize(r), 0n),
    freeAddresses: freeRanges.reduce((s, r) => s + rangeSize(r), 0n),
    requestedHosts: allocated.reduce((s, b) => s + (b.requestedHosts ?? 0), 0),
    hostCapacity: allocated.reduce((s, b) => s + (b.hostCapacity ?? 0n), 0n),
  };
  return { issues, notes, parent, blocks, failures, order: order.map(r => r.index), free: summarizeRanges(freeRanges), summary };
}
