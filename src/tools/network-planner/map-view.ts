/**
 * The Address map tab. A prefix is drawn as a grid of at most 256 cells; activating a cell zooms
 * into it, so any size of space is explored a level at a time and the drawing never depends on how
 * many addresses there are. The grid is one tab stop; arrow keys move between cells. Everything
 * is computed in the page.
 */
import { formatInteger } from '../../core/format';
import { FAMILY_BITS, familyName, formatPrefix, formatRange, parsePrefixText, prefixSize, prefixToRange, type Family, type IpPrefix } from '../../core/net/address';
import { coveringPrefix } from '../../core/net/ops';
import { hostCapacity } from '../../core/net/vlsm';
import { buildMapView, collectMapItems, zoomPath, type CellStatus, type MapCell, type MapItem } from '../../core/plan/addressmap';
import { button, emptyState, notice, panel, segmented, selectField, summaryTable, textField } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { plural, setOptions, statusBadge } from './common';
import type { PlanStore } from './store';

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');

export const STATUS_LABEL: Record<CellStatus, string> = {
  conflict: 'Conflict', allocated: 'Allocated', partial: 'Partly used', reserved: 'Reserved', free: 'Free',
};

export interface MapViewHandle {
  readonly root: HTMLElement;
  setActive(active: boolean): void;
  refresh(): void;
}

export function mapView(store: PlanStore, openVlan: (id: string) => void): MapViewHandle {
  let family: Family = 4;
  let active = false;
  let dirty = true;
  let root: IpPrefix | null = null;
  let view: IpPrefix | null = null;
  let selected: MapItem | null = null;
  let focusIndex = 0;
  let customRoot: IpPrefix | null = null;
  let lastItems: MapItem[] = [];

  const familyChoice = segmented({ label: 'Address family', name: 'map-family', value: '4', choices: [{ value: '4', label: 'IPv4' }, { value: '6', label: 'IPv6' }], onChange: v => {
    family = v === '6' ? 6 : 4;
    customRoot = null;
    resetRoot();
  } });
  const vrf = selectField({ id: 'map-vrf', label: 'VRF', groups: [], value: '', hint: 'Shows this VRF and any VRF that exchanges routes with it.' });
  vrf.control.addEventListener('change', () => { customRoot = null; resetRoot(); });
  const parent = selectField({ id: 'map-parent', label: 'Space to show', groups: [], value: '' });
  parent.control.addEventListener('change', () => { customRoot = null; resetRoot(false); });
  const goto = textField({ id: 'map-goto', label: 'Or show a prefix', placeholder: '10.10.0.0/16', mono: true });
  const gotoButton = button({ label: 'Show', id: 'map-goto-show', onClick: () => {
    const p = parsePrefixText(goto.control.value, family);
    if (!p.ok) {
      goto.setError(p.error.message);
      return;
    }
    goto.setError(null);
    customRoot = p.value.prefix;
    root = customRoot;
    view = customRoot;
    selected = null;
    draw();
  } });
  goto.control.addEventListener('keydown', e => { if (e.key === 'Enter') gotoButton.click(); });

  const crumbs = h('nav', { class: 'map-crumbs', 'aria-label': 'Zoom level' });
  const summary = h('p', { class: 'map-summary', id: 'map-summary' });
  const grid = h('div', { class: 'map-grid', id: 'map-grid', role: 'group' });
  const legend = h('ul', { class: 'map-legend', 'aria-label': 'Legend' }, (Object.keys(STATUS_LABEL) as CellStatus[]).map(s => h('li', null, h('span', { class: `map-swatch cell-${s}`, 'aria-hidden': 'true' }), STATUS_LABEL[s])));
  const hover = h('p', { class: 'map-hover', id: 'map-hover', 'aria-live': 'polite' });
  const details = h('div', { class: 'map-details', id: 'map-details' });
  const itemsArea = h('div', { id: 'map-items' });
  const body = h('div', { class: 'map-body' });

  grid.addEventListener('keydown', event => {
    const cells = [...grid.querySelectorAll<HTMLButtonElement>('button')];
    if (cells.length === 0) return;
    const cols = Number(grid.dataset.columns ?? '16');
    let next = focusIndex;
    if (event.key === 'ArrowRight') next = Math.min(cells.length - 1, focusIndex + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, focusIndex - 1);
    else if (event.key === 'ArrowDown') next = Math.min(cells.length - 1, focusIndex + cols);
    else if (event.key === 'ArrowUp') next = Math.max(0, focusIndex - cols);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = cells.length - 1;
    else if (event.key === 'Backspace' || (event.key === 'Escape' && view && root && view.length > root.length)) {
      event.preventDefault();
      zoomOut();
      return;
    } else return;
    event.preventDefault();
    moveFocus(cells, next);
  });

  function moveFocus(cells: HTMLButtonElement[], index: number): void {
    cells[focusIndex]?.setAttribute('tabindex', '-1');
    focusIndex = index;
    cells[index].setAttribute('tabindex', '0');
    cells[index].focus();
  }

  function rootChoices(): { value: string; label: string; prefix: IpPrefix }[] {
    const out: { value: string; label: string; prefix: IpPrefix }[] = [];
    const vrfIds = new Set([vrf.control.value]);
    for (const s of store.plan.sites) for (const b of s.blocks) {
      if (!vrfIds.has(b.vrfId)) continue;
      const p = parsePrefixText(b.network, family);
      if (p.ok && !p.value.hostBitsSet) out.push({ value: `block:${b.id}`, label: `${formatPrefix(p.value.prefix)} (${s.name.trim() || 'site'} parent block)`, prefix: p.value.prefix });
    }
    const { items } = collectMapItems(store.plan, store.validation, family, vrf.control.value);
    const nets = items.filter(i => i.kind === 'network');
    if (nets.length) {
      const cover = coveringPrefix(nets.map(i => i.range));
      out.push({ value: 'cover', label: `${formatPrefix(cover)} (smallest prefix holding every ${familyName(family)} network shown)`, prefix: cover });
    }
    return out;
  }

  function resetRoot(resetParent = true): void {
    const choices = rootChoices();
    if (resetParent || !choices.some(c => c.value === parent.control.value)) {
      setOptions(parent.control, choices.length ? choices : [{ value: '', label: 'Nothing to show' }], choices[0]?.value ?? '');
    }
    const choice = choices.find(c => c.value === parent.control.value);
    root = customRoot ?? choice?.prefix ?? null;
    view = root;
    selected = null;
    focusIndex = 0;
    draw();
  }

  function zoomOut(): void {
    if (!view || !root || view.length <= root.length) return;
    const path = zoomPath(root, view);
    view = path[path.length - 2];
    focusIndex = 0;
    draw();
    grid.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }

  function cellLabel(cell: MapCell): string {
    const size = prefixSize(cell.prefix.family, cell.prefix.length);
    const used = cell.status === 'free' ? '' : cell.status === 'allocated' ? '' : `, ${fmt(cell.used)} of ${fmt(size)} addresses used`;
    return `${formatPrefix(cell.prefix)}: ${STATUS_LABEL[cell.status]}${cell.owner ? `, ${cell.owner.label}` : ''}${used}`;
  }

  function draw(): void {
    dirty = false;
    if (!root || !view) {
      replaceChildren(body, emptyState(`No ${familyName(family)} space to show for this VRF. Add a parent block or give a VLAN a network, or enter a prefix above.`));
      return;
    }
    const { items, conflicts } = collectMapItems(store.plan, store.validation, family, vrf.control.value);
    const mv = buildMapView(view, items, conflicts);
    lastItems = items;
    const bits = FAMILY_BITS[view.family];
    grid.dataset.columns = String(mv.columns);
    grid.style.setProperty('--columns', String(mv.columns));
    grid.setAttribute('aria-label', `Address map of ${formatPrefix(view)}: ${mv.cells.length} cells of /${mv.cellLength}. Arrow keys move; Enter zooms in or selects; Backspace zooms out.`);
    if (focusIndex >= mv.cells.length) focusIndex = 0;
    const buttons = mv.cells.map((cell, i) => {
      const b = h('button', { type: 'button', class: `map-cell cell-${cell.status}${selected && overlapsItem(cell, selected) ? ' is-selected' : ''}`, tabindex: i === focusIndex ? '0' : '-1', 'aria-label': cellLabel(cell), title: cellLabel(cell), 'data-prefix': formatPrefix(cell.prefix) });
      if (cell.status === 'partial' || cell.status === 'reserved') b.style.setProperty('--fill', `${Math.max(6, Math.round(cell.fill * 100))}%`);
      b.addEventListener('click', () => activate(cell, i));
      b.addEventListener('focus', () => { hover.textContent = cellLabel(cell); });
      b.addEventListener('mouseenter', () => { hover.textContent = cellLabel(cell); });
      return b;
    });
    grid.replaceChildren(...buttons);

    const path = zoomPath(root, view);
    replaceChildren(crumbs, h('ol', null, path.map((p, i) => h('li', null, i === path.length - 1
      ? h('span', { 'aria-current': 'location', class: 'mono' }, formatPrefix(p))
      : (() => { const b = h('button', { type: 'button', class: 'link-button mono' }, formatPrefix(p)); b.addEventListener('click', () => { view = p; focusIndex = 0; draw(); }); return b; })()))));

    const vr = prefixToRange(view);
    const used = mv.cells.reduce((s, c) => s + c.used, 0n);
    const total = vr.last - vr.first + 1n;
    summary.textContent = `${formatPrefix(view)}: ${fmt(total)} addresses in ${mv.cells.length} cells of /${mv.cellLength} (${fmt(prefixSize(view.family, mv.cellLength))} each). ${fmt(used)} used (${total ? ((Number((used * 10000n) / total) / 100).toFixed(2)) : '0'}%).${mv.conflictCount ? ` ${plural(mv.conflictCount, 'cell')} with conflicts.` : ''}${mv.cellLength === bits ? ' Each cell is a single address.' : ''}`;

    replaceChildren(itemsArea,
      h('h3', { class: 'sub-title' }, `In this view: ${plural(mv.itemCount, 'network or reservation', 'networks and reservations')}`),
      mv.itemCount === 0 ? emptyState('Nothing allocated or reserved here.') : h('div', { class: 'table-scroll', role: 'region', 'aria-label': 'Networks and reservations in view', tabindex: '0' },
        h('table', { class: 'data-table', id: 'map-item-table' },
          h('caption', { class: 'visually-hidden' }, 'Networks and reservations in view'),
          h('thead', null, h('tr', null, ['Network', 'Type', 'Belongs to', 'VRF', 'Site'].map(x => h('th', { scope: 'col' }, x)))),
          h('tbody', null, mv.items.map(item => {
            const b = h('button', { type: 'button', class: 'link-button mono' }, item.prefix ? formatPrefix(item.prefix) : formatRange(item.range));
            b.addEventListener('click', () => select(item));
            return h('tr', { class: selected && sameItem(selected, item) ? 'is-selected' : undefined },
              h('td', null, b), h('td', null, item.kind === 'network' ? 'Network' : 'Reserved'), h('td', null, item.label),
              h('td', null, store.plan.vrfs.find(v => v.id === item.vrfId)?.name ?? item.vrfId), h('td', null, store.plan.sites.find(s => s.id === item.siteId)?.name ?? item.siteId));
          })),
        ),
      ),
      mv.itemCount > mv.items.length ? h('p', { class: 'source-note' }, `First ${fmt(mv.items.length)} of ${fmt(mv.itemCount)} shown; zoom in to see the rest.`) : null,
    );
    renderDetails();
    replaceChildren(body, crumbs, summary, h('div', { class: 'map-layout' }, h('div', { class: 'map-canvas' }, grid, hover, legend), details), itemsArea);
  }

  function overlapsItem(cell: MapCell, item: MapItem): boolean {
    const r = prefixToRange(cell.prefix);
    return item.range.first <= r.last && r.first <= item.range.last;
  }
  const sameItem = (a: MapItem, b: MapItem) => a.ownerId === b.ownerId && a.kind === b.kind && a.range.first === b.range.first && a.range.last === b.range.last;

  function activate(cell: MapCell, index: number): void {
    focusIndex = index;
    if (cell.owner) {
      select(cell.owner);
      return;
    }
    if (cell.prefix.length < FAMILY_BITS[cell.prefix.family]) {
      view = cell.prefix;
      focusIndex = 0;
      draw();
      grid.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
      return;
    }
    const hit = lastItems.find(i => overlapsItem(cell, i));
    if (hit) select(hit);
    else hover.textContent = `${formatPrefix(cell.prefix)} is free.`;
  }

  function select(item: MapItem): void {
    selected = item;
    draw();
    details.querySelector<HTMLElement>('h3')?.focus();
  }

  function renderDetails(): void {
    if (!selected) {
      replaceChildren(details, h('p', { class: 'empty-state' }, 'Select a network to see its details. Cells covered by one network select it; others zoom in.'));
      return;
    }
    const item = selected;
    const plan = store.plan;
    const vlan = item.ownerKind === 'vlan' ? plan.vlans.find(v => v.id === item.ownerId) : undefined;
    const rows: [string, string][] = [
      [item.kind === 'network' ? 'Network' : 'Reserved', item.prefix ? formatPrefix(item.prefix) : formatRange(item.range)],
      ['Addresses', fmt(item.range.last - item.range.first + 1n)],
      ['VRF', plan.vrfs.find(v => v.id === item.vrfId)?.name ?? item.vrfId],
      ['Site', plan.sites.find(s => s.id === item.siteId)?.name ?? item.siteId],
    ];
    if (vlan) {
      const ns = plan.namespaces.find(n => n.id === vlan.namespaceId);
      rows.push(['VLAN namespace', ns?.name ?? vlan.namespaceId]);
      if (item.kind === 'network' && item.prefix?.family === 4) {
        rows.push(['Gateway', vlan.ipv4.gateway.trim() || 'None']);
        rows.push(['Usable addresses', `${fmt(hostCapacity(item.prefix.length))}${vlan.hosts.trim() ? ` (target ${vlan.hosts.trim()})` : ''}`]);
        rows.push(['DHCP pools', vlan.ipv4.dhcp.join(', ') || 'None']);
      }
      if (item.kind === 'network' && item.prefix?.family === 6) rows.push(['Gateway', vlan.ipv6.gateway.trim() || 'None']);
    }
    const issues = vlan ? store.validation.forTarget('vlan', vlan.id) : [];
    const edit = vlan ? button({ label: 'Edit VLAN', id: 'map-edit-vlan', onClick: () => openVlan(vlan.id) }) : null;
    replaceChildren(details,
      h('h3', { class: 'sub-title', tabindex: '-1', id: 'map-details-title' }, item.label),
      vlan ? h('p', null, statusBadge(issues)) : null,
      summaryTable('Selected network', rows),
      issues.filter(i => i.severity !== 'info').slice(0, 5).map(i => notice(i.severity === 'error' ? 'error' : 'warning', i.message)),
      edit,
    );
  }

  const rootEl = h('div', { class: 'planner-tab' },
    panel('Address map', [
      h('div', { class: 'filter-row' }, familyChoice.root, vrf.root, parent.root, h('div', { class: 'goto-field' }, goto.root, gotoButton)),
      body,
    ], undefined, 'map-panel'),
  );

  function syncVrfs(): void {
    const vrfs = store.plan.vrfs;
    setOptions(vrf.control, vrfs.length ? vrfs.map(v => ({ value: v.id, label: v.name.trim() || '(unnamed VRF)' })) : [{ value: '', label: 'No VRFs' }], vrfs.some(v => v.id === vrf.control.value) ? vrf.control.value : vrfs[0]?.id ?? '');
  }

  return {
    root: rootEl,
    setActive(on) {
      active = on;
      if (on && dirty) {
        syncVrfs();
        if (!root) resetRoot();
        else {
          const choices = rootChoices();
          setOptions(parent.control, choices.length ? choices : [{ value: '', label: 'Nothing to show' }], choices.some(c => c.value === parent.control.value) ? parent.control.value : choices[0]?.value ?? '');
          if (selected && !collectMapItems(store.plan, store.validation, family, vrf.control.value).items.some(i => sameItem(i, selected!))) selected = null;
          draw();
        }
      }
    },
    refresh() {
      dirty = true;
      if (active) this.setActive(true);
    },
  };
}
