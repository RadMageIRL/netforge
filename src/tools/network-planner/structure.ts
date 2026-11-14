/**
 * The Sites, VRFs and namespaces tab. Each list has its own editor. Something still in use (a site
 * with VLANs, a VRF with networks) cannot be deleted until its users are moved or deleted, so a
 * delete never leaves references pointing nowhere.
 */
import { nextId, usage, vrfsForSite, type ParentBlock, type Plan, type Site, type VlanNamespace, type Vrf } from '../../core/plan/model';
import type { TargetKind } from '../../core/plan/validate';
import { button, checkbox, notice, panel, selectField, textArea, textField, type FieldHandle } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { fieldIssues, linesToReserved, plural, reservedToLines, setOptions, statusBadge } from './common';
import type { ChangeSource, PlanStore } from './store';

export interface StructureView {
  readonly root: HTMLElement;
  open(kind: TargetKind, id: string, field?: string | null, siteId?: string): void;
  refresh(source: ChangeSource): void;
}

type Kind = 'site' | 'vrf' | 'namespace';

export function structureView(store: PlanStore, announce: (m: string) => void): StructureView {
  const editing: Record<Kind, string | null> = { site: null, vrf: null, namespace: null };
  const messages: Record<Kind, HTMLElement> = { site: h('div', { class: 'undo-area' }), vrf: h('div', { class: 'undo-area' }), namespace: h('div', { class: 'undo-area' }) };
  const siteName = (id: string) => store.plan.sites.find(s => s.id === id)?.name.trim() || '(unnamed site)';
  const edit = (mutate: (p: Plan) => void, source: ChangeSource = 'editor') => store.change(source, mutate);
  const siteOptions = (allLabel: string) => [{ value: '', label: allLabel }, ...store.plan.sites.map(s => ({ value: s.id, label: s.name.trim() || '(unnamed site)' }))];

  // ---- Lists -----------------------------------------------------------------------------------
  function listTable(kind: Kind, caption: string, headers: string[], rows: { id: string; cells: (string | HTMLElement)[]; name: string; issues: ReturnType<typeof store.validation.forTarget> }[]): HTMLElement {
    if (rows.length === 0) return h('p', { class: 'empty-state' }, `No ${caption.toLowerCase()} yet.`);
    return h('div', { class: 'table-scroll', role: 'region', 'aria-label': `${caption} table`, tabindex: '0' },
      h('table', { class: 'data-table', id: `${kind}-table` },
        h('caption', { class: 'visually-hidden' }, caption),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Name'), headers.map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', null, rows.map(r => {
          const b = h('button', { type: 'button', class: 'link-button' }, r.name || '(unnamed)');
          b.addEventListener('click', () => open(kind, r.id));
          return h('tr', { 'data-id': r.id, class: editing[kind] === r.id ? 'is-selected' : undefined }, h('td', { class: 'status-cell' }, statusBadge(r.issues)), h('td', null, b), r.cells.map(c => h('td', null, c)));
        })),
      ),
    );
  }

  const siteList = h('div');
  const vrfList = h('div');
  const nsList = h('div');

  // ---- Site editor -----------------------------------------------------------------------------
  const siteFields = {
    name: textField({ id: 'site-edit-name', label: 'Site name', placeholder: 'Headquarters' }),
    description: textField({ id: 'site-edit-description', label: 'Description' }),
    notes: textArea({ id: 'site-edit-notes', label: 'Notes', rows: 2 }),
  };
  siteFields.notes.control.classList.add('textarea-short');
  siteFields.notes.control.setAttribute('wrap', 'soft');
  const blockArea = h('div', { class: 'block-list', id: 'site-blocks' });
  const blockFields = new Map<string, { network: FieldHandle<HTMLInputElement>; vrf: FieldHandle<HTMLSelectElement>; reserved: FieldHandle<HTMLTextAreaElement>; root: HTMLElement }>();
  const site = () => store.plan.sites.find(s => s.id === editing.site) ?? null;
  siteFields.name.control.addEventListener('input', () => edit(p => {
    const s = p.sites.find(x => x.id === editing.site);
    if (!s) return;
    // A namespace created with the site follows its name while it still has the generated name.
    for (const n of p.namespaces) if (n.siteId === s.id && n.name === `${s.name} switches`) n.name = `${siteFields.name.control.value} switches`;
    s.name = siteFields.name.control.value;
  }));
  siteFields.description.control.addEventListener('input', () => edit(() => { const s = site(); if (s) s.description = siteFields.description.control.value; }));
  siteFields.notes.control.addEventListener('input', () => edit(() => { const s = site(); if (s) s.notes = siteFields.notes.control.value; }));
  const addBlock = button({ label: 'Add parent block', icon: 'plus', id: 'site-add-block', onClick: () => {
    const s = site();
    if (!s) return;
    const id = nextId('b', store.plan.sites.flatMap(x => x.blocks));
    edit(() => { s.blocks.push({ id, network: '', vrfId: vrfsForSite(store.plan, s.id)[0]?.id ?? '', description: '', reserved: [] }); }, 'other');
    loadSite();
    blockFields.get(id)?.network.control.focus();
  } });

  function blockEditor(s: Site, b: ParentBlock, index: number): HTMLElement {
    const label = `parent block ${index + 1}`;
    const network = textField({ id: `block-${b.id}-network`, label: 'Network', placeholder: '10.40.0.0/16 or 2001:db8:40::/48', mono: true });
    network.control.value = b.network;
    network.control.addEventListener('input', () => edit(() => { b.network = network.control.value; }));
    const vrf = selectField({ id: `block-${b.id}-vrf`, label: 'VRF', groups: [], value: '' });
    setOptions(vrf.control, vrfsForSite(store.plan, s.id).map(r => ({ value: r.id, label: r.name.trim() || '(unnamed VRF)' })), b.vrfId);
    vrf.control.addEventListener('change', () => edit(() => { b.vrfId = vrf.control.value; }));
    const description = textField({ id: `block-${b.id}-description`, label: 'Description' });
    description.control.value = b.description;
    description.control.addEventListener('input', () => edit(() => { b.description = description.control.value; }));
    const reserved = textArea({ id: `block-${b.id}-reserved`, label: 'Reserved for allocation', rows: 2, mono: true, placeholder: '10.40.255.0/24 # future links', hint: 'Space automatic allocation must leave alone. One per line, label after #.' });
    reserved.control.classList.add('textarea-short');
    reserved.control.value = reservedToLines(b.reserved);
    reserved.control.addEventListener('input', () => edit(() => { b.reserved = linesToReserved(reserved.control.value); }));
    const removeButton = button({ label: `Remove ${label}`, icon: 'close', iconOnly: true, variant: 'ghost', onClick: () => {
      edit(() => { s.blocks = s.blocks.filter(x => x !== b); }, 'other');
      loadSite();
      addBlock.focus();
    } });
    const root = h('fieldset', { class: 'block-editor', 'data-block': b.id }, h('legend', { class: 'editor-legend' }, `Parent block ${index + 1}`),
      h('div', { class: 'editor-grid' }, network.root, vrf.root, description.root, reserved.root), h('div', { class: 'block-remove' }, removeButton));
    blockFields.set(b.id, { network, vrf, reserved, root });
    return root;
  }

  const deleteSite = button({ label: 'Delete site', id: 'site-delete', onClick: () => {
    const s = site();
    if (!s) return;
    const plan = store.plan;
    const vlans = plan.vlans.filter(v => v.siteId === s.id).length;
    const vrfs = plan.vrfs.filter(v => v.siteId === s.id).length;
    const nss = plan.namespaces.filter(n => n.siteId === s.id && !(n.name === `${s.name} switches` && !plan.vlans.some(v => v.namespaceId === n.id)));
    if (vlans || vrfs || nss.length) {
      replaceChildren(messages.site, notice('warning', `"${s.name.trim() || 'This site'}" is still used by ${[vlans ? plural(vlans, 'VLAN') : '', vrfs ? plural(vrfs, 'VRF') : '', nss.length ? plural(nss.length, 'VLAN namespace') : ''].filter(Boolean).join(', ')}. Move or delete them first.`));
      return;
    }
    edit(p => {
      p.namespaces = p.namespaces.filter(n => n.siteId !== s.id);
      p.sites = p.sites.filter(x => x.id !== s.id);
    }, 'structure');
    editing.site = null;
    replaceChildren(messages.site, notice('info', `Deleted site "${s.name.trim() || '(unnamed)'}".`));
    announce('Site deleted.');
    render();
  } });
  const siteDone = button({ label: 'Done', variant: 'ghost', onClick: () => closeEditor('site') });
  const siteEditor = h('section', { class: 'vlan-editor', id: 'site-editor', hidden: true, 'aria-label': 'Site details' },
    h('div', { class: 'editor-head' }, h('h3', { class: 'editor-title', id: 'site-editor-title' }, 'Site'), h('div', { class: 'toolbar' }, deleteSite, siteDone)),
    h('div', { class: 'editor-grid' }, siteFields.name.root, siteFields.description.root, siteFields.notes.root),
    h('h4', { class: 'sub-title' }, 'Parent blocks'),
    h('p', { class: 'hint' }, 'Optional. When a site has blocks for a VRF, its VLAN networks in that VRF must be inside them, and allocation fills them in order.'),
    blockArea,
    h('div', { class: 'toolbar' }, addBlock),
  );

  function loadSite(): void {
    const s = site();
    siteEditor.hidden = !s;
    if (!s) return;
    siteFields.name.control.value = s.name;
    siteFields.description.control.value = s.description;
    siteFields.notes.control.value = s.notes;
    blockFields.clear();
    replaceChildren(blockArea, s.blocks.length ? s.blocks.map((b, i) => blockEditor(s, b, i)) : h('p', { class: 'empty-state' }, 'No parent blocks.'));
    showSiteIssues();
  }

  function showSiteIssues(): void {
    const s = site();
    if (!s) return;
    const issues = store.validation.forTarget('site', s.id);
    fieldIssues(siteFields.name, issues.filter(i => i.field === 'name'));
    for (const b of s.blocks) {
      const fields = blockFields.get(b.id);
      if (!fields) continue;
      const bi = store.validation.forTarget('block', b.id);
      fieldIssues(fields.network, bi.filter(i => i.field === 'network'));
      fieldIssues(fields.vrf, bi.filter(i => i.field === 'vrfId'));
      fieldIssues(fields.reserved, bi.filter(i => i.field === 'reserved'));
    }
    replaceChildren(siteEditor.querySelector('#site-editor-title')!, s.name.trim() || 'New site');
  }

  // ---- VRF editor --------------------------------------------------------------------------------
  const vrfFields = {
    name: textField({ id: 'vrf-edit-name', label: 'VRF name', placeholder: 'Guest' }),
    site: selectField({ id: 'vrf-edit-site', label: 'Available at', groups: [], value: '', hint: 'A VRF at one site, or one that spans every site (such as the global table).' }),
    description: textField({ id: 'vrf-edit-description', label: 'Description' }),
    notes: textArea({ id: 'vrf-edit-notes', label: 'Notes', rows: 2 }),
  };
  vrfFields.notes.control.classList.add('textarea-short');
  vrfFields.notes.control.setAttribute('wrap', 'soft');
  const exchangeArea = h('div', { class: 'check-list', id: 'vrf-exchange' });
  const exchangeHint = h('p', { class: 'hint', id: 'vrf-exchange-hint' }, 'Networks in VRFs that exchange routes (route leaking, shared services) must not overlap. VRFs that do not may reuse the same networks.');
  const vrf = () => store.plan.vrfs.find(v => v.id === editing.vrf) ?? null;
  vrfFields.name.control.addEventListener('input', () => edit(() => { const v = vrf(); if (v) v.name = vrfFields.name.control.value; }));
  vrfFields.site.control.addEventListener('change', () => edit(() => { const v = vrf(); if (v) v.siteId = vrfFields.site.control.value; }));
  vrfFields.description.control.addEventListener('input', () => edit(() => { const v = vrf(); if (v) v.description = vrfFields.description.control.value; }));
  vrfFields.notes.control.addEventListener('input', () => edit(() => { const v = vrf(); if (v) v.notes = vrfFields.notes.control.value; }));
  const deleteVrf = button({ label: 'Delete VRF', id: 'vrf-delete', onClick: () => {
    const v = vrf();
    if (!v) return;
    const u = usage(store.plan).vrfs.get(v.id) ?? 0;
    if (u) {
      replaceChildren(messages.vrf, notice('warning', `VRF "${v.name.trim() || '(unnamed)'}" is still used by ${plural(u, 'VLAN or parent block', 'VLANs and parent blocks')}. Move or delete them first.`));
      return;
    }
    edit(p => {
      p.vrfs = p.vrfs.filter(x => x.id !== v.id);
      for (const o of p.vrfs) o.exchangesWith = o.exchangesWith.filter(id => id !== v.id);
    }, 'structure');
    editing.vrf = null;
    replaceChildren(messages.vrf, notice('info', `Deleted VRF "${v.name.trim() || '(unnamed)'}".`));
    announce('VRF deleted.');
    render();
  } });
  const vrfEditor = h('section', { class: 'vlan-editor', id: 'vrf-editor', hidden: true, 'aria-label': 'VRF details' },
    h('div', { class: 'editor-head' }, h('h3', { class: 'editor-title', id: 'vrf-editor-title' }, 'VRF'), h('div', { class: 'toolbar' }, deleteVrf, button({ label: 'Done', variant: 'ghost', onClick: () => closeEditor('vrf') }))),
    h('div', { class: 'editor-grid' }, vrfFields.name.root, vrfFields.site.root, vrfFields.description.root, vrfFields.notes.root),
    h('fieldset', { class: 'editor-group', 'aria-describedby': 'vrf-exchange-hint' }, h('legend', { class: 'editor-legend' }, 'Exchanges routes with'), exchangeHint, exchangeArea),
  );

  function loadVrf(): void {
    const v = vrf();
    vrfEditor.hidden = !v;
    if (!v) return;
    vrfFields.name.control.value = v.name;
    vrfFields.description.control.value = v.description;
    vrfFields.notes.control.value = v.notes;
    setOptions(vrfFields.site.control, siteOptions('Every site'), v.siteId);
    const others = store.plan.vrfs.filter(o => o.id !== v.id);
    replaceChildren(exchangeArea, others.length === 0 ? h('p', { class: 'empty-state' }, 'There are no other VRFs.') : others.map(o => {
      const linked = v.exchangesWith.includes(o.id) || o.exchangesWith.includes(v.id);
      const box = checkbox({ id: `vrf-exchange-${o.id}`, label: o.name.trim() || '(unnamed VRF)', checked: linked, onChange: checked => {
        edit(() => {
          v.exchangesWith = v.exchangesWith.filter(id => id !== o.id);
          o.exchangesWith = o.exchangesWith.filter(id => id !== v.id);
          if (checked) v.exchangesWith.push(o.id);
        });
      } });
      return box.root;
    }));
    showVrfIssues();
  }

  function showVrfIssues(): void {
    const v = vrf();
    if (!v) return;
    const issues = store.validation.forTarget('vrf', v.id);
    fieldIssues(vrfFields.name, issues.filter(i => i.field === 'name'));
    fieldIssues(vrfFields.site, issues.filter(i => i.field === 'siteId'));
    replaceChildren(vrfEditor.querySelector('#vrf-editor-title')!, v.name.trim() || 'New VRF');
  }

  // ---- Namespace editor ---------------------------------------------------------------------------
  const nsFields = {
    name: textField({ id: 'namespace-edit-name', label: 'Namespace name', placeholder: 'HQ switches' }),
    site: selectField({ id: 'namespace-edit-site', label: 'Belongs to', groups: [], value: '', hint: 'One site, or every site for a layer 2 domain stretched across sites.' }),
    description: textField({ id: 'namespace-edit-description', label: 'Description' }),
  };
  const ns = () => store.plan.namespaces.find(n => n.id === editing.namespace) ?? null;
  nsFields.name.control.addEventListener('input', () => edit(() => { const n = ns(); if (n) n.name = nsFields.name.control.value; }));
  nsFields.site.control.addEventListener('change', () => edit(() => { const n = ns(); if (n) n.siteId = nsFields.site.control.value; }));
  nsFields.description.control.addEventListener('input', () => edit(() => { const n = ns(); if (n) n.description = nsFields.description.control.value; }));
  const deleteNs = button({ label: 'Delete namespace', id: 'namespace-delete', onClick: () => {
    const n = ns();
    if (!n) return;
    const u = usage(store.plan).namespaces.get(n.id) ?? 0;
    if (u) {
      replaceChildren(messages.namespace, notice('warning', `Namespace "${n.name.trim() || '(unnamed)'}" is still used by ${plural(u, 'VLAN')}. Move or delete them first.`));
      return;
    }
    edit(p => { p.namespaces = p.namespaces.filter(x => x.id !== n.id); }, 'structure');
    editing.namespace = null;
    replaceChildren(messages.namespace, notice('info', `Deleted namespace "${n.name.trim() || '(unnamed)'}".`));
    announce('Namespace deleted.');
    render();
  } });
  const nsEditor = h('section', { class: 'vlan-editor', id: 'namespace-editor', hidden: true, 'aria-label': 'Namespace details' },
    h('div', { class: 'editor-head' }, h('h3', { class: 'editor-title', id: 'namespace-editor-title' }, 'Namespace'), h('div', { class: 'toolbar' }, deleteNs, button({ label: 'Done', variant: 'ghost', onClick: () => closeEditor('namespace') }))),
    h('div', { class: 'editor-grid' }, nsFields.name.root, nsFields.site.root, nsFields.description.root),
  );

  function loadNs(): void {
    const n = ns();
    nsEditor.hidden = !n;
    if (!n) return;
    nsFields.name.control.value = n.name;
    nsFields.description.control.value = n.description;
    setOptions(nsFields.site.control, siteOptions('Every site (stretched)'), n.siteId);
    showNsIssues();
  }

  function showNsIssues(): void {
    const n = ns();
    if (!n) return;
    const issues = store.validation.forTarget('namespace', n.id);
    fieldIssues(nsFields.name, issues.filter(i => i.field === 'name'));
    fieldIssues(nsFields.site, issues.filter(i => i.field === 'siteId'));
    replaceChildren(nsEditor.querySelector('#namespace-editor-title')!, n.name.trim() || 'New namespace');
  }

  // ---- Adding ------------------------------------------------------------------------------------
  const addSite = button({ label: 'Add site', icon: 'plus', id: 'site-add', variant: 'primary', onClick: () => {
    const plan = store.plan;
    const id = nextId('s', plan.sites);
    let n = plan.sites.length + 1;
    while (plan.sites.some(s => s.name === `Site ${n}`)) n++;
    const name = `Site ${n}`;
    const nsId = nextId('n', plan.namespaces);
    edit(p => {
      p.sites.push({ id, name, description: '', notes: '', blocks: [] });
      p.namespaces.push({ id: nsId, name: `${name} switches`, siteId: id, description: '' });
    }, 'structure');
    open('site', id);
    replaceChildren(messages.site, notice('info', `Added "${name}" with its own VLAN namespace, "${name} switches".`));
  } });
  const addVrf = button({ label: 'Add VRF', icon: 'plus', id: 'vrf-add', onClick: () => {
    const id = nextId('r', store.plan.vrfs);
    edit(p => { p.vrfs.push({ id, name: `VRF ${p.vrfs.length + 1}`, siteId: '', exchangesWith: [], description: '', notes: '' }); }, 'structure');
    open('vrf', id);
  } });
  const addNs = button({ label: 'Add namespace', icon: 'plus', id: 'namespace-add', onClick: () => {
    const id = nextId('n', store.plan.namespaces);
    edit(p => { p.namespaces.push({ id, name: `Namespace ${p.namespaces.length + 1}`, siteId: p.sites[0]?.id ?? '', description: '' }); }, 'structure');
    open('namespace', id);
  } });

  function closeEditor(kind: Kind): void {
    const id = editing[kind];
    editing[kind] = null;
    render();
    if (id) document.querySelector<HTMLButtonElement>(`#${kind}-table tr[data-id="${CSS.escape(id)}"] button`)?.focus();
  }

  function render(): void {
    const plan = store.plan;
    const u = usage(plan);
    replaceChildren(siteList, listTable('site', 'Sites', ['Parent blocks', 'VLANs', 'Description'], plan.sites.map(s => ({
      id: s.id, name: s.name.trim(), issues: [...store.validation.forTarget('site', s.id), ...s.blocks.flatMap(b => store.validation.forTarget('block', b.id))],
      cells: [s.blocks.length ? h('span', { class: 'mono' }, s.blocks.map(b => b.network.trim() || '(empty)').join(', ')) : 'None', String(plan.vlans.filter(v => v.siteId === s.id).length), s.description],
    }))));
    replaceChildren(vrfList, listTable('vrf', 'VRFs', ['Available at', 'Exchanges routes with', 'Used by', 'Description'], plan.vrfs.map((v: Vrf) => {
      const links = plan.vrfs.filter(o => o.id !== v.id && (v.exchangesWith.includes(o.id) || o.exchangesWith.includes(v.id))).map(o => o.name.trim() || '(unnamed)');
      return { id: v.id, name: v.name.trim(), issues: store.validation.forTarget('vrf', v.id), cells: [v.siteId ? siteName(v.siteId) : 'Every site', links.join(', ') || 'None (independent)', String(u.vrfs.get(v.id) ?? 0), v.description] };
    })));
    replaceChildren(nsList, listTable('namespace', 'VLAN namespaces', ['Belongs to', 'VLANs', 'Description'], plan.namespaces.map((n: VlanNamespace) => ({
      id: n.id, name: n.name.trim(), issues: store.validation.forTarget('namespace', n.id), cells: [n.siteId ? siteName(n.siteId) : 'Every site (stretched)', String(u.namespaces.get(n.id) ?? 0), n.description],
    }))));
    for (const k of ['site', 'vrf', 'namespace'] as const) if (editing[k] && !lookup(k, editing[k]!)) editing[k] = null;
  }

  function lookup(kind: Kind, id: string): boolean {
    const plan = store.plan;
    return kind === 'site' ? plan.sites.some(s => s.id === id) : kind === 'vrf' ? plan.vrfs.some(v => v.id === id) : plan.namespaces.some(n => n.id === id);
  }

  function open(kind: TargetKind, id: string, field: string | null = null, siteId?: string): void {
    const k: Kind = kind === 'block' ? 'site' : (kind as Kind);
    editing[k] = kind === 'block' ? (siteId ?? null) : id;
    replaceChildren(messages[k]);
    render();
    if (k === 'site') loadSite();
    if (k === 'vrf') loadVrf();
    if (k === 'namespace') loadNs();
    const editor = k === 'site' ? siteEditor : k === 'vrf' ? vrfEditor : nsEditor;
    editor.scrollIntoView({ block: 'start' });
    let target: HTMLElement | null = null;
    if (kind === 'block') {
      const b = blockFields.get(id);
      target = b ? (field === 'vrfId' ? b.vrf.control : field === 'reserved' ? b.reserved.control : b.network.control) : null;
    } else if (k === 'site') target = siteFields.name.control;
    else if (k === 'vrf') target = field === 'exchangesWith' ? exchangeArea.querySelector('input') : field === 'siteId' ? vrfFields.site.control : vrfFields.name.control;
    else target = field === 'siteId' ? nsFields.site.control : nsFields.name.control;
    (target ?? editor).focus({ preventScroll: true });
  }

  const root = h('div', { class: 'planner-tab' },
    panel('Sites', [h('p', { class: 'hint' }, 'Places: buildings, campuses, data centers. VLANs, parent blocks and site-local VRFs belong to a site.'), messages.site, siteEditor, siteList], addSite),
    panel('VRFs (routing domains)', [h('p', { class: 'hint' }, 'Networks must not overlap inside a VRF or between VRFs that exchange routes. Independent VRFs may reuse the same networks.'), messages.vrf, vrfEditor, vrfList], addVrf),
    panel('VLAN namespaces', [h('p', { class: 'hint' }, 'Switching domains: VLAN IDs must be unique inside a namespace and may repeat in another. A namespace is separate from VRFs.'), messages.namespace, nsEditor, nsList], addNs),
  );

  return {
    root,
    open,
    refresh(source) {
      render();
      if (source === 'editor') {
        showSiteIssues();
        showVrfIssues();
        showNsIssues();
      } else {
        loadSite();
        loadVrf();
        loadNs();
      }
    },
  };
}
