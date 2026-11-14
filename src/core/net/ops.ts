/**
 * Network set operations. Every operation that combines networks requires one address family
 * (FamilyMismatchError otherwise); helpers that accept mixed input group by family explicitly.
 */
import { FAMILY_BITS, hostMask, makePrefix, prefixSize, rangeSize, requireSameFamily, type Family, type IpPrefix, type IpRange } from './address';

/** IPv4 before IPv6, then by first address, then larger ranges first (a container before its contents). */
export function compareRanges(a: IpRange, b: IpRange): number {
  if (a.family !== b.family) return a.family - b.family;
  if (a.first !== b.first) return a.first < b.first ? -1 : 1;
  if (a.last !== b.last) return a.last > b.last ? -1 : 1;
  return 0;
}

export function sortRanges<T extends IpRange>(ranges: readonly T[]): T[] {
  return [...ranges].sort(compareRanges);
}

export function containsRange(outer: IpRange, inner: IpRange): boolean {
  requireSameFamily('Containment', [outer, inner]);
  return outer.first <= inner.first && inner.last <= outer.last;
}

export function containsAddress(range: IpRange, family: Family, value: bigint): boolean {
  requireSameFamily('Containment', [range, { family }]);
  return range.first <= value && value <= range.last;
}

export function rangesOverlap(a: IpRange, b: IpRange): boolean {
  requireSameFamily('Overlap detection', [a, b]);
  return a.first <= b.last && b.first <= a.last;
}

export function intersectRanges(a: IpRange, b: IpRange): IpRange | null {
  requireSameFamily('Intersection', [a, b]);
  const first = a.first > b.first ? a.first : b.first;
  const last = a.last < b.last ? a.last : b.last;
  return first <= last ? { family: a.family, first, last } : null;
}

/** The union as disjoint ranges in order; overlapping and adjacent ranges are joined. */
export function mergeRanges(ranges: readonly IpRange[]): IpRange[] {
  if (ranges.length === 0) return [];
  const family = requireSameFamily('Merging', ranges);
  const sorted = sortRanges(ranges);
  const out: { first: bigint; last: bigint }[] = [];
  for (const r of sorted) {
    const top = out[out.length - 1];
    if (top && r.first <= top.last + 1n) {
      if (r.last > top.last) top.last = r.last;
    } else out.push({ first: r.first, last: r.last });
  }
  return out.map(r => ({ family, first: r.first, last: r.last }));
}

/** Trailing zero bits of a non-negative bigint, capped at `bits` (0 has `bits`). */
function trailingZeros(value: bigint, bits: number): number {
  if (value === 0n) return bits;
  let n = 0;
  while (((value >> BigInt(n)) & 1n) === 0n) n++;
  return n;
}

/**
 * The fewest CIDR blocks that cover exactly the range: at each step the largest aligned block
 * that starts at the next uncovered address and does not pass the end.
 */
export function rangeToPrefixes(range: IpRange): IpPrefix[] {
  if (range.first > range.last) throw new RangeError('A range must not end before it starts.');
  const bits = FAMILY_BITS[range.family];
  const out: IpPrefix[] = [];
  let first = range.first;
  for (;;) {
    let size = trailingZeros(first, bits);
    while (size > 0 && first + (1n << BigInt(size)) - 1n > range.last) size--;
    out.push({ family: range.family, network: first, length: bits - size });
    const next = first + (1n << BigInt(size));
    if (next > range.last) return out;
    first = next;
  }
}

/** The smallest exact CIDR list for the union of the ranges (no added coverage). */
export function summarizeRanges(ranges: readonly IpRange[]): IpPrefix[] {
  return mergeRanges(ranges).flatMap(rangeToPrefixes);
}

export interface SplitResult {
  /** Number of subnets the prefix splits into. */
  readonly total: bigint;
  /** The requested page of subnets, in address order. */
  readonly subnets: IpPrefix[];
}

/** Splits a prefix into equal subnets of `newLength`, returning `limit` of them from `offset`. */
export function splitPrefix(prefix: IpPrefix, newLength: number, offset = 0n, limit = 256): SplitResult {
  const bits = FAMILY_BITS[prefix.family];
  if (!Number.isInteger(newLength) || newLength <= prefix.length || newLength > bits) {
    throw new RangeError(`A /${prefix.length} can be split only into prefixes from /${prefix.length + 1} to /${bits}.`);
  }
  const total = 1n << BigInt(newLength - prefix.length);
  const size = prefixSize(prefix.family, newLength);
  const subnets: IpPrefix[] = [];
  for (let i = offset; i < total && subnets.length < limit; i++) {
    subnets.push({ family: prefix.family, network: prefix.network + i * size, length: newLength });
  }
  return { total, subnets };
}

/** The prefix of `newLength` (shorter) that contains `prefix`. */
export function supernet(prefix: IpPrefix, newLength: number): IpPrefix {
  if (!Number.isInteger(newLength) || newLength < 0 || newLength >= prefix.length) {
    throw new RangeError(`A supernet of a /${prefix.length} has a prefix length from /0 to /${prefix.length - 1}.`);
  }
  return makePrefix(prefix.family, prefix.network, newLength);
}

/** The smallest single prefix that contains every range (usually covers extra addresses). */
export function coveringPrefix(ranges: readonly IpRange[]): IpPrefix {
  const family = requireSameFamily('A covering prefix', ranges);
  let first = ranges[0].first;
  let last = ranges[0].last;
  for (const r of ranges) {
    if (r.first < first) first = r.first;
    if (r.last > last) last = r.last;
  }
  const bits = FAMILY_BITS[family];
  const differing = first === last ? 0 : (first ^ last).toString(2).length;
  return makePrefix(family, first, bits - differing);
}

/** The parts of `base` not covered by any of `remove`, in order. */
export function subtractRanges(base: IpRange, remove: readonly IpRange[]): IpRange[] {
  requireSameFamily('Subtraction', [base, ...remove]);
  const out: IpRange[] = [];
  let cursor = base.first;
  for (const r of mergeRanges(remove)) {
    if (r.last < cursor || r.first > base.last) continue;
    if (r.first > cursor) out.push({ family: base.family, first: cursor, last: r.first - 1n });
    if (r.last >= base.last) return out;
    cursor = r.last + 1n;
  }
  if (cursor <= base.last) out.push({ family: base.family, first: cursor, last: base.last });
  return out;
}

export function totalAddresses(ranges: readonly IpRange[]): bigint {
  return mergeRanges(ranges).reduce((sum, r) => sum + rangeSize(r), 0n);
}

/** The largest aligned CIDR block inside any of the ranges, or null for none. */
export function largestBlock(ranges: readonly IpRange[]): IpPrefix | null {
  let best: IpPrefix | null = null;
  for (const r of ranges) {
    for (const p of rangeToPrefixes(r)) if (!best || p.length < best.length) best = p;
  }
  return best;
}

/** Rounds `value` up to the next multiple of `size` (a power of two). */
export function alignUp(value: bigint, size: bigint): bigint {
  return (value + size - 1n) & ~(size - 1n);
}

/** Whether `value` is aligned to a /length boundary. */
export function isAligned(family: Family, value: bigint, length: number): boolean {
  return (value & hostMask(family, length)) === 0n;
}

