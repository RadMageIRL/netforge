/** CSV exports of a plan: the VLAN table and the validation findings. Text cells are guarded against spreadsheet formulas. */
import { toCsv, type CsvCell } from '../export/csv';
import { formatPrefix, prefixMask } from '../net/address';
import { formatIPv4 } from '../net/ipv4';
import { hostCapacity } from '../net/vlsm';
import type { Plan, Vlan } from './model';
import type { PlanIssue, PlanValidation } from './validate';

export const VLAN_CSV_COLUMNS = [
  'Site', 'VLAN namespace', 'VLAN ID', 'Name', 'VRF', 'IPv4 network', 'Subnet mask', 'IPv4 gateway', 'Usable IPv4 addresses', 'Host target',
  'DHCP pools', 'Reserved', 'IPv4 fixed', 'IPv6 prefixes', 'IPv6 gateway', 'IPv6 fixed', 'Description', 'Notes', 'Errors', 'Warnings',
] as const;

const join = (list: readonly string[]) => list.map(s => s.trim()).filter(Boolean).join('; ');

/** One row per VLAN, in the order given (the table's order when exporting what is shown). */
export function vlanCsv(plan: Plan, validation: PlanValidation, vlans: readonly Vlan[] = plan.vlans): string {
  const sites = new Map(plan.sites.map(s => [s.id, s.name]));
  const vrfs = new Map(plan.vrfs.map(v => [v.id, v.name]));
  const namespaces = new Map(plan.namespaces.map(n => [n.id, n.name]));
  const rows: CsvCell[][] = [[...VLAN_CSV_COLUMNS]];
  for (const v of vlans) {
    const p = validation.parsed.get(v.id);
    const net = p?.ipv4 ?? null;
    const issues = validation.forTarget('vlan', v.id);
    rows.push([
      sites.get(v.siteId) ?? v.siteId, namespaces.get(v.namespaceId) ?? v.namespaceId, p?.vlanNumber ?? v.vlanId, v.name, vrfs.get(v.vrfId) ?? v.vrfId,
      net ? formatPrefix(net) : v.ipv4.network, net ? formatIPv4(prefixMask(4, net.length)) : '', v.ipv4.gateway.trim(),
      net ? hostCapacity(net.length) : '', p?.hosts ?? v.hosts,
      join(v.ipv4.dhcp), join(v.reserved.map(r => (r.label.trim() ? `${r.range.trim()} (${r.label.trim()})` : r.range))), v.ipv4.fixed ? 'yes' : 'no',
      join(v.ipv6.prefixes), v.ipv6.gateway.trim(), v.ipv6.fixed ? 'yes' : 'no',
      v.description, v.notes,
      issues.filter(i => i.severity === 'error').length, issues.filter(i => i.severity === 'warning').length,
    ]);
  }
  return toCsv(rows);
}

export const ISSUE_CSV_COLUMNS = ['Severity', 'Code', 'Where', 'Field', 'Entry', 'Message', 'Routing-domain scope'] as const;

export function issuesCsv(issues: readonly PlanIssue[], where: (issue: PlanIssue) => string): string {
  const rows: CsvCell[][] = [[...ISSUE_CSV_COLUMNS]];
  for (const i of issues) rows.push([i.severity, i.code, where(i), i.field ?? '', i.line === null ? '' : i.line + 1, i.message, i.scope?.text ?? '']);
  return toCsv(rows);
}
