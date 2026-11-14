/** Small helpers shared by the planner's views. */
import type { ReservedEntry } from '../../core/plan/model';
import type { PlanIssue, Severity } from '../../core/plan/validate';
import type { FieldHandle } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { icon } from '../../ui/icons';

export interface Option {
  readonly value: string;
  readonly label: string;
}

/** Replaces a select's options, keeping `value` selected (added as an extra option if it is not in the list). */
export function setOptions(select: HTMLSelectElement, options: readonly Option[], value: string, missingLabel = (v: string) => `${v} (missing)`): void {
  const list = [...options];
  if (!list.some(o => o.value === value)) list.push({ value, label: value === '' ? 'Choose...' : missingLabel(value) });
  const same = select.options.length === list.length && list.every((o, i) => select.options[i].value === o.value && select.options[i].text === o.label);
  if (!same) replaceChildren(select, list.map(o => h('option', { value: o.value }, o.label)));
  select.value = value;
}

const SEVERITY_ICON = { error: 'error', warning: 'warning', info: 'info' } as const;

/**
 * Shows the errors and warnings for one field under it. Errors mark the control invalid;
 * warnings are shown without that, since the value is acceptable.
 */
export function fieldIssues(field: FieldHandle<HTMLElement>, issues: readonly PlanIssue[]): void {
  const errors = issues.filter(i => i.severity === 'error').map(i => i.message);
  field.setError(errors.length ? errors.join(' ') : null);
  const root = field.root;
  let warn = root.querySelector<HTMLElement>(':scope > .field-warning');
  const notes = issues.filter(i => i.severity !== 'error');
  if (notes.length === 0) {
    if (warn) {
      warn.remove();
      relink(field.control, root);
    }
    return;
  }
  if (!warn) {
    warn = h('div', { class: 'field-warning', id: `${field.control.id}-warning` });
    root.appendChild(warn);
  }
  replaceChildren(warn, notes.map(n => h('p', { class: `field-note field-note-${n.severity}` }, icon(SEVERITY_ICON[n.severity]), h('span', null, n.message))));
  relink(field.control, root);
}

function relink(control: Element, root: HTMLElement): void {
  const ids = [...root.querySelectorAll<HTMLElement>(':scope > .hint, :scope > .field-error, :scope > .field-warning')].map(e => e.id).filter(Boolean);
  control.setAttribute('aria-describedby', ids.join(' '));
}

/** Text area lines to list entries: trimmed, empty lines dropped. */
export function linesToList(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
}

/** "range # label" lines to reserved entries. */
export function linesToReserved(text: string): ReservedEntry[] {
  return linesToList(text).map(line => {
    const hash = line.indexOf('#');
    return hash < 0 ? { range: line, label: '' } : { range: line.slice(0, hash).trim(), label: line.slice(hash + 1).trim() };
  });
}

export function reservedToLines(list: readonly ReservedEntry[]): string {
  return list.map(r => (r.label.trim() ? `${r.range} # ${r.label}` : r.range)).join('\n');
}

export function severityCounts(issues: readonly PlanIssue[]): Record<Severity, number> {
  const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) c[i.severity]++;
  return c;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** A status badge: "2 errors", "1 warning", "Info", "OK". */
export function statusBadge(issues: readonly PlanIssue[]): HTMLElement {
  const c = severityCounts(issues);
  if (c.error) return h('span', { class: 'badge badge-error' }, icon('error'), h('span', null, plural(c.error, 'error')));
  if (c.warning) return h('span', { class: 'badge badge-warning' }, icon('warning'), h('span', null, plural(c.warning, 'warning')));
  if (c.info) return h('span', { class: 'badge badge-info' }, icon('info'), h('span', null, 'Note'));
  return h('span', { class: 'badge badge-ok' }, icon('ok'), h('span', null, 'OK'));
}

export const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
