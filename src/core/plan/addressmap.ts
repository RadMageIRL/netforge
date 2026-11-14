/**
 * The address map: a view of one prefix as a grid of at most 256 equal cells (8 bits per level),
 * each summarizing the space inside it. Zooming into a cell shows that cell as the next grid, so a
 * /8 of IPv4 or a /32 of IPv6 is explored the same way and the number of cells drawn never depends
 * on the size of the space. Individual addresses appear only when the viewed prefix is that small.
 *
 * Cell status, in precedence order: conflict (two networks that must not overlap do), allocated
 * (fully covered by VLAN networks), partial (partly covered), reserved (only reservations), free.
 */
import { FAMILY_BITS, formatPrefix, makePrefix, prefixSize, prefixToRange, type Family, type IpPrefix, type IpRange } from '../net/address';
import { parseNetworkItem } from '../net/list';
import { mergeRanges } from '../net/ops';
import { routingNeighbors, type Plan } from './model';
import { describeVlan, type PlanValidation } from './validate';

export type MapItemKind = 'network' | 'reserved';

export interface MapItem {
  readonly kind: MapItemKind;
  /** VLAN id for networks and VLAN reservations; block id for block reservations. */
  readonly ownerId: string;
  readonly ownerKind: 'vlan' | 'block';
  readonly label: string;
  readonly range: IpRange;
  readonly prefix: IpPrefix | null;
  readonly vrfId: string;
  readonly siteId: string;
}

export type CellStatus = 'conflict' | 'allocated' | 'partial' | 'reserved' | 'free';

export interface MapCell {
  readonly prefix: IpPrefix;
  readonly status: CellStatus;
  /** Addresses covered by networks or reservations, exact. */
  readonly used: bigint;
  /** used / size, rounded to thousandths, for drawing only. */
  readonly fill: number;
  /** The single network that covers the whole cell, when there is exactly one. */
  readonly owner: MapItem | null;
}

export interface MapView {
  readonly view: IpPrefix;
  readonly cellLength: number;
  readonly columns: number;
  readonly cells: readonly MapCell[];
  /** Items overlapping the view, in address order, at most `itemLimit`. */
  readonly items: readonly MapItem[];
  readonly itemCount: number;
  readonly conflictCount: number;
}

export const MAX_CELL_BITS = 8;

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Networks and reservations of one family in a VRF and the VRFs that exchange routes with it.
 * Conflicts are overlaps between networks in the same VRF or in two VRFs that exchange routes.
 */
export function collectMapItems(plan: Plan, validation: PlanValidation, family: Family, vrfId: string): { items: MapItem[]; conflicts: IpRange[] } {
  const vrfIds = routingNeighbors(plan, vrfId);
  const items: MapItem[] = [];
  const exch = new Set<string>();
  for (const v of plan.vrfs) for (const o of v.exchangesWith) { exch.add(`${v.id}|${o}`); exch.add(`${o}|${v.id}`); }
  for (const v of plan.vlans) {
    if (!vrfIds.has(v.vrfId)) continue;
    const p = validation.parsed.get(v.id);
    if (!p) continue;
    const label = describeVlan(plan, v);
    const prefixes = family === 4 ? (p.ipv4 ? [p.ipv4] : []) : p.ipv6;
    for (const prefix of prefixes) items.push({ kind: 'network', ownerId: v.id, ownerKind: 'vlan', label, range: prefixToRange(prefix), prefix, vrfId: v.vrfId, siteId: v.siteId });
    for (const r of v.reserved) {
      const range = asRange(r.range, family);
      if (range) items.push({ kind: 'reserved', ownerId: v.id, ownerKind: 'vlan', label: `${r.label.trim() || 'Reserved'} (${label})`, range, prefix: null, vrfId: v.vrfId, siteId: v.siteId });
    }
  }
  for (const s of plan.sites) for (const b of s.blocks) {
    if (!vrfIds.has(b.vrfId)) continue;
    for (const r of b.reserved) {
      const range = asRange(r.range, family);
      if (range) items.push({ kind: 'reserved', ownerId: b.id, ownerKind: 'block', label: `${r.label.trim() || 'Reserved'} (parent block of ${s.name.trim() || 'a site'})`, range, prefix: null, vrfId: b.vrfId, siteId: s.id });
    }
  }
  items.sort((a, b) => cmp(a.range.first, b.range.first) || cmp(b.range.last, a.range.last));

  // Conflict ranges: the intersection of every overlapping pair of networks that may not overlap.
  const conflicts: IpRange[] = [];
  let active: MapItem[] = [];
  for (const it of items) {
    if (it.kind !== 'network') continue;
    active = active.filter(a => a.range.last >= it.range.first);
    for (const a of active) {
      if (a.ownerId === it.ownerId) continue;
      if (a.vrfId !== it.vrfId && !exch.has(`${a.vrfId}|${it.vrfId}`)) continue;
      const first = it.range.first;
      const last = a.range.last < it.range.last ? a.range.last : it.range.last;
      conflicts.push({ family, first, last });
    }
    active.push(it);
  }
  return { items, conflicts: conflicts.length ? mergeRanges(conflicts) : [] };
}

function asRange(text: string, family: Family): IpRange | null {
  if (!text.trim()) return null;
  const item = parseNetworkItem(text, true);
  if ('message' in item || item.hostBitsSet || item.family !== family) return null;
  return { family, first: item.first, last: item.last };
}

/** The grid for `view`: at most 2^MAX_CELL_BITS cells. */
export function buildMapView(view: IpPrefix, items: readonly MapItem[], conflicts: readonly IpRange[], itemLimit = 500): MapView {
  const bits = FAMILY_BITS[view.family];
  const cellBits = Math.min(MAX_CELL_BITS, bits - view.length);
  const cellLength = view.length + cellBits;
  const count = 1 << cellBits;
  const columns = 1 << Math.ceil(cellBits / 2);
  const size = prefixSize(view.family, cellLength);
  const vr = prefixToRange(view);

  const inView = items.filter(i => i.range.first <= vr.last && vr.first <= i.range.last);
  const networks = mergeRanges(inView.filter(i => i.kind === 'network').map(i => i.range));
  const everything = mergeRanges(inView.map(i => i.range));
  const nets = inView.filter(i => i.kind === 'network');

  // Cells are in address order, so each merged list is walked once with a moving pointer.
  const cover = (list: readonly IpRange[]) => {
    let k = 0;
    return (first: bigint, last: bigint): bigint => {
      while (k < list.length && list[k].last < first) k++;
      let sum = 0n;
      for (let j = k; j < list.length && list[j].first <= last; j++) {
        const a = list[j].first > first ? list[j].first : first;
        const b = list[j].last < last ? list[j].last : last;
        if (a <= b) sum += b - a + 1n;
      }
      return sum;
    };
  };
  const netCover = cover(networks);
  const allCover = cover(everything);
  const conflictCover = cover(conflicts);
  let n = 0;
  const cells: MapCell[] = [];
  for (let i = 0; i < count; i++) {
    const first = view.network + BigInt(i) * size;
    const last = first + size - 1n;
    const netUsed = netCover(first, last);
    const used = allCover(first, last);
    const conflict = conflictCover(first, last) > 0n;
    const status: CellStatus = conflict ? 'conflict' : netUsed === size ? 'allocated' : netUsed > 0n ? 'partial' : used > 0n ? 'reserved' : 'free';
    let owner: MapItem | null = null;
    if (!conflict && netUsed === size) {
      const covering = nets.filter(x => x.range.first <= first && last <= x.range.last);
      if (covering.length === 1) owner = covering[0];
    }
    if (conflict) n++;
    cells.push({ prefix: { family: view.family, network: first, length: cellLength }, status, used, fill: Number((used * 1000n) / size) / 1000, owner });
  }
  return { view, cellLength, columns, cells, items: inView.slice(0, itemLimit), itemCount: inView.length, conflictCount: n };
}

/** The views from `root` down to `view`, for a breadcrumb: each MAX_CELL_BITS longer than the last. */
export function zoomPath(root: IpPrefix, view: IpPrefix): IpPrefix[] {
  const path: IpPrefix[] = [];
  for (let len = root.length; len < view.length; len += MAX_CELL_BITS) path.push(makePrefix(view.family, view.network, len));
  path.push(view);
  return path;
}

export function describeCell(cell: MapCell): string {
  return `${formatPrefix(cell.prefix)}: ${cell.status}`;
}
