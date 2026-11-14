/**
 * The Allocate tab. Allocation is always previewed first. Applying writes the preview into the
 * plan; replacing a network that already exists needs a separate, explicit confirmation, and a
 * preview made before the plan changed cannot be applied.
 */
import { formatInteger } from '../../core/format';
import { parsePrefixText, formatPrefix, prefixSize, prefixToRange, rangeSize, type Family } from '../../core/net/address';
import { applyAllocation, previewAllocation, type AllocationPreview } from '../../core/plan/allocate';
import { vrfsForSite } from '../../core/plan/model';
import { button, checkbox, dataTable, emptyState, notice, panel, segmented, selectField, summaryTable, textArea, textField } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { plural, setOptions } from './common';
import type { ChangeSource, PlanStore } from './store';

const fmt = (n: bigint | number) => formatInteger(n, 'en-US');

export interface AllocateView {
  readonly root: HTMLElement;
  refresh(source: ChangeSource): void;
}

export function allocateView(store: PlanStore, announce: (m: string) => void, openVlan: (id: string) => void): AllocateView {
  let family: Family = 4;
  let preview: AllocationPreview | null = null;
  let previewRevision = -1;
  let parentsTouched = false;

  const familyChoice = segmented({ label: 'Address family', name: 'alloc-family', value: '4', choices: [{ value: '4', label: 'IPv4' }, { value: '6', label: 'IPv6' }], onChange: v => {
    family = v === '6' ? 6 : 4;
    parentsTouched = false;
    syncOptions();
    fillParents();
    clearPreview();
  } });
  const site = selectField({ id: 'alloc-site', label: 'Site', groups: [], value: '' });
  const vrf = selectField({ id: 'alloc-vrf', label: 'VRF', groups: [], value: '' });
  const parents = textArea({ id: 'alloc-parents', label: 'Parent networks', rows: 3, mono: true, placeholder: '10.40.0.0/16', hint: 'One per line, used in order: what does not fit in the first goes into the next. Filled from the site\'s parent blocks for this VRF.' });
  parents.control.classList.add('textarea-short');
  parents.control.addEventListener('input', () => { parentsTouched = true; clearPreview(); });
  const useBlocks = button({ label: 'Use the site\'s parent blocks', variant: 'ghost', id: 'alloc-use-blocks', onClick: () => { parentsTouched = false; fillParents(); clearPreview(); } });
  site.control.addEventListener('change', () => { syncOptions(); parentsTouched = false; fillParents(); clearPreview(); });
  vrf.control.addEventListener('change', () => { parentsTouched = false; fillParents(); clearPreview(); });

  const p2p = checkbox({ id: 'alloc-p2p', label: 'Use /31 for 2-address and /32 for 1-address targets (RFC 3021)', onChange: () => clearPreview() });
  const gateway = checkbox({ id: 'alloc-gateway', label: 'Give each newly allocated VLAN without a gateway the first usable address', checked: true, onChange: () => clearPreview() });
  const childLength = textField({ id: 'alloc-child', label: 'Prefix length per VLAN', value: '64', mono: true, hint: 'A /64 per VLAN is the norm for LANs.' });
  const perVlan = textField({ id: 'alloc-per-vlan', label: 'Prefixes per VLAN', value: '1', mono: true });
  for (const f of [childLength, perVlan]) f.control.addEventListener('input', () => clearPreview());
  const reallocate = checkbox({ id: 'alloc-reallocate', label: 'Also reassign VLANs that already have networks (except those marked fixed)', onChange: () => clearPreview() });
  const v4Options = h('div', { class: 'option-stack' }, p2p.root, gateway.root);
  const v6Options = h('div', { class: 'editor-grid' }, childLength.root, perVlan.root);

  const previewButton = button({ label: 'Preview allocation', variant: 'primary', id: 'alloc-preview', onClick: () => runPreview() });
  const result = h('div', { class: 'result-area', id: 'alloc-result' });

  function syncOptions(): void {
    const plan = store.plan;
    setOptions(site.control, plan.sites.map(s => ({ value: s.id, label: s.name.trim() || '(unnamed site)' })), plan.sites.some(s => s.id === site.control.value) ? site.control.value : plan.sites[0]?.id ?? '');
    const vrfs = vrfsForSite(plan, site.control.value);
    setOptions(vrf.control, vrfs.map(r => ({ value: r.id, label: r.name.trim() || '(unnamed VRF)' })), vrfs.some(r => r.id === vrf.control.value) ? vrf.control.value : vrfs[0]?.id ?? '');
    v4Options.hidden = family !== 4;
    v6Options.hidden = family !== 6;
  }

  function fillParents(): void {
    if (parentsTouched) return;
    const s = store.plan.sites.find(x => x.id === site.control.value);
    const blocks = (s?.blocks ?? []).filter(b => b.vrfId === vrf.control.value).filter(b => {
      const p = parsePrefixText(b.network);
      return p.ok && p.value.prefix.family === family;
    });
    parents.control.value = blocks.map(b => b.network.trim()).join('\n');
  }

  function clearPreview(): void {
    preview = null;
    replaceChildren(result, emptyState('Choose the scope and parent networks, then preview. Nothing changes until you apply.'));
  }

  function runPreview(): void {
    store.flush();
    const child = Number(childLength.control.value.trim());
    const per = Number(perVlan.control.value.trim());
    preview = previewAllocation(store.plan, store.validation, {
      family, siteId: site.control.value, vrfId: vrf.control.value, parents: parents.control.value.split(/\r\n|\r|\n/),
      reallocate: reallocate.input.checked, pointToPoint: p2p.input.checked, setGateway: gateway.input.checked,
      childLength: /^[0-9]{1,3}$/.test(childLength.control.value.trim()) ? child : Number.NaN, perVlan: /^[0-9]{1,6}$/.test(perVlan.control.value.trim()) ? per : Number.NaN,
    });
    previewRevision = store.revision;
    render();
    announce(preview.errors.length ? 'The allocation could not be previewed.' : `Preview: ${plural(preview.changes.filter(c => c.kind !== 'unchanged').length, 'VLAN')} would change, ${preview.failures.length} would not fit.`);
  }

  function render(): void {
    if (!preview) return clearPreview();
    const pv = preview;
    if (pv.errors.length) {
      replaceChildren(result, notice('error', h('p', null, h('strong', null, 'Cannot allocate:')), h('ul', { class: 'problem-list' }, pv.errors.map(e => h('li', null, e)))));
      return;
    }
    const pending = pv.changes.filter(c => c.kind !== 'unchanged');
    const stale = previewRevision !== store.revision;
    const confirm = checkbox({ id: 'alloc-confirm', label: `Replace ${plural(pv.overwrites, 'existing network')} as shown`, onChange: () => { apply.disabled = !canApply(); } });
    const apply = button({ label: `Apply to ${plural(pending.length, 'VLAN')}`, variant: 'primary', id: 'alloc-apply', onClick: () => doApply(confirm.input.checked) });
    const canApply = () => !stale && pending.length > 0 && (pv.overwrites === 0 || confirm.input.checked);
    apply.disabled = !canApply();
    const nameLink = (id: string, label: string) => {
      const b = h('button', { type: 'button', class: 'link-button' }, label);
      b.addEventListener('click', () => openVlan(id));
      return b;
    };
    const freeTotal = pv.free.reduce((s, p) => s + rangeSize(prefixToRange(p)), 0n);
    replaceChildren(result,
      stale ? notice('warning', 'The plan changed after this preview. Preview again before applying.') : null,
      pv.failures.length ? notice('error', h('p', null, h('strong', null, `${plural(pv.failures.length, 'VLAN')} could not be allocated.`)), h('ul', { class: 'problem-list' }, pv.failures.map(f => h('li', null, h('strong', null, `${f.label}: `), f.message)))) : null,
      pending.length === 0 && pv.failures.length === 0 ? notice('info', 'Nothing to allocate: every VLAN in this scope already has what it needs, or has no host target.') : null,
      pv.changes.length ? h('div', { class: 'table-scroll', role: 'region', 'aria-label': 'Proposed changes', tabindex: '0' },
        h('table', { class: 'data-table', id: 'alloc-changes' },
          h('caption', { class: 'visually-hidden' }, 'Proposed changes'),
          h('thead', null, h('tr', null, ['VLAN', 'Change', 'Before', 'After', 'Gateway', 'Also moved'].map(x => h('th', { scope: 'col' }, x)))),
          h('tbody', null, pv.changes.map(c => h('tr', { class: c.kind === 'changed' ? 'row-warning' : undefined },
            h('td', null, nameLink(c.vlanId, c.label)),
            h('td', null, c.kind === 'new' ? 'New' : c.kind === 'changed' ? 'Replaces existing' : 'Unchanged'),
            h('td', { class: 'mono' }, c.before.join(', ') || '-'),
            h('td', { class: 'mono' }, c.after.join(', ')),
            h('td', { class: 'mono' }, c.gateway ?? ''),
            h('td', { class: 'mono' }, [...c.moves.filter(m => m.field !== 'ipv4.gateway' && m.field !== 'ipv6.gateway').map(m => `${m.from} to ${m.to}`), ...c.stranded.map(s => `left: ${s}`)].join('; ')),
          ))),
        ),
      ) : null,
      pv.overwrites > 0 ? notice('warning', h('p', null, `${plural(pv.overwrites, 'VLAN')} already ${pv.overwrites === 1 ? 'has a network' : 'have networks'} that this replaces. Gateways, DHCP pools and reservations inside the old network move to the same offset in the new one when they fit; anything that does not fit is left as it was and will show as an error.`), confirm.root) : null,
      pending.length ? h('div', { class: 'toolbar' }, apply) : null,
      h('h3', { class: 'sub-title' }, 'Space after allocation'),
      summaryTable('Space after allocation', [
        ['Parent networks', pv.parents.map(formatPrefix).join(', ')],
        ['Free addresses', fmt(freeTotal)],
        ...(pv.freeChildrenAfter !== null ? [[`Free /${pv.options.childLength ?? 64} prefixes`, `${fmt(pv.freeChildrenAfter)} of ${fmt(pv.freeChildrenBefore!)} before`] as [string, string]] : []),
        ['Free blocks', pv.free.length ? `${fmt(pv.free.length)} (largest ${formatPrefix([...pv.free].sort((a, b) => a.length - b.length)[0])})` : 'None'],
      ]),
      pv.free.length ? dataTable('Free blocks', [{ key: 'block', label: 'Free block', mono: true }, { key: 'size', label: 'Addresses', numeric: true }],
        pv.free.slice(0, 200).map(p => ({ block: formatPrefix(p), size: fmt(prefixSize(p.family, p.length)) })), 'alloc-free') : null,
      pv.free.length > 200 ? h('p', { class: 'source-note' }, `First 200 of ${fmt(pv.free.length)} free blocks shown.`) : null,
      pv.skipped.length ? h('details', { class: 'skipped' }, h('summary', null, `${plural(pv.skipped.length, 'VLAN')} in scope left as they are`), h('ul', { class: 'problem-list', id: 'alloc-skipped' }, pv.skipped.map(s => h('li', null, h('strong', null, `${s.label}: `), s.message)))) : null,
      h('p', { class: 'source-note' }, family === 4
        ? 'Placement uses the VLSM Allocator: largest network first (equal sizes by host target, then plan order), each at the lowest free aligned address of the first parent that has room.'
        : 'Placement: VLANs in plan order, each getting all its prefixes or none, at the lowest free aligned prefixes of the first parent that has room.'),
    );
  }

  function doApply(confirmed: boolean): void {
    if (!preview) return;
    const r = applyAllocation(store.plan, preview, confirmed);
    if (!r.ok) {
      replaceChildren(result, notice('error', r.error.message));
      return;
    }
    const n = preview.changes.filter(c => c.kind !== 'unchanged').length;
    preview = null;
    store.replace(r.value, 'allocate');
    replaceChildren(result, notice('ok', `Applied: ${plural(n, 'VLAN')} updated. Review them in the VLANs tab; save the plan to keep the change.`));
    announce(`Allocation applied to ${plural(n, 'VLAN')}.`);
  }

  const root = h('div', { class: 'planner-tab' },
    panel('Automatic allocation', [
      h('p', { class: 'hint' }, 'Fills VLANs of one site and VRF from parent networks. IPv4 sizes each network from the VLAN\'s host target; IPv6 gives each VLAN a fixed number of equal prefixes. Networks already used anywhere in the VRF, or in a VRF it exchanges routes with, are left alone.'),
      familyChoice.root,
      h('div', { class: 'editor-grid' }, site.root, vrf.root),
      parents.root,
      h('div', { class: 'toolbar' }, useBlocks),
      v4Options, v6Options,
      reallocate.root,
      h('div', { class: 'toolbar' }, previewButton),
    ]),
    panel('Preview', [result], undefined, 'result-panel'),
  );
  syncOptions();
  fillParents();
  clearPreview();

  return {
    root,
    refresh(source) {
      syncOptions();
      if (source === 'replace') {
        parentsTouched = false;
        fillParents();
        clearPreview();
      } else if (preview && previewRevision !== store.revision && source !== 'allocate') render();
    },
  };
}
