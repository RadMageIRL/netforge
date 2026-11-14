/**
 * What the three export tools share: choosing the plan to export (the one open in the planner, a
 * plan file, or the example), choosing the part of it, and showing a result with its files, its
 * exact / approximate / unsupported account, and its assumptions and manual steps.
 *
 * The plan stays in memory. Nothing here stores it, and an export is text on the page until the
 * person copies or downloads it. Nothing is run.
 */
import type { ToolServices } from '../../app/registry';
import { formatInteger } from '../../core/format';
import { accountText, FIDELITY_LABEL, type ExportItem, type ExportOutput, type Fidelity } from '../../core/infra/model';
import type { ExportScope } from '../../core/infra/source';
import { examplePlan } from '../../core/plan/example';
import { MAX_PLAN_CHARS, parsePlanJson } from '../../core/plan/file';
import type { Plan } from '../../core/plan/model';
import { validatePlan } from '../../core/plan/validate';
import { button, copyButton, notice, panel, selectField, type FieldHandle } from '../../ui/components';
import { h, replaceChildren, type Child } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { plannerPlan } from '../plan-shared/plan-bridge';
import { codeBlock, plural, statusLine } from '../util-shared/util-view';

export interface PlanSource {
  readonly panel: HTMLElement;
  plan(): Plan | null;
}

/** The "Plan" panel: where the plan to export comes from. Calls onChange whenever the plan changes. */
export function planSource(services: ToolServices, prefix: string, onChange: () => void): PlanSource {
  let plan: Plan | null = null;
  let origin = '';
  const summary = h('p', { class: 'plan-summary', id: `${prefix}-plan-summary` });
  const messages = h('div', { class: 'undo-area', id: `${prefix}-plan-messages` });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: `${prefix}-plan-file`, tabindex: '-1', 'aria-hidden': 'true' });

  function refresh(): void {
    if (!plan) {
      replaceChildren(summary, 'No plan chosen yet.');
      return;
    }
    const c = validatePlan(plan).counts;
    replaceChildren(summary,
      h('strong', null, `${origin}: `),
      `${plan.name.trim() === '' ? 'unnamed plan' : plan.name.trim()}, ${plural(plan.sites.length, 'site')}, ${plural(plan.vrfs.length, 'VRF')}, ${plural(plan.vlans.length, 'VLAN')}. `,
      h('span', { class: c.error ? 'summary-error' : 'summary-ok' }, `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}.`),
    );
  }

  function use(next: Plan, from: string, message: Child | null): void {
    plan = next;
    origin = from;
    replaceChildren(messages, message);
    refresh();
    onChange();
  }

  const fromPlanner = button({ label: 'Use the planner\'s plan', id: `${prefix}-from-planner`, variant: 'primary', title: 'Take a copy of the plan that is open in the Subnet & VLAN Planner', onClick: () => {
    const p = plannerPlan();
    if (!p) {
      replaceChildren(messages, notice('info', 'The Subnet & VLAN Planner has not been opened in this page yet, so it has no plan to hand over. Open a plan file here, or build a plan in the planner and come back.'));
      return;
    }
    use(p, 'From the planner', notice('info', 'This is a copy of the planner\'s plan as it is now. Press the button again after changing the plan.'));
    services.announce('Took a copy of the planner\'s plan.');
  } });
  const open = button({ label: 'Open plan file...', id: `${prefix}-open`, title: 'Open a plan file saved from the planner', onClick: () => fileInput.click() });
  const example = button({ label: 'Example plan', id: `${prefix}-example`, variant: 'ghost', onClick: () => use(examplePlan(), 'Example', null) });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_PLAN_CHARS * 4) {
      replaceChildren(messages, notice('error', `${file.name} is too large to be a plan file.`));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      replaceChildren(messages, notice('error', `${file.name} could not be read.`));
      return;
    }
    const r = parsePlanJson(text);
    if (!r.ok) {
      replaceChildren(messages, notice('error', h('p', null, h('strong', null, `${file.name} was not opened. `), r.error.message)));
      services.announce('The plan file was not opened.');
      return;
    }
    use(r.value.plan, file.name, r.value.warnings.length ? notice('warning', h('ul', { class: 'problem-list' }, r.value.warnings.map(w => h('li', null, w)))) : null);
    services.announce(`Opened ${file.name}.`);
  });

  refresh();
  return {
    panel: panel('Plan', [
      summary, messages,
      h('p', { class: 'hint' }, 'The plan is read in this page only. It is not stored, and nothing is sent anywhere.'),
      fileInput,
    ], [fromPlanner, open, example], 'plan-panel'),
    plan: () => plan,
  };
}

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** Replaces a select's options, keeping the current value when it is still offered. */
export function setChoices(select: HTMLSelectElement, choices: readonly Choice[], fallback?: string): void {
  const before = select.value;
  replaceChildren(select, choices.map(c => h('option', { value: c.value }, c.label)));
  const keep = choices.some(c => c.value === before) ? before : fallback ?? choices[0]?.value ?? '';
  select.value = keep;
}

export function choiceField(id: string, label: string, hint?: string): FieldHandle<HTMLSelectElement> {
  return selectField({ id, label, hint, groups: [{ label: null, options: [] }], value: '' });
}

export interface ScopeFields {
  readonly site: FieldHandle<HTMLSelectElement>;
  readonly vrf: FieldHandle<HTMLSelectElement>;
  readonly namespace: FieldHandle<HTMLSelectElement>;
  value(): ExportScope;
  /** Refills the selects for a plan (or none). */
  setPlan(plan: Plan | null): void;
}

const named = (name: string, id: string) => (name.trim() === '' ? id : name.trim());

/**
 * Site, VRF and VLAN namespace selects. `requireSite` and `requireVrf` drop the "all" choice
 * for targets that need exactly one.
 */
export function scopeFields(prefix: string, onChange: () => void, options: { requireSite?: boolean; requireVrf?: boolean } = {}): ScopeFields {
  const site = choiceField(`${prefix}-site`, 'Site');
  const vrf = choiceField(`${prefix}-vrf`, 'VRF');
  const namespace = choiceField(`${prefix}-namespace`, 'VLAN namespace');
  let plan: Plan | null = null;

  function fillDependents(): void {
    const siteId = site.control.value;
    const vrfs = plan ? plan.vrfs.filter(v => siteId === '' || v.siteId === '' || v.siteId === siteId) : [];
    const spaces = plan ? plan.namespaces.filter(n => siteId === '' || n.siteId === '' || n.siteId === siteId) : [];
    setChoices(vrf.control, [...(options.requireVrf ? [] : [{ value: '', label: 'All VRFs' }]), ...vrfs.map(v => ({ value: v.id, label: named(v.name, v.id) }))]);
    setChoices(namespace.control, [{ value: '', label: 'All VLAN namespaces' }, ...spaces.map(n => ({ value: n.id, label: named(n.name, n.id) }))]);
  }

  site.control.addEventListener('change', () => { fillDependents(); onChange(); });
  vrf.control.addEventListener('change', onChange);
  namespace.control.addEventListener('change', onChange);
  return {
    site, vrf, namespace,
    value: () => ({ siteId: site.control.value, vrfId: vrf.control.value, namespaceId: namespace.control.value }),
    setPlan(next) {
      plan = next;
      const sites = plan ? plan.sites : [];
      setChoices(site.control, [...(options.requireSite ? [] : [{ value: '', label: 'All sites' }]), ...sites.map(s => ({ value: s.id, label: named(s.name, s.id) }))]);
      fillDependents();
    },
  };
}

const BADGE: Readonly<Record<Fidelity, { cls: string; icon: 'ok' | 'warning' | 'error' }>> = {
  exact: { cls: 'badge-ok', icon: 'ok' },
  approximate: { cls: 'badge-warning', icon: 'warning' },
  unsupported: { cls: 'badge-error', icon: 'error' },
};

export function fidelityBadge(f: Fidelity): HTMLElement {
  return h('span', { class: `badge ${BADGE[f].cls}` }, icon(BADGE[f].icon), h('span', null, FIDELITY_LABEL[f]));
}

/** Items shown before the rest are counted: everything that is not exact first. */
export const ITEMS_SHOWN = 300;
/** Characters of a file shown in the preview. Copy and Download always give the whole file. */
export const PREVIEW_CHARS = 200_000;

function itemRow(item: ExportItem): HTMLElement {
  return h('li', { class: `export-item export-${item.fidelity}` },
    fidelityBadge(item.fidelity),
    h('div', { class: 'export-item-body' },
      h('p', null, h('strong', null, item.subject), item.written.length > 0 ? `: ${item.written.join('; ')}.` : ''),
      item.notes.length + item.remarks.length > 0 ? h('ul', { class: 'export-notes' },
        item.notes.map(n => h('li', null, h('span', { class: `export-tag export-tag-${n.fidelity}` }, FIDELITY_LABEL[n.fidelity]), ` ${n.field}: ${n.detail}`)),
        item.remarks.map(r => h('li', null, r)),
      ) : null,
    ),
  );
}

function listSection(title: string, id: string, entries: readonly string[]): HTMLElement | null {
  if (entries.length === 0) return null;
  return h('div', { class: 'result-section', id }, h('h3', { class: 'sub-title' }, title), h('ul', { class: 'notes-list util-notes' }, entries.map(e => h('li', null, e))));
}

export interface OutputView {
  readonly status: HTMLElement;
  readonly preview: HTMLElement;
  readonly account: HTMLElement;
  show(output: ExportOutput | null, title: string, emptyText: string): void;
}

/** The result area: a status line, the generated files, and the account of what was written. */
export function outputView(services: ToolServices, prefix: string): OutputView {
  const status = h('div', { class: 'json-status', id: `${prefix}-status`, role: 'status' });
  const files = h('div', { class: 'export-files', id: `${prefix}-files` });
  const accountBody = h('div', { class: 'export-account', id: `${prefix}-account` });
  let current: { output: ExportOutput; title: string } | null = null;
  const copyNotes = copyButton(services, () => (current ? accountText(current.title, current.output) : null), 'the notes', { label: 'Copy notes' });
  const preview = panel('Preview', [files], undefined, 'result-panel');
  const account = panel('What was exported', [accountBody], [copyNotes]);

  return {
    status, preview, account,
    show(output, title, emptyText) {
      current = output ? { output, title } : null;
      copyNotes.disabled = output === null;
      if (!output) {
        replaceChildren(status);
        replaceChildren(files, h('p', { class: 'empty-state' }, emptyText));
        replaceChildren(accountBody, h('p', { class: 'empty-state' }, 'Nothing yet.'));
        return;
      }
      const c = output.counts;
      const countText = output.items.length === 0 ? '' : `${formatInteger(c.exact)} exact, ${formatInteger(c.approximate)} approximate, ${formatInteger(c.unsupported)} unsupported`;
      if (!output.ok) {
        replaceChildren(status, notice('error',
          h('p', null, h('strong', null, 'Nothing was generated.')),
          h('ul', { class: 'problem-list', id: `${prefix}-refusals` }, output.refusals.map(r => h('li', null, r)))));
        replaceChildren(files, h('p', { class: 'empty-state' }, 'No preview: see the message above.'));
      } else {
        replaceChildren(status,
          statusLine('ok', `Preview ready: ${title}`, countText),
          output.privileges.length > 0 ? notice('warning', h('div', { id: `${prefix}-privileges` }, output.privileges.map(p => h('p', null, p)))) : null,
        );
        replaceChildren(files, output.files.map((f, i) => {
          const shown = f.text.length > PREVIEW_CHARS ? f.text.slice(0, PREVIEW_CHARS) : f.text;
          return h('div', { class: 'result-section export-file' },
            h('div', { class: 'export-file-head' },
              h('h3', { class: 'sub-title' }, f.name, h('span', { class: 'status-detail' }, ` ${f.kind}, ${plural(f.text.length, 'character')}`)),
              h('div', { class: 'toolbar' },
                copyButton(services, () => f.text, f.name),
                button({ label: 'Download', icon: 'download', id: `${prefix}-download-${i}`, onClick: () => services.download(f.name, f.text, f.mime) }),
              ),
            ),
            codeBlock(shown, `${f.name}, ${f.kind}`, `${prefix}-code-${i}`),
            shown.length < f.text.length ? h('p', { class: 'hint' }, `The preview shows the first ${formatInteger(PREVIEW_CHARS)} characters. Copy and Download give the whole file.`) : null,
          );
        }));
      }
      const order: Record<Fidelity, number> = { unsupported: 0, approximate: 1, exact: 2 };
      const sorted = output.items.map((item, i) => ({ item, i })).sort((a, b) => order[a.item.fidelity] - order[b.item.fidelity] || a.i - b.i).map(x => x.item);
      const shownItems = sorted.slice(0, ITEMS_SHOWN);
      const hidden = sorted.length - shownItems.length;
      replaceChildren(accountBody,
        output.items.length > 0 ? h('div', { class: 'result-section', id: `${prefix}-items` },
          h('h3', { class: 'sub-title' }, `Items: ${countText}`),
          h('p', { class: 'hint' }, 'Exact: the output states what the plan states. Approximate: written, but something differs or is left out, as noted. Unsupported: not written, with the reason.'),
          h('ul', { class: 'export-items' }, shownItems.map(itemRow)),
          hidden > 0 ? h('p', { class: 'hint' }, `${formatInteger(hidden)} more ${hidden === 1 ? 'item is' : 'items are'} not listed here. Copy notes gives every item.`) : null,
        ) : null,
        listSection('Not exported: nothing in the plan for this target', `${prefix}-skipped`, output.skipped.map(s => `${s.subject}: ${s.reason}`)),
        listSection('Assumptions', `${prefix}-assumptions`, output.assumptions),
        listSection('Manual steps', `${prefix}-manual`, output.manualSteps),
        listSection('Not covered by this export', `${prefix}-not-covered`, output.notCovered),
      );
    },
  };
}

/** Runs `fn` after typing pauses. */
export function debounced(fn: () => void, ms = 200): () => void {
  let timer = 0;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

export const PREVIEW_NOTE = 'This is a preview for you to review. NetForge runs nothing, connects to nothing and has not tested the output against a real system.';
