/**
 * Automatic allocation for a plan: one site and one VRF at a time, into one or more parent
 * networks. Allocation is a preview first; applying it is a separate, explicit step that refuses to
 * replace networks someone typed unless the caller confirms it.
 *
 * IPv4 uses the Phase 1 VLSM engine (vlsm.ts) for each parent in turn: requests that do not fit in
 * the first parent are tried in the next, so fragmented space (several separate blocks) is used in
 * order. IPv6 uses the prefix allocator (prefix-alloc.ts): no host arithmetic, a fixed number of
 * equal prefixes per VLAN.
 *
 * Space that is never handed out: every valid network of any VLAN in the same VRF or a VRF that
 * exchanges routes with it (at any site), reservations in those VRFs' parent blocks, and other
 * sites' parent blocks in those VRFs. Invalid networks are never guessed at: their VLANs are skipped.
 */
import { fail, ok, type Result } from '../result';
import { formatInteger } from '../format';
import { formatAddress, formatPrefix, formatRange, parsePrefixText, prefixSize, prefixToRange, type Family, type IpPrefix, type IpRange } from '../net/address';
import { parseNetworkItem } from '../net/list';
import { largestBlock, mergeRanges, subtractRanges, summarizeRanges } from '../net/ops';
import { allocatePrefixes, DEFAULT_MAX_CHILDREN } from '../net/prefix-alloc';
import { allocateVlsm } from '../net/vlsm';
import { clonePlan, routingNeighbors, type Plan, type Vlan } from './model';
import { describeVlan, type PlanValidation } from './validate';

export interface AllocationOptions {
  readonly family: Family;
  readonly siteId: string;
  readonly vrfId: string;
  /** Parent networks, one per entry, tried in order. */
  readonly parents: readonly string[];
  /** Replace networks of VLANs not marked fixed. Off: only VLANs without a network get one. */
  readonly reallocate: boolean;
  // IPv4
  readonly pointToPoint?: boolean;
  /** Give newly allocated VLANs without a gateway the first usable address. */
  readonly setGateway?: boolean;
  // IPv6
  readonly childLength?: number;
  readonly perVlan?: number;
}

export interface FieldMove {
  readonly field: 'ipv4.gateway' | 'ipv4.dhcp' | 'reserved' | 'ipv6.gateway';
  readonly from: string;
  readonly to: string;
}

export interface AllocationChange {
  readonly vlanId: string;
  readonly label: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** 'new': the VLAN had no network of this family; 'changed': an existing network is replaced. */
  readonly kind: 'new' | 'changed' | 'unchanged';
  readonly gateway: string | null;
  /** Gateway, DHCP and reservations carried to the same offset in the new network. */
  readonly moves: readonly FieldMove[];
  /** Entries that no longer fit after the move and were left as they were (validation will flag them). */
  readonly stranded: readonly string[];
}

export interface AllocationNote {
  readonly vlanId: string;
  readonly label: string;
  readonly message: string;
}

export interface AllocationPreview {
  readonly options: AllocationOptions;
  /** Problems with the request itself; nothing is proposed when there are any. */
  readonly errors: readonly string[];
  readonly parents: readonly IpPrefix[];
  readonly changes: readonly AllocationChange[];
  readonly failures: readonly AllocationNote[];
  /** VLANs in scope that were left alone, with the reason. */
  readonly skipped: readonly AllocationNote[];
  /** How many changes replace an existing network. Applying them needs confirmation. */
  readonly overwrites: number;
  readonly free: readonly IpPrefix[];
  /** IPv6: free child prefixes before and after, exact. */
  readonly freeChildrenBefore: bigint | null;
  readonly freeChildrenAfter: bigint | null;
}

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');
export const MAX_PREFIXES_PER_VLAN = 256;

function parseParents(lines: readonly string[], family: Family, errors: string[]): IpPrefix[] {
  const out: IpPrefix[] = [];
  lines.map(l => l.trim()).filter(Boolean).forEach((text, i) => {
    const p = parsePrefixText(text, family);
    if (!p.ok) errors.push(`Parent ${i + 1} (${text}): ${p.error.message}`);
    else if (p.value.hostBitsSet) errors.push(`Parent ${i + 1} (${text}) has host bits set. Did you mean ${formatPrefix(p.value.prefix)}?`);
    else {
      const r = prefixToRange(p.value.prefix);
      const clash = out.find(o => { const q = prefixToRange(o); return q.first <= r.last && r.first <= q.last; });
      if (clash) errors.push(`Parent ${i + 1} (${formatPrefix(p.value.prefix)}) overlaps ${formatPrefix(clash)}.`);
      else out.push(p.value.prefix);
    }
  });
  if (out.length === 0 && errors.length === 0) errors.push(`Enter at least one parent ${family === 4 ? 'IPv4 network' : 'IPv6 prefix'}.`);
  return out;
}

function rangeOf(text: string, family: Family): IpRange | null {
  const item = parseNetworkItem(text, true);
  if ('message' in item || item.family !== family || item.hostBitsSet) return null;
  return { family, first: item.first, last: item.last };
}

/** Space in the routing domain that allocation must not hand out, other than VLAN networks. */
function domainReservations(plan: Plan, family: Family, vrfIds: Set<string>, siteId: string): IpRange[] {
  const out: IpRange[] = [];
  for (const site of plan.sites) {
    for (const b of site.blocks) {
      if (!vrfIds.has(b.vrfId)) continue;
      for (const r of b.reserved) {
        const range = rangeOf(r.range, family);
        if (range) out.push(range);
      }
      if (site.id !== siteId) {
        const p = parsePrefixText(b.network, family);
        if (p.ok && !p.value.hostBitsSet) out.push(prefixToRange(p.value.prefix));
      }
    }
  }
  return out;
}

/** Moves an address, range or CIDR at an offset inside `from` to the same offset inside `to`. */
function shift(text: string, from: IpRange, to: IpRange): string | null {
  const item = parseNetworkItem(text, true);
  if ('message' in item || item.family !== from.family || item.first < from.first || item.last > from.last) return null;
  const first = to.first + (item.first - from.first);
  const last = to.first + (item.last - from.first);
  if (last > to.last) return null;
  if (item.kind === 'address') return formatAddress(to.family, first);
  if (item.kind === 'prefix') return formatRange({ family: to.family, first, last });
  return `${formatAddress(to.family, first)} - ${formatAddress(to.family, last)}`;
}

function inScope(plan: Plan, options: AllocationOptions): Vlan[] {
  return plan.vlans.filter(v => v.siteId === options.siteId && v.vrfId === options.vrfId);
}

export function previewAllocation(plan: Plan, validation: PlanValidation, options: AllocationOptions): AllocationPreview {
  const errors: string[] = [];
  if (!plan.sites.some(s => s.id === options.siteId)) errors.push('Choose a site.');
  if (!plan.vrfs.some(v => v.id === options.vrfId)) errors.push('Choose a VRF.');
  const parents = parseParents(options.parents, options.family, errors);
  const base = { options, parents, changes: [], failures: [], skipped: [], overwrites: 0, free: [], freeChildrenBefore: null, freeChildrenAfter: null };
  if (errors.length) return { ...base, errors };
  return options.family === 4 ? preview4(plan, validation, options, parents) : preview6(plan, validation, options, parents);
}

function preview4(plan: Plan, validation: PlanValidation, options: AllocationOptions, parents: IpPrefix[]): AllocationPreview {
  const errors: string[] = [];
  const vrfIds = routingNeighbors(plan, options.vrfId);
  const skipped: AllocationNote[] = [];
  const requests: { vlan: Vlan; hosts: number; label: string }[] = [];
  const replacing = new Set<string>();
  const labels = new Set<string>();
  const uniqueLabel = (v: Vlan) => {
    const base = `VLAN ${v.vlanId.trim() || '?'}${v.name.trim() ? ` ${v.name.trim()}` : ''}`;
    let label = base;
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `${base} (${n})`;
    labels.add(label.toLowerCase());
    return label;
  };

  for (const v of inScope(plan, options)) {
    const p = validation.parsed.get(v.id);
    const label = describeVlan(plan, v);
    const hasText = v.ipv4.network.trim() !== '';
    if (hasText && !p?.ipv4) {
      skipped.push({ vlanId: v.id, label, message: 'Its IPv4 network is not valid. Fix it first; it was not treated as free or as used.' });
      continue;
    }
    const wantsNew = !hasText || (options.reallocate && !v.ipv4.fixed);
    if (!wantsNew) {
      skipped.push({ vlanId: v.id, label, message: v.ipv4.fixed ? `Keeps ${formatPrefix(p!.ipv4!)} (marked fixed).` : `Keeps ${formatPrefix(p!.ipv4!)}.` });
      continue;
    }
    if (p?.hosts == null) {
      skipped.push({ vlanId: v.id, label, message: v.hosts.trim() ? 'Its host target is not valid.' : hasText ? `Keeps ${formatPrefix(p!.ipv4!)}: it has no host target to size a new network from.` : 'It has no host target, so there is nothing to size a network from.' });
      continue;
    }
    if (hasText) replacing.add(v.id);
    requests.push({ vlan: v, hosts: p.hosts, label: uniqueLabel(v) });
  }

  // Everything already in use in the routing domain, except networks being replaced.
  const occupied: IpRange[] = [...domainReservations(plan, 4, vrfIds, options.siteId)];
  for (const v of plan.vlans) {
    if (!vrfIds.has(v.vrfId) || replacing.has(v.id)) continue;
    const p = validation.parsed.get(v.id)?.ipv4;
    if (p) occupied.push(prefixToRange(p));
  }

  const assigned = new Map<string, IpPrefix>();
  let remaining = requests;
  const lastFailure = new Map<string, { prefixLength: number; hosts: number }>();
  for (const parent of parents) {
    if (remaining.length === 0) break;
    const pr = prefixToRange(parent);
    const reserved = mergeRanges(occupied).map(r => clip(r, pr)).filter((r): r is IpRange => r !== null).map((r, i) => ({ name: `in use ${i + 1}`, range: formatRange(r) }));
    const byLabel = new Map(remaining.map(r => [r.label, r]));
    const result = allocateVlsm({ parent: formatPrefix(parent), requests: remaining.map(r => ({ name: r.label, hosts: r.hosts })), reserved, pointToPoint: options.pointToPoint ?? false });
    if (result.issues.length) {
      errors.push(...result.issues.map(i => i.message));
      break;
    }
    for (const b of result.blocks) {
      if (b.kind !== 'request' || !b.prefix) continue;
      assigned.set(byLabel.get(b.name)!.vlan.id, b.prefix);
      occupied.push(b.range);
    }
    for (const f of result.failures) lastFailure.set(byLabel.get(f.name)!.vlan.id, { prefixLength: f.prefixLength, hosts: f.hosts });
    const failed = new Set(result.failures.map(f => f.name));
    remaining = remaining.filter(r => failed.has(r.label));
  }
  if (errors.length) return { options, errors, parents, changes: [], failures: [], skipped: [], overwrites: 0, free: [], freeChildrenBefore: null, freeChildrenAfter: null };

  const free = freeSpace(parents, occupied);
  const largest = largestBlock(free.map(prefixToRange));
  const failures: AllocationNote[] = remaining.map(r => {
    const f = lastFailure.get(r.vlan.id)!;
    const where = parents.length === 1 ? formatPrefix(parents[0]) : `any of the ${parents.length} parent networks`;
    const detail = parents.every(p => f.prefixLength < p.length)
      ? `which is larger than ${where}.`
      : `but no free aligned block that size is left in ${where}. ${largest ? `The largest free block is a /${largest.length} (${fmt(prefixSize(4, largest.length))} addresses).` : 'No free space is left.'}`;
    return { vlanId: r.vlan.id, label: describeVlan(plan, r.vlan), message: `Needs a /${f.prefixLength} (${fmt(prefixSize(4, f.prefixLength))} addresses for ${fmt(f.hosts)} usable), ${detail}` };
  });

  const changes: AllocationChange[] = [];
  for (const r of requests) {
    const prefix = assigned.get(r.vlan.id);
    if (!prefix) continue;
    const v = r.vlan;
    const old = validation.parsed.get(v.id)?.ipv4 ?? null;
    const after = formatPrefix(prefix);
    const kind = !old ? 'new' : old.network === prefix.network && old.length === prefix.length ? 'unchanged' : 'changed';
    const moves: FieldMove[] = [];
    const stranded: string[] = [];
    let gateway: string | null = null;
    const to = prefixToRange(prefix);
    if (kind === 'changed' && old) {
      const from = prefixToRange(old);
      const move = (field: FieldMove['field'], text: string) => {
        const t = text.trim();
        if (!within(t, from)) return;
        const moved = shift(t, from, to);
        if (moved === null) stranded.push(`${t} (does not fit in ${after})`);
        else if (moved !== t) moves.push({ field, from: t, to: moved });
      };
      move('ipv4.gateway', v.ipv4.gateway);
      v.ipv4.dhcp.forEach(d => move('ipv4.dhcp', d));
      v.reserved.forEach(e => move('reserved', e.range));
      gateway = moves.find(m => m.field === 'ipv4.gateway')?.to ?? null;
    }
    if (kind !== 'unchanged' && (options.setGateway ?? false) && v.ipv4.gateway.trim() === '') {
      gateway = formatAddress(4, prefix.length >= 31 ? to.first : to.first + 1n);
    }
    changes.push({ vlanId: v.id, label: describeVlan(plan, v), before: v.ipv4.network.trim() ? [v.ipv4.network.trim()] : [], after: [after], kind, gateway, moves, stranded });
  }
  return { options, errors: [], parents, changes, failures, skipped, overwrites: changes.filter(c => c.kind === 'changed').length, free, freeChildrenBefore: null, freeChildrenAfter: null };
}

function clip(r: IpRange, to: IpRange): IpRange | null {
  const first = r.first > to.first ? r.first : to.first;
  const last = r.last < to.last ? r.last : to.last;
  return first <= last ? { family: r.family, first, last } : null;
}

function freeSpace(parents: readonly IpPrefix[], used: readonly IpRange[]): IpPrefix[] {
  const merged = mergeRanges(used.filter(u => u.family === parents[0].family));
  return summarizeRanges(parents.flatMap(p => subtractRanges(prefixToRange(p), merged)));
}

/** Whether an address, range or CIDR text lies inside `range`. */
function within(text: string, range: IpRange): boolean {
  const r = text.trim() ? rangeOf(text, range.family) : null;
  return r !== null && r.first >= range.first && r.last <= range.last;
}

function preview6(plan: Plan, validation: PlanValidation, options: AllocationOptions, parents: IpPrefix[]): AllocationPreview {
  const errors: string[] = [];
  const childLength = options.childLength ?? 64;
  const perVlan = options.perVlan ?? 1;
  if (!Number.isInteger(perVlan) || perVlan < 1 || perVlan > MAX_PREFIXES_PER_VLAN) errors.push(`Prefixes per VLAN must be a whole number from 1 to ${MAX_PREFIXES_PER_VLAN}.`);
  const vrfIds = routingNeighbors(plan, options.vrfId);
  const skipped: AllocationNote[] = [];
  const requests: Vlan[] = [];
  const replacing = new Set<string>();
  for (const v of inScope(plan, options)) {
    const p = validation.parsed.get(v.id);
    const label = describeVlan(plan, v);
    const has = v.ipv6.prefixes.some(t => t.trim() !== '');
    if (has && !p?.ipv6Complete) {
      skipped.push({ vlanId: v.id, label, message: 'One of its IPv6 prefixes is not valid. Fix it first; it was not treated as free or as used.' });
      continue;
    }
    if (has && !(options.reallocate && !v.ipv6.fixed)) {
      skipped.push({ vlanId: v.id, label, message: `Keeps ${p!.ipv6.map(formatPrefix).join(', ')}${v.ipv6.fixed ? ' (marked fixed)' : ''}.` });
      continue;
    }
    if (has) replacing.add(v.id);
    requests.push(v);
  }
  const occupied: IpRange[] = [...domainReservations(plan, 6, vrfIds, options.siteId)];
  for (const v of plan.vlans) {
    if (!vrfIds.has(v.vrfId) || replacing.has(v.id)) continue;
    for (const p of validation.parsed.get(v.id)?.ipv6 ?? []) occupied.push(prefixToRange(p));
  }
  if (errors.length) return { options, errors, parents, changes: [], failures: [], skipped: [], overwrites: 0, free: [], freeChildrenBefore: null, freeChildrenAfter: null };

  const result = allocatePrefixes({ parents, childLength, occupied, requests: requests.map(v => ({ key: v.id, count: perVlan })), maxChildren: DEFAULT_MAX_CHILDREN });
  if (result.errors.length) return { options, errors: result.errors.map(e => e.message), parents, changes: [], failures: [], skipped: [], overwrites: 0, free: [], freeChildrenBefore: null, freeChildrenAfter: null };

  const changes: AllocationChange[] = [];
  for (const v of requests) {
    const placed = result.placed.get(v.id);
    if (!placed) continue;
    const old = validation.parsed.get(v.id)?.ipv6 ?? [];
    const after = placed.map(formatPrefix);
    const same = old.length === placed.length && old.every((o, i) => o.network === placed[i].network && o.length === placed[i].length);
    const kind = old.length === 0 ? 'new' : same ? 'unchanged' : 'changed';
    const moves: FieldMove[] = [];
    const stranded: string[] = [];
    let gateway: string | null = null;
    if (kind === 'changed') {
      // A gateway in old prefix i moves to the same offset in new prefix i.
      const gwText = v.ipv6.gateway.trim();
      const i = old.findIndex(o => within(gwText, prefixToRange(o)));
      if (gwText && i >= 0) {
        const moved = placed[i] ? shift(gwText, prefixToRange(old[i]), prefixToRange(placed[i])) : null;
        if (moved) {
          gateway = moved;
          moves.push({ field: 'ipv6.gateway', from: gwText, to: moved });
        } else stranded.push(`${gwText} (no matching new prefix)`);
      }
      for (const e of v.reserved) {
        const k = old.findIndex(o => within(e.range, prefixToRange(o)));
        if (k < 0) continue;
        const moved = placed[k] ? shift(e.range, prefixToRange(old[k]), prefixToRange(placed[k])) : null;
        if (moved) moves.push({ field: 'reserved', from: e.range.trim(), to: moved });
        else stranded.push(`${e.range.trim()} (does not fit)`);
      }
    }
    changes.push({ vlanId: v.id, label: describeVlan(plan, v), before: v.ipv6.prefixes.map(t => t.trim()).filter(Boolean), after, kind, gateway, moves, stranded });
  }
  const failures: AllocationNote[] = result.failures.map(f => {
    const v = plan.vlans.find(x => x.id === f.key)!;
    return { vlanId: v.id, label: describeVlan(plan, v), message: f.message.charAt(0).toUpperCase() + f.message.slice(1) };
  });
  return {
    options, errors: [], parents, changes, failures, skipped,
    overwrites: changes.filter(c => c.kind === 'changed').length,
    free: result.free, freeChildrenBefore: result.freeBefore, freeChildrenAfter: result.freeAfter,
  };
}

export type ApplyErrorCode = 'confirmation-required' | 'stale-preview' | 'nothing-to-apply';

/**
 * Writes a preview's changes into a copy of the plan. Replacing an existing network requires
 * `confirmOverwrite`; a preview made from an older version of the plan is refused.
 */
export function applyAllocation(plan: Plan, preview: AllocationPreview, confirmOverwrite: boolean): Result<Plan, ApplyErrorCode> {
  const changes = preview.changes.filter(c => c.kind !== 'unchanged');
  if (preview.errors.length || changes.length === 0) return fail('nothing-to-apply', 'There is nothing to apply.');
  if (preview.overwrites > 0 && !confirmOverwrite) {
    return fail('confirmation-required', `${preview.overwrites} ${preview.overwrites === 1 ? 'VLAN already has a network' : 'VLANs already have networks'} that this would replace. Confirm the replacement to apply it.`);
  }
  const next = clonePlan(plan);
  const family = preview.options.family;
  for (const c of changes) {
    const v = next.vlans.find(x => x.id === c.vlanId);
    const current = v ? (family === 4 ? (v.ipv4.network.trim() ? [v.ipv4.network.trim()] : []) : v.ipv6.prefixes.map(t => t.trim()).filter(Boolean)) : null;
    if (!v || !current || current.join('\n') !== c.before.join('\n')) return fail('stale-preview', 'The plan changed after this preview was made. Preview the allocation again.');
    const moveMap = new Map(c.moves.map(m => [`${m.field}|${m.from}`, m.to]));
    const moved = (field: FieldMove['field'], text: string) => moveMap.get(`${field}|${text.trim()}`) ?? text;
    if (family === 4) {
      v.ipv4.network = c.after[0];
      if (c.gateway !== null) v.ipv4.gateway = c.gateway;
      v.ipv4.dhcp = v.ipv4.dhcp.map(d => moved('ipv4.dhcp', d));
    } else {
      v.ipv6.prefixes = [...c.after];
      if (c.gateway !== null) v.ipv6.gateway = c.gateway;
    }
    v.reserved = v.reserved.map(e => ({ ...e, range: moved('reserved', e.range) }));
  }
  return ok(next);
}
