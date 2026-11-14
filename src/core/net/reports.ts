/**
 * Export shapes (CSV rows and JSON objects) for the network tools. Pure functions, so exports are
 * tested exactly. Addresses are written in canonical text; counts are exact decimal strings in
 * JSON (they can exceed what a JSON number holds without loss).
 */
import { toCsv, type CsvCell } from '../export/csv';
import { expandAddress, familyName, formatAddress, formatPrefix, formatRange, prefixMask, prefixToRange, rangeSize, type IpPrefix } from './address';
import type { FindingKind, RangeReport, RouteSummary } from './analysis';
import { formatIPv4 } from './ipv4';
import type { LineError } from './list';
import type { VlsmBlock, VlsmResult } from './vlsm';

const KIND_LABEL: Record<VlsmBlock['kind'], string> = { request: 'Request', fixed: 'Fixed', reserved: 'Reserved' };

export function prefixRows(prefixes: readonly IpPrefix[]): CsvCell[][] {
  return prefixes.map(p => {
    const r = prefixToRange(p);
    return [formatPrefix(p), formatAddress(p.family, r.first), formatAddress(p.family, r.last), rangeSize(r)];
  });
}

export function prefixListCsv(prefixes: readonly IpPrefix[]): string {
  return toCsv([['Network', 'First address', 'Last address', 'Addresses'], ...prefixRows(prefixes)]);
}

export function prefixListJson(prefixes: readonly IpPrefix[]): object[] {
  return prefixes.map(p => {
    const r = prefixToRange(p);
    return { network: formatPrefix(p), first: formatAddress(p.family, r.first), last: formatAddress(p.family, r.last), addresses: rangeSize(r).toString() };
  });
}

// ---- VLSM ------------------------------------------------------------------------------------

export const VLSM_COLUMNS = ['Name', 'Type', 'Network', 'Subnet mask', 'First usable', 'Last usable', 'Requested hosts', 'Host capacity', 'Addresses'] as const;

export function vlsmBlockRow(b: VlsmBlock): CsvCell[] {
  return [
    b.name,
    KIND_LABEL[b.kind],
    b.prefix ? formatPrefix(b.prefix) : formatRange(b.range),
    b.prefix ? formatIPv4(prefixMask(4, b.prefix.length)) : '',
    b.firstUsable === null ? '' : formatIPv4(b.firstUsable),
    b.lastUsable === null ? '' : formatIPv4(b.lastUsable),
    b.requestedHosts ?? '',
    b.hostCapacity ?? '',
    rangeSize(b.range),
  ];
}

export function vlsmCsv(result: VlsmResult): string {
  const rows: CsvCell[][] = [[...VLSM_COLUMNS], ...result.blocks.map(vlsmBlockRow)];
  for (const f of result.failures) rows.push([f.name, 'Not allocated', '', '', '', '', f.hosts, '', '']);
  for (const p of result.free) rows.push(['', 'Free', formatPrefix(p), formatIPv4(prefixMask(4, p.length)), '', '', '', '', rangeSize(prefixToRange(p))]);
  return toCsv(rows);
}

export function vlsmJson(result: VlsmResult): object {
  const s = result.summary;
  return {
    parent: result.parent ? formatPrefix(result.parent) : null,
    allocations: result.blocks.map(b => ({
      name: b.name,
      type: b.kind,
      network: b.prefix ? formatPrefix(b.prefix) : null,
      range: formatRange(b.range),
      subnetMask: b.prefix ? formatIPv4(prefixMask(4, b.prefix.length)) : null,
      firstUsable: b.firstUsable === null ? null : formatIPv4(b.firstUsable),
      lastUsable: b.lastUsable === null ? null : formatIPv4(b.lastUsable),
      requestedHosts: b.requestedHosts,
      hostCapacity: b.hostCapacity === null ? null : Number(b.hostCapacity),
      addresses: Number(rangeSize(b.range)),
    })),
    failures: result.failures.map(f => ({ name: f.name, requestedHosts: f.hosts, prefixLength: f.prefixLength, reason: f.code, message: f.message })),
    unallocated: result.free.map(formatPrefix),
    summary: s && {
      parentAddresses: Number(s.parentAddresses),
      allocatedAddresses: Number(s.allocatedAddresses),
      fixedAddresses: Number(s.fixedAddresses),
      reservedAddresses: Number(s.reservedAddresses),
      freeAddresses: Number(s.freeAddresses),
      requestedHosts: s.requestedHosts,
      hostCapacity: Number(s.hostCapacity),
    },
    notes: result.notes,
  };
}

// ---- Range analysis --------------------------------------------------------------------------

const FINDING_WORDS: Record<FindingKind, (a: number, b: number) => [string, string]> = {
  duplicate: (a, b) => [`same as line ${b}`, `same as line ${a}`],
  contains: (a, b) => [`contains line ${b}`, `inside line ${a}`],
  overlap: (a, b) => [`overlaps line ${b}`, `overlaps line ${a}`],
};

/** Per-line notes describing every finding that involves the line. */
export function findingNotes(report: RangeReport): Map<number, string[]> {
  const notes = new Map<number, string[]>();
  const add = (line: number, text: string) => notes.set(line, [...(notes.get(line) ?? []), text]);
  for (const f of report.findings) {
    const [forA, forB] = FINDING_WORDS[f.kind](f.a.line, f.b.line);
    add(f.a.line, forA);
    add(f.b.line, forB);
  }
  return notes;
}

export function analysisCsv(report: RangeReport): string {
  const notes = findingNotes(report);
  const rows: CsvCell[][] = [['Line', 'Input', 'Family', 'Normalized', 'First address', 'Last address', 'Addresses', 'Findings']];
  for (const fam of report.families) {
    for (const e of fam.entries) {
      rows.push([e.line, e.text, familyName(e.family), formatRange(e), formatAddress(e.family, e.first), formatAddress(e.family, e.last), rangeSize(e), (notes.get(e.line) ?? []).join('; ')]);
    }
  }
  return toCsv(rows);
}

export function analysisJson(report: RangeReport, errors: readonly LineError[]): object {
  return {
    errors: errors.map(e => ({ line: e.line, input: e.text, message: e.message })),
    families: report.families.map(f => ({
      family: familyName(f.family),
      entries: f.entries.map(e => ({
        line: e.line, input: e.text, normalized: formatRange(e), first: formatAddress(e.family, e.first), last: formatAddress(e.family, e.last),
        firstExpanded: expandAddress(e.family, e.first), addresses: rangeSize(e).toString(), hostBitsSet: e.hostBitsSet,
      })),
      totalAddresses: f.totalAddresses.toString(),
      summary: f.summary.map(formatPrefix),
    })),
    findings: report.findings.map(f => ({ kind: f.kind, lineA: f.a.line, lineB: f.b.line, a: formatRange(f.a), b: formatRange(f.b), shared: formatRange(f.shared) })),
    omittedFindings: report.omittedFindings,
    parent: report.parent && {
      network: formatPrefix(report.parent.prefix),
      coveredAddresses: report.parent.coveredAddresses.toString(),
      gapAddresses: report.parent.gapAddresses.toString(),
      gaps: report.parent.gaps.map(formatPrefix),
      outsideLines: report.parent.outside.map(e => e.line),
    },
  };
}

// ---- Route summarization ---------------------------------------------------------------------

export function routesCsv(summaries: readonly RouteSummary[]): string {
  const rows: CsvCell[][] = [['Family', 'Route', 'First address', 'Last address', 'Addresses']];
  for (const s of summaries) for (const row of prefixRows(s.routes)) rows.push([familyName(s.family), ...row]);
  return toCsv(rows);
}

export function routesJson(summaries: readonly RouteSummary[]): object {
  return Object.fromEntries(summaries.map(s => [familyName(s.family).toLowerCase(), {
    inputs: s.inputCount,
    routes: s.routes.map(formatPrefix),
    addresses: s.addresses.toString(),
    duplicates: s.duplicates,
    contained: s.contained,
    broaderSupernet: s.supernet && { network: formatPrefix(s.supernet.prefix), extraAddresses: s.supernet.extraAddresses.toString(), exact: false },
  }]));
}
