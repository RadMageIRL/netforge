/** The Issues tab: every finding in the plan, by severity, each linked to the field it is about. */
import { formatInteger } from '../../core/format';
import { issuesCsv } from '../../core/plan/reports';
import { describeVlan, type PlanIssue, type Severity } from '../../core/plan/validate';
import type { ToolServices } from '../../app/registry';
import { button, emptyState, notice, panel, segmented } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { plural } from './common';
import type { PlanStore } from './store';

export const FIELD_LABEL: Record<string, string> = {
  vlanId: 'VLAN ID', name: 'Name', siteId: 'Site', namespaceId: 'VLAN namespace', vrfId: 'VRF', hosts: 'Host target',
  'ipv4.network': 'IPv4 network', 'ipv4.gateway': 'IPv4 gateway', 'ipv4.dhcp': 'DHCP pools', 'ipv6.prefixes': 'IPv6 prefixes', 'ipv6.gateway': 'IPv6 gateway',
  reserved: 'Reserved', network: 'Network', exchangesWith: 'Exchanges routes with',
};

const RENDER_LIMIT = 500;

export interface IssuesView {
  readonly root: HTMLElement;
  setActive(active: boolean): void;
  refresh(): void;
}

export function whereOf(store: PlanStore, issue: PlanIssue): string {
  const plan = store.plan;
  const t = issue.target;
  switch (t.kind) {
    case 'vlan': {
      const v = plan.vlans.find(x => x.id === t.id);
      return v ? describeVlan(plan, v) : 'A VLAN';
    }
    case 'site': return `Site "${plan.sites.find(s => s.id === t.id)?.name.trim() || '(unnamed)'}"`;
    case 'block': {
      const s = plan.sites.find(x => x.id === t.siteId);
      const i = s ? s.blocks.findIndex(b => b.id === t.id) : -1;
      return `Parent block ${i + 1}${s && i >= 0 && s.blocks[i].network.trim() ? ` (${s.blocks[i].network.trim()})` : ''} of site "${s?.name.trim() || '(unnamed)'}"`;
    }
    case 'vrf': return `VRF "${plan.vrfs.find(v => v.id === t.id)?.name.trim() || '(unnamed)'}"`;
    case 'namespace': return `VLAN namespace "${plan.namespaces.find(n => n.id === t.id)?.name.trim() || '(unnamed)'}"`;
    default: return 'The plan';
  }
}

export function issuesView(store: PlanStore, services: ToolServices, go: (issue: PlanIssue) => void): IssuesView {
  let filter: 'all' | Severity = 'all';
  let active = false;
  let dirty = true;
  const choice = segmented({ label: 'Show', name: 'issue-filter', value: 'all', choices: [
    { value: 'all', label: 'All' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }, { value: 'info', label: 'Notes' },
  ], onChange: v => { filter = v as typeof filter; draw(); } });
  const list = h('div', { id: 'issue-list' });
  const timing = h('p', { class: 'source-note', id: 'issue-timing' });
  const csv = button({ label: 'Export findings', icon: 'download', id: 'issue-csv', title: 'Download every finding as CSV', onClick: () => {
    services.download(`${(store.plan.name.trim() || 'network-plan').replace(/[^A-Za-z0-9._-]+/g, '-')}-findings.csv`, issuesCsv(store.validation.issues, i => whereOf(store, i)), 'text/csv');
  } });

  function draw(): void {
    dirty = false;
    const v = store.validation;
    const shown = v.issues.filter(i => filter === 'all' || i.severity === filter);
    csv.disabled = v.issues.length === 0;
    timing.textContent = `Checked ${plural(store.plan.vlans.length, 'VLAN')} in ${store.lastValidationMs.toFixed(1)} ms.`;
    if (v.issues.length === 0) {
      replaceChildren(list, store.plan.vlans.length ? notice('ok', 'No problems found.') : emptyState('Nothing to check yet.'));
      return;
    }
    const kinds = { error: 'Error', warning: 'Warning', info: 'Note' } as const;
    replaceChildren(list,
      h('p', { class: 'issue-counts', id: 'issue-counts' }, `${plural(v.counts.error, 'error')}, ${plural(v.counts.warning, 'warning')}, ${plural(v.counts.info, 'note')}.`),
      shown.length === 0 ? emptyState('None of this kind.') : h('ul', { class: 'issue-list' }, shown.slice(0, RENDER_LIMIT).map(issue => {
        const where = whereOf(store, issue);
        const field = issue.field ? FIELD_LABEL[issue.field] ?? issue.field : null;
        const link = h('button', { type: 'button', class: 'link-button' }, field ? `${where}, ${field.toLowerCase()}` : where);
        link.addEventListener('click', () => go(issue));
        return h('li', { class: `issue issue-${issue.severity}`, 'data-code': issue.code },
          h('span', { class: `issue-kind kind-${issue.severity}` }, icon(issue.severity === 'info' ? 'info' : issue.severity), h('span', null, kinds[issue.severity])),
          h('div', { class: 'issue-body' }, h('p', { class: 'issue-where' }, link), h('p', { class: 'issue-message' }, issue.message),
            issue.scope ? h('p', { class: 'issue-scope' }, `Routing-domain scope: ${issue.scope.text}.`) : null),
        );
      })),
      shown.length > RENDER_LIMIT ? h('p', { class: 'source-note' }, `First ${formatInteger(RENDER_LIMIT, 'en-US')} of ${formatInteger(shown.length, 'en-US')} shown. Export the findings or filter the VLAN table to see the rest.`) : null,
    );
  }

  return {
    root: h('div', { class: 'planner-tab' }, panel('Findings', [choice.root, list, timing], csv)),
    setActive(on) {
      active = on;
      if (on && dirty) draw();
    },
    refresh() {
      dirty = true;
      if (active) draw();
    },
  };
}
