/**
 * NetForge Subnet & VLAN Planner: sites, VRFs, VLAN namespaces and VLANs in one plan, validated
 * as a whole, with automatic IPv4 and IPv6 allocation and an address map.
 *
 * Privacy: the plan exists only in this page. It is never written to browser storage and never
 * restored on its own; saving is a file download the user asks for, and opening reads a file the
 * user picks.
 */
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { examplePlan } from '../../core/plan/example';
import { MAX_PLAN_CHARS, parsePlanJson, planToJson } from '../../core/plan/file';
import { emptyPlan } from '../../core/plan/model';
import type { PlanIssue } from '../../core/plan/validate';
import { button, notice, panel, tabs, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { allocateView } from './allocate-view';
import { plural } from './common';
import { issuesView } from './issues-view';
import { mapView } from './map-view';
import { PlanStore } from './store';
import { structureView } from './structure';
import { vlanView } from './vlans';

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  const store = new PlanStore(emptyPlan());

  // ---- Plan header: name, file actions, summary --------------------------------------------
  const nameField = textField({ id: 'plan-name', label: 'Plan name', placeholder: 'Campus network 2027' });
  const descField = textField({ id: 'plan-description', label: 'Description' });
  nameField.control.addEventListener('input', () => store.change('editor', p => { p.name = nameField.control.value; }));
  descField.control.addEventListener('input', () => store.change('editor', p => { p.description = descField.control.value; }));
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'plan-file', tabindex: '-1', 'aria-hidden': 'true' });
  const fileArea = h('div', { class: 'undo-area', id: 'plan-messages' });
  const summary = h('p', { class: 'plan-summary', id: 'plan-summary' });

  /** Runs `action` at once, or after the user confirms losing unsaved changes. */
  function guarded(what: string, action: () => void): void {
    if (!store.dirty) {
      action();
      return;
    }
    const yes = button({ label: `Discard changes and ${what}`, id: 'plan-confirm', onClick: () => { replaceChildren(fileArea); action(); } });
    const no = button({ label: 'Cancel', variant: 'ghost', id: 'plan-cancel', onClick: () => { replaceChildren(fileArea); newButton.focus(); } });
    replaceChildren(fileArea, notice('warning', h('p', null, 'The current plan has changes that are not saved to a file.'), h('div', { class: 'toolbar' }, yes, no)));
    yes.focus();
  }

  const newButton = button({ label: 'New', id: 'plan-new', title: 'Start an empty plan', onClick: () => guarded('start a new plan', () => {
    store.replace(emptyPlan(), 'replace', true);
    replaceChildren(fileArea, notice('info', 'Started a new plan.'));
  }) });
  const openButton = button({ label: 'Open...', id: 'plan-open', title: 'Open a plan file from this device', onClick: () => guarded('open a file', () => fileInput.click()) });
  const saveButton = button({ label: 'Save plan', icon: 'download', id: 'plan-save', variant: 'primary', title: 'Download the plan as a JSON file', onClick: () => {
    store.flush();
    const stem = (store.plan.name.trim() || 'network-plan').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'network-plan';
    services.download(`${stem}.netforge-plan.json`, planToJson(store.plan), 'application/json');
    store.markSaved();
    refreshSummary();
  } });
  const exampleButton = button({ label: 'Example', variant: 'ghost', id: 'plan-example', onClick: () => guarded('load the example', () => {
    store.replace(examplePlan(), 'replace', true);
    replaceChildren(fileArea);
  }) });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_PLAN_CHARS * 4) {
      replaceChildren(fileArea, notice('error', `${file.name} is too large to be a plan file.`));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      replaceChildren(fileArea, notice('error', `${file.name} could not be read.`));
      return;
    }
    const r = parsePlanJson(text);
    if (!r.ok) {
      replaceChildren(fileArea, notice('error', h('p', null, h('strong', null, `${file.name} was not opened. `), r.error.message), h('p', null, 'The current plan is unchanged.')));
      services.announce('The plan file was not opened.');
      return;
    }
    store.replace(r.value.plan, 'replace', true);
    replaceChildren(fileArea, notice(r.value.warnings.length ? 'warning' : 'ok',
      h('p', null, `Opened ${file.name}: ${plural(r.value.plan.vlans.length, 'VLAN')} at ${plural(r.value.plan.sites.length, 'site')}.`),
      r.value.warnings.length ? h('ul', { class: 'problem-list' }, r.value.warnings.map(w => h('li', null, w))) : null,
    ));
    services.announce(`Opened ${file.name}.`);
  });

  function refreshSummary(): void {
    const p = store.plan;
    const c = store.validation.counts;
    replaceChildren(summary,
      `${plural(p.sites.length, 'site')}, ${plural(p.vrfs.length, 'VRF')}, ${plural(p.namespaces.length, 'VLAN namespace')}, ${plural(p.vlans.length, 'VLAN')}. `,
      h('span', { class: c.error ? 'summary-error' : 'summary-ok' }, `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}, ${plural(c.info, 'note')}.`),
      store.dirty ? h('span', { class: 'summary-unsaved' }, ' Not saved to a file.') : null,
    );
  }

  // ---- Views ---------------------------------------------------------------------------------
  const vlans = vlanView(store, services);
  const structure = structureView(store, services.announce);
  const openVlan = (id: string) => {
    t.select('vlans');
    vlans.open(id);
  };
  const allocate = allocateView(store, services.announce, openVlan);
  const map = mapView(store, openVlan);
  const goToIssue = (issue: PlanIssue) => {
    const k = issue.target.kind;
    if (k === 'vlan') {
      t.select('vlans');
      vlans.open(issue.target.id, issue.field);
    } else if (k === 'site' || k === 'block' || k === 'vrf' || k === 'namespace') {
      t.select('structure');
      structure.open(k, issue.target.id, issue.field, issue.target.siteId);
    }
  };
  const issues = issuesView(store, services, goToIssue);

  const t = tabs({
    id: 'planner-tabs', label: 'Planner sections',
    items: [
      { id: 'vlans', label: 'VLANs' }, { id: 'structure', label: 'Sites, VRFs and namespaces' }, { id: 'allocate', label: 'Allocate' },
      { id: 'map', label: 'Address map' }, { id: 'issues', label: 'Issues' },
    ],
    onChange: id => {
      map.setActive(id === 'map');
      issues.setActive(id === 'issues');
      if (id === 'vlans') vlans.refresh('other');
      if (id === 'structure') structure.refresh('other');
      if (id === 'allocate') allocate.refresh('other');
    },
  });
  t.panels.vlans.appendChild(vlans.root);
  t.panels.structure.appendChild(structure.root);
  t.panels.allocate.appendChild(allocate.root);
  t.panels.map.appendChild(map.root);
  t.panels.issues.appendChild(issues.root);

  store.subscribe(source => {
    if (source !== 'editor') {
      nameField.control.value = store.plan.name;
      descField.control.value = store.plan.description;
    }
    const current = t.current();
    // Visible views update now; hidden ones catch up when shown.
    if (current === 'vlans') vlans.refresh(source);
    if (current === 'structure') structure.refresh(source);
    // Cheap, and it must notice a replaced plan even while hidden.
    allocate.refresh(source);
    map.refresh();
    issues.refresh();
    const c = store.validation.counts;
    t.setLabel('issues', c.error + c.warning ? `Issues (${(c.error + c.warning).toLocaleString('en-US')})` : 'Issues');
    refreshSummary();
  });

  host.appendChild(toolPage(meta, categoryName,
    panel('Plan', [
      h('div', { class: 'editor-grid' }, nameField.root, descField.root),
      summary,
      fileArea,
      h('p', { class: 'hint' }, 'The plan stays in this page only. Nothing is stored in the browser: save the plan to a file to keep it, and open the file to continue. Reloading the page starts an empty plan.'),
      fileInput,
    ], [newButton, openButton, saveButton, exampleButton], 'plan-panel'),
    t.root,
  ));
  store.replace(store.plan, 'replace', true);

  return {
    activate() {
      store.flush();
    },
  };
}

