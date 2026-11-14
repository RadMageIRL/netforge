/**
 * The VLAN tab: a filterable, sortable table and an editor for the selected VLAN.
 *
 * Rows are keyed by VLAN and rebuilt only when something they show changes, so editing one VLAN in
 * a plan of a thousand touches one row (plus any row whose findings changed), and sorting moves
 * existing rows instead of building new ones.
 */
import type { ToolServices } from '../../app/registry';
import { formatInteger } from '../../core/format';
import { hostCapacity } from '../../core/net/vlsm';
import { namespacesForSite, nextId, vlanDefaults, vrfsForSite, blankVlan, type Vlan } from '../../core/plan/model';
import { vlanCsv } from '../../core/plan/reports';
import type { PlanIssue } from '../../core/plan/validate';
import { button, checkbox, notice, panel, selectField, textArea, textField, type FieldHandle } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { collator, fieldIssues, linesToList, linesToReserved, plural, reservedToLines, setOptions, severityCounts, statusBadge } from './common';
import type { ChangeSource, PlanStore } from './store';

type SortKey = 'status' | 'site' | 'namespace' | 'vlan' | 'name' | 'vrf' | 'ipv4' | 'gateway' | 'hosts' | 'dhcp' | 'ipv6';

const COLUMNS: readonly { key: SortKey; label: string; numeric?: boolean; mono?: boolean }[] = [
  { key: 'status', label: 'Status' },
  { key: 'site', label: 'Site' },
  { key: 'namespace', label: 'Namespace' },
  { key: 'vlan', label: 'VLAN', numeric: true, mono: true },
  { key: 'name', label: 'Name' },
  { key: 'vrf', label: 'VRF' },
  { key: 'ipv4', label: 'IPv4 network', mono: true },
  { key: 'gateway', label: 'Gateway', mono: true },
  { key: 'hosts', label: 'Hosts', numeric: true },
  { key: 'dhcp', label: 'DHCP', mono: true },
  { key: 'ipv6', label: 'IPv6', mono: true },
];

type StatusFilter = 'all' | 'error' | 'warning' | 'problems' | 'info';

export interface VlanView {
  readonly root: HTMLElement;
  /** Opens the editor on a VLAN and focuses a field. */
  open(vlanId: string, field?: string | null): void;
  /** The VLANs currently shown, in table order. */
  shown(): Vlan[];
  refresh(source: ChangeSource): void;
}

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');
const UP = String.fromCharCode(0x25b2);
const DOWN = String.fromCharCode(0x25bc);

export function vlanView(store: PlanStore, services: ToolServices): VlanView {
  let selected: string | null = null;
  let sortKey: SortKey = 'site';
  let sortDir: 1 | -1 = 1;
  let lastOrder: string[] = [];
  let shownList: Vlan[] = [];
  const rows = new Map<string, { tr: HTMLTableRowElement; sig: string; search: string }>();
  let undo: { vlan: Vlan; index: number } | null = null;

  const vlan = () => store.plan.vlans.find(v => v.id === selected) ?? null;

  // ---- Toolbar and filters -----------------------------------------------------------------
  const addButton = button({ label: 'Add VLAN', icon: 'plus', variant: 'primary', id: 'vlan-add', onClick: () => addVlan() });
  const filterText = textField({ id: 'vlan-filter', label: 'Filter', placeholder: 'Name, ID, network...' });
  const filterSite = selectField({ id: 'vlan-filter-site', label: 'Site', groups: [], value: '' });
  const filterVrf = selectField({ id: 'vlan-filter-vrf', label: 'VRF', groups: [], value: '' });
  const filterNs = selectField({ id: 'vlan-filter-namespace', label: 'Namespace', groups: [], value: '' });
  const filterStatus = selectField({
    id: 'vlan-filter-status', label: 'Status', value: 'all', groups: [{ label: null, options: [
      { value: 'all', label: 'All' }, { value: 'problems', label: 'Errors or warnings' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }, { value: 'info', label: 'Notes' },
    ] }],
  });
  let filterTimer = 0;
  filterText.control.addEventListener('input', () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(refreshTable, 120);
  });
  for (const f of [filterSite, filterVrf, filterNs, filterStatus]) f.control.addEventListener('change', refreshTable);
  const countLine = h('p', { class: 'table-count', role: 'status', id: 'vlan-count' });
  const csvButton = button({ label: 'Export CSV', icon: 'download', id: 'vlan-csv', title: 'Download the VLANs shown, in the order shown, as CSV', onClick: () => {
    services.download(`${fileStem()}-vlans.csv`, vlanCsv(store.plan, store.validation, shownList), 'text/csv');
  } });
  const fileStem = () => (store.plan.name.trim() || 'network-plan').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'network-plan';
  const undoArea = h('div', { class: 'undo-area' });

  // ---- Table ----------------------------------------------------------------------------------
  const headCells = COLUMNS.map(c => {
    const b = h('button', { type: 'button', class: 'sort-button' }, h('span', null, c.label), h('span', { class: 'sort-mark', 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (sortKey === c.key) sortDir = sortDir === 1 ? -1 : 1;
      else {
        sortKey = c.key;
        sortDir = 1;
      }
      refreshTable();
    });
    return { key: c.key, th: h('th', { scope: 'col', class: c.numeric ? 'num' : undefined }, b), button: b };
  });
  const tbody = h('tbody');
  const emptyRow = h('p', { class: 'empty-state', id: 'vlan-empty' });
  const table = h('div', { class: 'table-scroll vlan-table-wrap', role: 'region', 'aria-label': 'VLAN table', tabindex: '0' },
    h('table', { class: 'data-table vlan-table', id: 'vlan-table' },
      h('caption', { class: 'visually-hidden' }, 'VLANs. Column headers sort the table.'),
      h('thead', null, h('tr', null, headCells.map(c => c.th))),
      tbody,
    ),
  );

  // ---- Editor -----------------------------------------------------------------------------------
  const f = {
    vlanId: textField({ id: 'vlan-edit-vlanid', label: 'VLAN ID', placeholder: '10', mono: true }),
    name: textField({ id: 'vlan-edit-name', label: 'Name', placeholder: 'Users' }),
    site: selectField({ id: 'vlan-edit-site', label: 'Site', groups: [], value: '' }),
    namespace: selectField({ id: 'vlan-edit-namespace', label: 'VLAN namespace', groups: [], value: '', hint: 'VLAN IDs must be unique within a namespace.' }),
    vrf: selectField({ id: 'vlan-edit-vrf', label: 'VRF (routing domain)', groups: [], value: '', hint: 'Networks must not overlap within a VRF, or with VRFs it exchanges routes with.' }),
    hosts: textField({ id: 'vlan-edit-hosts', label: 'Host target', placeholder: '200', mono: true, hint: 'Usable IPv4 addresses needed, including the gateway.' }),
    net4: textField({ id: 'vlan-edit-ipv4', label: 'IPv4 network', placeholder: '10.10.10.0/24', mono: true }),
    gw4: textField({ id: 'vlan-edit-gateway4', label: 'IPv4 gateway', placeholder: '10.10.10.1', mono: true }),
    dhcp: textArea({ id: 'vlan-edit-dhcp', label: 'DHCP pools', mono: true, rows: 3, placeholder: '10.10.10.100 - 10.10.10.250', hint: 'One range, address or CIDR per line.' }),
    v6: textArea({ id: 'vlan-edit-ipv6', label: 'IPv6 prefixes', mono: true, rows: 2, placeholder: '2001:db8:10:10::/64', hint: 'One per line; normally a /64 each.' }),
    gw6: textField({ id: 'vlan-edit-gateway6', label: 'IPv6 gateway', placeholder: 'fe80::1', mono: true, hint: 'An address in one of the prefixes, or a link-local address.' }),
    reserved: textArea({ id: 'vlan-edit-reserved', label: 'Reserved addresses', mono: true, rows: 3, placeholder: '10.10.10.2 - 10.10.10.20 # access points', hint: 'An address, range or CIDR per line, IPv4 or IPv6, with an optional label after #.' }),
    description: textField({ id: 'vlan-edit-description', label: 'Description' }),
    notes: textArea({ id: 'vlan-edit-notes', label: 'Notes', rows: 3 }),
  };
  for (const a of [f.dhcp, f.v6, f.reserved, f.notes]) a.control.classList.add('textarea-short');
  f.notes.control.setAttribute('wrap', 'soft');
  const fixed4 = checkbox({ id: 'vlan-edit-fixed4', label: 'Keep this IPv4 network when reallocating', onChange: value => edit(v => { v.ipv4.fixed = value; }, 'other') });
  const fixed6 = checkbox({ id: 'vlan-edit-fixed6', label: 'Keep these IPv6 prefixes when reallocating', onChange: value => edit(v => { v.ipv6.fixed = value; }, 'other') });

  const FIELD_OF: Record<string, FieldHandle<HTMLElement>> = {
    vlanId: f.vlanId, name: f.name, siteId: f.site, namespaceId: f.namespace, vrfId: f.vrf, hosts: f.hosts,
    'ipv4.network': f.net4, 'ipv4.gateway': f.gw4, 'ipv4.dhcp': f.dhcp, 'ipv6.prefixes': f.v6, 'ipv6.gateway': f.gw6, reserved: f.reserved,
  };

  function edit(mutate: (v: Vlan) => void, source: ChangeSource = 'editor'): void {
    const v = vlan();
    if (!v) return;
    store.change(source, () => mutate(v));
  }
  const onInput = (field: FieldHandle<HTMLInputElement | HTMLTextAreaElement>, apply: (v: Vlan, value: string) => void) => {
    field.control.addEventListener('input', () => edit(v => apply(v, field.control.value)));
  };
  onInput(f.vlanId, (v, x) => { v.vlanId = x; });
  onInput(f.name, (v, x) => { v.name = x; });
  onInput(f.hosts, (v, x) => { v.hosts = x; });
  onInput(f.net4, (v, x) => { v.ipv4.network = x; });
  onInput(f.gw4, (v, x) => { v.ipv4.gateway = x; });
  onInput(f.dhcp, (v, x) => { v.ipv4.dhcp = linesToList(x); });
  onInput(f.v6, (v, x) => { v.ipv6.prefixes = linesToList(x); });
  onInput(f.gw6, (v, x) => { v.ipv6.gateway = x; });
  onInput(f.reserved, (v, x) => { v.reserved = linesToReserved(x); });
  onInput(f.description, (v, x) => { v.description = x; });
  onInput(f.notes, (v, x) => { v.notes = x; });
  f.site.control.addEventListener('change', () => edit(v => {
    v.siteId = f.site.control.value;
    // Keep the VLAN consistent: a VRF or namespace that does not exist at the new site is swapped for one that does.
    const d = vlanDefaults(store.plan, v.siteId);
    if (!vrfsForSite(store.plan, v.siteId).some(x => x.id === v.vrfId)) v.vrfId = d.vrfId;
    if (!namespacesForSite(store.plan, v.siteId).some(x => x.id === v.namespaceId)) v.namespaceId = d.namespaceId;
  }, 'other'));
  f.namespace.control.addEventListener('change', () => edit(v => { v.namespaceId = f.namespace.control.value; }, 'other'));
  f.vrf.control.addEventListener('change', () => edit(v => { v.vrfId = f.vrf.control.value; }, 'other'));

  const editorTitle = h('h3', { class: 'editor-title', id: 'vlan-editor-title', tabindex: '-1' });
  const generalIssues = h('div', { class: 'editor-general' });
  const doneButton = button({ label: 'Done', variant: 'ghost', id: 'vlan-done', onClick: () => close(true) });
  const duplicateButton = button({ label: 'Duplicate', id: 'vlan-duplicate', onClick: () => duplicate() });
  const deleteButton = button({ label: 'Delete', id: 'vlan-delete', onClick: () => remove() });
  const group = (title: string, ...children: (HTMLElement | null)[]) => h('fieldset', { class: 'editor-group' }, h('legend', { class: 'editor-legend' }, title), h('div', { class: 'editor-grid' }, children));
  const editor = h('section', { class: 'vlan-editor', id: 'vlan-editor', 'aria-labelledby': 'vlan-editor-title', hidden: true },
    h('div', { class: 'editor-head' }, editorTitle, h('div', { class: 'toolbar' }, duplicateButton, deleteButton, doneButton)),
    generalIssues,
    group('VLAN', f.vlanId.root, f.name.root, f.site.root, f.namespace.root, f.vrf.root),
    group('IPv4', f.net4.root, f.gw4.root, f.hosts.root, fixed4.root, f.dhcp.root),
    group('IPv6', f.v6.root, f.gw6.root, fixed6.root),
    group('Other', f.reserved.root, f.description.root, f.notes.root),
  );

  function loadEditor(): void {
    const v = vlan();
    if (!v) {
      editor.hidden = true;
      return;
    }
    editor.hidden = false;
    f.vlanId.control.value = v.vlanId;
    f.name.control.value = v.name;
    f.hosts.control.value = v.hosts;
    f.net4.control.value = v.ipv4.network;
    f.gw4.control.value = v.ipv4.gateway;
    f.dhcp.control.value = v.ipv4.dhcp.join('\n');
    f.v6.control.value = v.ipv6.prefixes.join('\n');
    f.gw6.control.value = v.ipv6.gateway;
    f.reserved.control.value = reservedToLines(v.reserved);
    f.description.control.value = v.description;
    f.notes.control.value = v.notes;
    fixed4.input.checked = v.ipv4.fixed;
    fixed6.input.checked = v.ipv6.fixed;
    loadSelects(v);
    showEditorIssues();
  }

  function loadSelects(v: Vlan): void {
    const plan = store.plan;
    setOptions(f.site.control, plan.sites.map(s => ({ value: s.id, label: s.name.trim() || '(unnamed site)' })), v.siteId);
    setOptions(f.namespace.control, namespacesForSite(plan, v.siteId).map(n => ({ value: n.id, label: n.name.trim() || '(unnamed namespace)' })), v.namespaceId, id => `${plan.namespaces.find(n => n.id === id)?.name ?? id} (not at this site)`);
    setOptions(f.vrf.control, vrfsForSite(plan, v.siteId).map(r => ({ value: r.id, label: r.name.trim() || '(unnamed VRF)' })), v.vrfId, id => `${plan.vrfs.find(r => r.id === id)?.name ?? id} (not at this site)`);
  }

  function showEditorIssues(): void {
    const v = vlan();
    if (!v) return;
    const issues = store.validation.forTarget('vlan', v.id);
    const byField = new Map<string, PlanIssue[]>();
    const general: PlanIssue[] = [];
    for (const i of issues) {
      if (i.field && FIELD_OF[i.field]) byField.set(i.field, [...(byField.get(i.field) ?? []), i]);
      else general.push(i);
    }
    for (const [key, field] of Object.entries(FIELD_OF)) fieldIssues(field, byField.get(key) ?? []);
    replaceChildren(generalIssues, general.map(i => notice(i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info', i.message)));
    const c = severityCounts(issues);
    replaceChildren(editorTitle, editorHeading(v), h('span', { class: 'editor-status' }, statusBadge(issues)));
    editor.dataset.errors = String(c.error);
  }

  function editorHeading(v: Vlan): string {
    const id = v.vlanId.trim();
    const name = v.name.trim();
    return id || name ? `VLAN ${id || '?'}${name ? ` ${name}` : ''}` : 'New VLAN';
  }

  function open(vlanId: string, field: string | null = null): void {
    selected = vlanId;
    undo = null;
    replaceChildren(undoArea);
    loadEditor();
    refreshTable();
    editor.scrollIntoView({ block: 'start' });
    const target = field ? FIELD_OF[field] : null;
    (target ? target.control : f.vlanId.control).focus({ preventScroll: true });
  }

  function close(returnFocus: boolean): void {
    const id = selected;
    selected = null;
    editor.hidden = true;
    refreshTable();
    if (returnFocus && id) rows.get(id)?.tr.querySelector<HTMLButtonElement>('button')?.focus();
  }

  function addVlan(): void {
    const plan = store.plan;
    if (plan.sites.length === 0) {
      replaceChildren(undoArea, notice('warning', 'Add a site first (Sites, VRFs and namespaces tab).'));
      return;
    }
    const siteId = filterSite.control.value && plan.sites.some(s => s.id === filterSite.control.value) ? filterSite.control.value : plan.sites[0].id;
    const id = nextId('v', plan.vlans);
    store.change('other', p => { p.vlans.push(blankVlan(id, vlanDefaults(p, siteId))); });
    // A new VLAN must be visible even when filters would hide it.
    filterText.control.value = '';
    filterStatus.control.value = 'all';
    open(id);
  }

  function duplicate(): void {
    const v = vlan();
    if (!v) return;
    const copy = structuredClone(v);
    copy.id = nextId('v', store.plan.vlans);
    copy.name = v.name.trim() ? `${v.name.trim()} copy` : '';
    const index = store.plan.vlans.indexOf(v);
    store.change('other', p => { p.vlans.splice(index + 1, 0, copy); });
    open(copy.id);
    replaceChildren(undoArea, notice('info', 'Copied. The copy has the same VLAN ID and networks as the original, so change them.'));
  }

  function remove(): void {
    const v = vlan();
    if (!v) return;
    const index = store.plan.vlans.indexOf(v);
    const label = editorHeading(v);
    selected = null;
    editor.hidden = true;
    store.change('other', p => { p.vlans.splice(index, 1); });
    undo = { vlan: v, index };
    const undoButton = button({ label: 'Undo', id: 'vlan-undo', onClick: () => {
      if (!undo) return;
      const { vlan: back, index: at } = undo;
      undo = null;
      replaceChildren(undoArea);
      if (store.plan.vlans.some(x => x.id === back.id)) back.id = nextId('v', store.plan.vlans);
      store.change('other', p => { p.vlans.splice(Math.min(at, p.vlans.length), 0, back); });
      open(back.id);
    } });
    replaceChildren(undoArea, notice('info', h('p', null, `Deleted ${label}. `, undoButton)));
    services.announce(`Deleted ${label}.`);
    undoButton.focus();
  }

  // ---- Table refresh ------------------------------------------------------------------------
  function refreshFilters(): void {
    const plan = store.plan;
    const all = { value: '', label: 'All' };
    setOptions(filterSite.control, [all, ...plan.sites.map(s => ({ value: s.id, label: s.name.trim() || '(unnamed site)' }))], plan.sites.some(s => s.id === filterSite.control.value) ? filterSite.control.value : '');
    setOptions(filterVrf.control, [all, ...plan.vrfs.map(r => ({ value: r.id, label: r.name.trim() || '(unnamed VRF)' }))], plan.vrfs.some(r => r.id === filterVrf.control.value) ? filterVrf.control.value : '');
    setOptions(filterNs.control, [all, ...plan.namespaces.map(n => ({ value: n.id, label: n.name.trim() || '(unnamed namespace)' }))], plan.namespaces.some(n => n.id === filterNs.control.value) ? filterNs.control.value : '');
  }

  function cellsFor(names: Names, v: Vlan): Record<SortKey, string> {
    const p = store.validation.parsed.get(v.id);
    const capacity = p?.ipv4 ? fmt(hostCapacity(p.ipv4.length)) : '';
    const hosts = v.hosts.trim();
    return {
      status: '',
      site: names.sites.get(v.siteId) ?? v.siteId,
      namespace: names.namespaces.get(v.namespaceId) ?? v.namespaceId,
      vlan: v.vlanId.trim(),
      name: v.name.trim(),
      vrf: names.vrfs.get(v.vrfId) ?? v.vrfId,
      ipv4: v.ipv4.network.trim(),
      gateway: v.ipv4.gateway.trim(),
      hosts: hosts && capacity ? `${hosts} / ${capacity}` : hosts || (capacity ? `- / ${capacity}` : ''),
      dhcp: v.ipv4.dhcp.length === 0 ? '' : v.ipv4.dhcp.length === 1 ? v.ipv4.dhcp[0] : `${v.ipv4.dhcp[0]} +${v.ipv4.dhcp.length - 1}`,
      ipv6: v.ipv6.prefixes.length === 0 ? '' : v.ipv6.prefixes.length === 1 ? v.ipv6.prefixes[0] : `${v.ipv6.prefixes[0]} +${v.ipv6.prefixes.length - 1}`,
    };
  }

  interface Names { sites: Map<string, string>; vrfs: Map<string, string>; namespaces: Map<string, string> }

  function buildRow(v: Vlan, cells: Record<SortKey, string>, issues: readonly PlanIssue[]): HTMLTableRowElement {
    const nameButton = h('button', { type: 'button', class: 'link-button' }, cells.name || '(unnamed)');
    nameButton.addEventListener('click', () => open(v.id));
    const c = severityCounts(issues);
    const tr = h('tr', { 'data-vlan': v.id, class: [c.error ? 'row-error' : c.warning ? 'row-warning' : '', v.id === selected ? 'is-selected' : ''].join(' ').trim() || undefined },
      COLUMNS.map(col => {
        if (col.key === 'status') return h('td', { class: 'status-cell' }, statusBadge(issues));
        if (col.key === 'name') return h('td', null, nameButton);
        return h('td', { class: [col.mono ? 'mono' : '', col.numeric ? 'num' : ''].join(' ').trim() || undefined }, cells[col.key]);
      }),
    );
    if (v.id === selected) nameButton.setAttribute('aria-current', 'true');
    return tr;
  }

  function sortValue(v: Vlan, key: SortKey, cells: Record<SortKey, string>): number | bigint | string | null {
    const p = store.validation.parsed.get(v.id);
    switch (key) {
      case 'status': {
        const c = severityCounts(store.validation.forTarget('vlan', v.id));
        return c.error ? 0 : c.warning ? 1 : c.info ? 2 : 3;
      }
      case 'vlan': return p?.vlanNumber ?? (cells.vlan ? Number.MAX_SAFE_INTEGER : null);
      case 'hosts': return p?.hosts ?? null;
      case 'ipv4': return p?.ipv4 ? p.ipv4.network * 64n + BigInt(p.ipv4.length) : cells.ipv4 || null;
      case 'ipv6': return p && p.ipv6.length ? p.ipv6[0].network * 256n + BigInt(p.ipv6[0].length) : cells.ipv6 || null;
      default: return cells[key] || null;
    }
  }

  function compareValues(a: number | bigint | string | null, b: number | bigint | string | null): number {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1; // empty last, either direction
    if (typeof a === 'string' || typeof b === 'string') {
      if (typeof a !== typeof b) return typeof a === 'string' ? 1 : -1;
      return collator.compare(String(a), String(b));
    }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function refreshTable(): void {
    const plan = store.plan;
    const names: Names = {
      sites: new Map(plan.sites.map(s => [s.id, s.name.trim() || '(unnamed site)'])),
      vrfs: new Map(plan.vrfs.map(r => [r.id, r.name.trim() || '(unnamed VRF)'])),
      namespaces: new Map(plan.namespaces.map(n => [n.id, n.name.trim() || '(unnamed namespace)'])),
    };
    const text = filterText.control.value.trim().toLowerCase();
    const site = filterSite.control.value;
    const vrf = filterVrf.control.value;
    const ns = filterNs.control.value;
    const status = filterStatus.control.value as StatusFilter;
    const present = new Set<string>();
    const visible: { v: Vlan; cells: Record<SortKey, string>; index: number }[] = [];
    plan.vlans.forEach((v, index) => {
      present.add(v.id);
      const issues = store.validation.forTarget('vlan', v.id);
      const cells = cellsFor(names, v);
      const c = severityCounts(issues);
      const sig = JSON.stringify([cells, c, v.id === selected]);
      let entry = rows.get(v.id);
      if (!entry || entry.sig !== sig) {
        const tr = buildRow(v, cells, issues);
        if (entry) entry.tr.replaceWith(tr);
        entry = { tr, sig, search: [cells.site, cells.namespace, cells.vlan, cells.name, cells.vrf, v.ipv4.network, v.ipv4.gateway, ...v.ipv6.prefixes, v.description, v.notes].join('\n').toLowerCase() };
        rows.set(v.id, entry);
      }
      if (text && !entry.search.includes(text)) return;
      if (site && v.siteId !== site) return;
      if (vrf && v.vrfId !== vrf) return;
      if (ns && v.namespaceId !== ns) return;
      if (status === 'error' && !c.error) return;
      if (status === 'warning' && !c.warning) return;
      if (status === 'problems' && !c.error && !c.warning) return;
      if (status === 'info' && !c.info) return;
      visible.push({ v, cells, index });
    });
    for (const id of [...rows.keys()]) if (!present.has(id)) {
      rows.get(id)!.tr.remove();
      rows.delete(id);
    }
    const keyed = visible.map(x => ({ ...x, key: sortValue(x.v, sortKey, x.cells) }));
    keyed.sort((a, b) => {
      const primary = a.key === null || b.key === null ? compareValues(a.key, b.key) : compareValues(a.key, b.key) * sortDir;
      if (primary) return primary;
      // Ties: site, then VLAN number, then plan order.
      const s = collator.compare(a.cells.site, b.cells.site);
      if (s) return s;
      const an = store.validation.parsed.get(a.v.id)?.vlanNumber ?? Number.MAX_SAFE_INTEGER;
      const bn = store.validation.parsed.get(b.v.id)?.vlanNumber ?? Number.MAX_SAFE_INTEGER;
      return an - bn || a.index - b.index;
    });
    shownList = keyed.map(k => k.v);
    const order = shownList.map(v => v.id);
    if (order.length !== lastOrder.length || order.some((id, i) => id !== lastOrder[i]) || tbody.children.length !== order.length) {
      tbody.replaceChildren(...order.map(id => rows.get(id)!.tr));
      lastOrder = order;
    }
    for (const c of headCells) {
      const active = c.key === sortKey;
      if (active) c.th.setAttribute('aria-sort', sortDir === 1 ? 'ascending' : 'descending');
      else c.th.removeAttribute('aria-sort');
      c.button.querySelector('.sort-mark')!.textContent = active ? (sortDir === 1 ? UP : DOWN) : '';
    }
    const total = plan.vlans.length;
    countLine.textContent = total === 0 ? '' : order.length === total ? `${plural(total, 'VLAN')}` : `Showing ${fmt(order.length)} of ${plural(total, 'VLAN')}`;
    table.hidden = total === 0 || order.length === 0;
    emptyRow.hidden = !table.hidden;
    emptyRow.textContent = total === 0 ? 'No VLANs yet. Add one, open a plan file or load the example.' : 'No VLANs match the filters.';
    csvButton.disabled = order.length === 0;
  }

  const root = h('div', { class: 'planner-tab' },
    panel('VLANs', [
      h('div', { class: 'filter-row' }, filterText.root, filterSite.root, filterVrf.root, filterNs.root, filterStatus.root),
      h('div', { class: 'toolbar table-toolbar' }, countLine),
      undoArea,
      editor,
      table,
      emptyRow,
    ], [addButton, csvButton], 'vlan-panel'),
  );

  return {
    root,
    open,
    shown: () => shownList,
    refresh(source) {
      refreshFilters();
      if (source === 'replace' && selected) {
        selected = null;
        replaceChildren(undoArea);
        undo = null;
      }
      if (selected && !vlan()) {
        selected = null;
        editor.hidden = true;
      }
      if (selected) {
        if (source === 'editor') showEditorIssues();
        else loadEditor();
      }
      refreshTable();
    },
  };
}

