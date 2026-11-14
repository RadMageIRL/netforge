/**
 * Prefix-oriented allocation, for IPv6: equal-sized child prefixes (a /64 per VLAN by default)
 * placed in one or more parent prefixes. No host counts are involved; the unit is the prefix.
 *
 * Strategy (documented, and what the tests pin down):
 * 1. Occupied space (fixed prefixes, reservations, anything already assigned) is never touched.
 * 2. Requests are served in the order given. Each needs `count` children and gets all of them or
 *    none (it fails with the number still free), so a VLAN never ends up half-allocated.
 * 3. Children are taken lowest address first: the first parent, then the next. Within a parent,
 *    each child is the lowest aligned free child prefix.
 * 4. Counts are exact bigint. A run that would place more than `maxChildren` prefixes is refused
 *    as a whole, before anything is placed: results are never cut short silently.
 */
import { formatInteger } from '../format';
import { FAMILY_BITS, formatPrefix, prefixSize, prefixToRange, type IpPrefix, type IpRange } from './address';
import { alignUp, mergeRanges, subtractRanges, summarizeRanges } from './ops';

export interface PrefixRequest {
  readonly key: string;
  readonly count: number;
}

export interface PrefixAllocInput {
  readonly parents: readonly IpPrefix[];
  readonly childLength: number;
  /** Space already in use: fixed prefixes, reservations, other assignments. May overlap each other or reach outside the parents. */
  readonly occupied: readonly IpRange[];
  readonly requests: readonly PrefixRequest[];
  readonly maxChildren?: number;
}

export type PrefixAllocErrorCode = 'no-parent' | 'mixed-family' | 'parents-overlap' | 'child-length' | 'count-invalid' | 'too-many';

export interface PrefixAllocFailure {
  readonly key: string;
  readonly count: number;
  /** Children still free when the request was attempted. */
  readonly available: bigint;
  readonly message: string;
}

export interface PrefixAllocResult {
  readonly errors: readonly { code: PrefixAllocErrorCode; message: string }[];
  /** Placed children per request key, lowest first. */
  readonly placed: ReadonlyMap<string, readonly IpPrefix[]>;
  readonly failures: readonly PrefixAllocFailure[];
  /** Free aligned children before and after this run, exact. */
  readonly freeBefore: bigint;
  readonly freeAfter: bigint;
  /** Unused space in the parents after this run, as the fewest CIDR blocks. */
  readonly free: readonly IpPrefix[];
}

export const DEFAULT_MAX_CHILDREN = 65_536;

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');

/** Aligned children of `size` that fit entirely inside [first, last]. Exact for any size. */
export function alignedCount(range: IpRange, size: bigint): bigint {
  const start = alignUp(range.first, size);
  if (start > range.last) return 0n;
  return (range.last - start + 1n) / size;
}

export function allocatePrefixes(input: PrefixAllocInput): PrefixAllocResult {
  const errors: { code: PrefixAllocErrorCode; message: string }[] = [];
  const placed = new Map<string, IpPrefix[]>();
  const empty = (): PrefixAllocResult => ({ errors, placed, failures: [], freeBefore: 0n, freeAfter: 0n, free: [] });
  const maxChildren = input.maxChildren ?? DEFAULT_MAX_CHILDREN;

  if (input.parents.length === 0) {
    errors.push({ code: 'no-parent', message: 'Enter at least one parent prefix.' });
    return empty();
  }
  const family = input.parents[0].family;
  if (input.parents.some(p => p.family !== family)) {
    errors.push({ code: 'mixed-family', message: 'All parent prefixes must be the same family.' });
    return empty();
  }
  const bits = FAMILY_BITS[family];
  const child = input.childLength;
  if (!Number.isInteger(child) || child < 1 || child > bits) {
    errors.push({ code: 'child-length', message: `The child prefix length must be a whole number from 1 to ${bits}.` });
    return empty();
  }
  for (const p of input.parents) {
    if (child <= p.length) errors.push({ code: 'child-length', message: `${formatPrefix(p)} cannot hold /${child} prefixes: the child prefix must be longer than the parent's /${p.length}.` });
  }
  const parentRanges = input.parents.map(prefixToRange);
  for (let i = 0; i < parentRanges.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = parentRanges[i];
      const b = parentRanges[j];
      if (a.first <= b.last && b.first <= a.last) errors.push({ code: 'parents-overlap', message: `Parent ${formatPrefix(input.parents[i])} overlaps parent ${formatPrefix(input.parents[j])}.` });
    }
  }
  let requested = 0;
  for (const r of input.requests) {
    if (!Number.isInteger(r.count) || r.count < 1) errors.push({ code: 'count-invalid', message: `Request ${r.key} asks for ${r.count} prefixes; each request needs a whole number of at least 1.` });
    else requested += r.count;
  }
  if (requested > maxChildren) {
    errors.push({ code: 'too-many', message: `This run would place ${fmt(requested)} prefixes, more than the limit of ${fmt(maxChildren)} per run. Allocate fewer VLANs at a time or fewer prefixes per VLAN; nothing was allocated.` });
  }
  if (errors.length > 0) return empty();

  const size = prefixSize(family, child);
  const occupied = mergeRanges(input.occupied.filter(r => r.family === family));
  // Free space per parent, in order; a cursor walks it from the lowest address.
  const freeRanges: IpRange[] = parentRanges.flatMap(p => subtractRanges(p, occupied));
  let available = freeRanges.reduce((s, r) => s + alignedCount(r, size), 0n);
  const freeBefore = available;
  let rangeIndex = 0;
  let next = freeRanges.length ? alignUp(freeRanges[0].first, size) : 0n;
  const take = (): IpPrefix => {
    for (;;) {
      const r = freeRanges[rangeIndex];
      if (next + size - 1n <= r.last) {
        const p: IpPrefix = { family, network: next, length: child };
        next += size;
        return p;
      }
      rangeIndex++;
      next = alignUp(freeRanges[rangeIndex].first, size);
    }
  };

  const failures: PrefixAllocFailure[] = [];
  const used: IpRange[] = [];
  for (const r of input.requests) {
    const need = BigInt(r.count);
    if (need > available) {
      failures.push({
        key: r.key, count: r.count, available,
        message: available === 0n
          ? `needs ${fmt(r.count)} /${child} ${r.count === 1 ? 'prefix' : 'prefixes'}, but the parent space is exhausted: no /${child} is free.`
          : `needs ${fmt(r.count)} /${child} prefixes, but only ${fmt(available)} ${available === 1n ? 'is' : 'are'} free. Nothing was assigned to it.`,
      });
      continue;
    }
    const list: IpPrefix[] = [];
    for (let i = 0; i < r.count; i++) {
      const p = take();
      list.push(p);
      used.push(prefixToRange(p));
    }
    available -= need;
    placed.set(r.key, [...(placed.get(r.key) ?? []), ...list]);
  }

  const allUsed = mergeRanges([...occupied, ...used]);
  const free = summarizeRanges(parentRanges.flatMap(p => subtractRanges(p, allUsed)));
  return { errors, placed, failures, freeBefore, freeAfter: available, free };
}
