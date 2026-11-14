/**
 * Analysis of network lists: duplicates, containment, overlaps and gaps (IP Range Analyzer), and
 * exact route summarization (Route Summarization). IPv4 and IPv6 are always analyzed separately.
 */
import { formatPrefix, parsePrefixText, prefixSize, prefixToRange, rangeSize, type Family, type IpPrefix, type IpRange } from './address';
import type { ListEntry } from './list';
import { compareRanges, coveringPrefix, mergeRanges, subtractRanges, summarizeRanges } from './ops';

export type FindingKind = 'duplicate' | 'contains' | 'overlap';

export interface Finding {
  readonly kind: FindingKind;
  /** For 'contains', `a` is the larger network. */
  readonly a: ListEntry;
  readonly b: ListEntry;
  /** The shared addresses. */
  readonly shared: IpRange;
}

export interface FamilyReport {
  readonly family: Family;
  /** Entries in normalized order: by first address, larger ranges first. */
  readonly entries: readonly ListEntry[];
  /** The union as disjoint ranges. */
  readonly merged: readonly IpRange[];
  /** The union as the fewest exact CIDR blocks. */
  readonly summary: readonly IpPrefix[];
  readonly totalAddresses: bigint;
}

export interface ParentReport {
  readonly prefix: IpPrefix;
  readonly coveredAddresses: bigint;
  /** Space inside the parent that no entry covers, as the fewest CIDR blocks. */
  readonly gaps: readonly IpPrefix[];
  readonly gapAddresses: bigint;
  /** Entries not entirely inside the parent (including the other family). */
  readonly outside: readonly ListEntry[];
}

export interface RangeReport {
  readonly families: readonly FamilyReport[];
  readonly findings: readonly Finding[];
  /** Findings beyond the limit, counted but not listed. */
  readonly omittedFindings: number;
  readonly parent: ParentReport | null;
}

export const MAX_FINDINGS = 1000;

export function analyzeRanges(entries: readonly ListEntry[], parent: IpPrefix | null = null, maxFindings = MAX_FINDINGS): RangeReport {
  const families: FamilyReport[] = [];
  const findings: Finding[] = [];
  let omitted = 0;
  for (const family of [4, 6] as const) {
    const list = entries.filter(e => e.family === family).sort((a, b) => compareRanges(a, b) || a.line - b.line);
    if (list.length === 0) continue;
    // Sorted by first address with larger ranges first, so every later entry that starts inside
    // entry i is either inside it (contained or duplicate) or runs past its end (overlap).
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length && list[j].first <= a.last; j++) {
        const b = list[j];
        const kind: FindingKind = a.first === b.first && a.last === b.last ? 'duplicate' : b.last <= a.last ? 'contains' : 'overlap';
        if (findings.length >= maxFindings) {
          omitted++;
          continue;
        }
        const shared: IpRange = { family, first: b.first, last: b.last < a.last ? b.last : a.last };
        findings.push(kind === 'duplicate' && b.line < a.line ? { kind, a: b, b: a, shared } : { kind, a, b, shared });
      }
    }
    const merged = mergeRanges(list);
    families.push({ family, entries: list, merged, summary: merged.flatMap(r => summarizeRanges([r])), totalAddresses: merged.reduce((s, r) => s + rangeSize(r), 0n) });
  }

  let parentReport: ParentReport | null = null;
  if (parent) {
    const pr = prefixToRange(parent);
    const inside = entries.filter(e => e.family === parent.family && e.first >= pr.first && e.last <= pr.last);
    const overlapping = entries.filter(e => e.family === parent.family && e.first <= pr.last && pr.first <= e.last)
      .map(e => ({ family: e.family, first: e.first > pr.first ? e.first : pr.first, last: e.last < pr.last ? e.last : pr.last }));
    const gapRanges = subtractRanges(pr, overlapping);
    const gapAddresses = gapRanges.reduce((s, r) => s + rangeSize(r), 0n);
    parentReport = {
      prefix: parent,
      coveredAddresses: prefixSize(parent.family, parent.length) - gapAddresses,
      gaps: summarizeRangesList(gapRanges),
      gapAddresses,
      outside: entries.filter(e => !inside.includes(e)).sort((a, b) => a.line - b.line),
    };
  }
  return { families, findings, omittedFindings: omitted, parent: parentReport };
}

function summarizeRangesList(ranges: readonly IpRange[]): IpPrefix[] {
  return ranges.length === 0 ? [] : summarizeRanges(ranges);
}

/** Parses the optional parent network of the analyzer. */
export function parseParent(text: string): { prefix: IpPrefix | null; error: string | null; note: string | null } {
  const t = text.trim();
  if (t === '') return { prefix: null, error: null, note: null };
  const p = parsePrefixText(t);
  if (!p.ok) return { prefix: null, error: p.error.message, note: null };
  return { prefix: p.value.prefix, error: null, note: p.value.hostBitsSet ? `${t} has host bits set, so the parent is ${formatPrefix(p.value.prefix)}.` : null };
}

export interface RouteSummary {
  readonly family: Family;
  readonly inputCount: number;
  /** The fewest CIDR blocks covering exactly the input addresses. */
  readonly routes: readonly IpPrefix[];
  readonly addresses: bigint;
  /** Inputs that repeat an earlier input exactly. */
  readonly duplicates: number;
  /** Inputs entirely inside another, different input. */
  readonly contained: number;
  /**
   * The smallest single prefix containing every input. Only offered when the exact summary needs
   * more than one route; it is broader than the input and covers `extraAddresses` more.
   */
  readonly supernet: { readonly prefix: IpPrefix; readonly extraAddresses: bigint } | null;
}

export function summarizeRoutes(entries: readonly ListEntry[]): RouteSummary[] {
  const out: RouteSummary[] = [];
  for (const family of [4, 6] as const) {
    const list = entries.filter(e => e.family === family);
    if (list.length === 0) continue;
    const merged = mergeRanges(list);
    const routes = merged.flatMap(r => summarizeRanges([r]));
    const addresses = merged.reduce((s, r) => s + rangeSize(r), 0n);
    const keys = new Set<string>();
    let duplicates = 0;
    for (const e of list) {
      const key = `${e.first}-${e.last}`;
      if (keys.has(key)) duplicates++;
      else keys.add(key);
    }
    const contained = list.filter(e => list.some(o => o !== e && o.first <= e.first && e.last <= o.last && (o.first !== e.first || o.last !== e.last))).length;
    let supernet: RouteSummary['supernet'] = null;
    if (routes.length > 1) {
      const prefix = coveringPrefix(list);
      supernet = { prefix, extraAddresses: prefixSize(family, prefix.length) - addresses };
    }
    out.push({ family, inputCount: list.length, routes, addresses, duplicates, contained, supernet });
  }
  return out;
}
