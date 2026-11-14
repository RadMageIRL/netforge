/**
 * The shared building blocks every tool uses, so all tools look and behave the same: a page
 * header, panels, labeled fields with hint and error text, segmented choices, buttons, copy
 * buttons, result tables and notices.
 */
import type { ToolMeta, ToolServices } from '../app/registry';
import { h, replaceChildren, uid, type Child } from './dom';
import { icon, type IconName } from './icons';

export function pageHeader(eyebrow: string, title: string, summary: string): HTMLElement {
  return h('header', { class: 'page-header' },
    h('p', { class: 'eyebrow' }, eyebrow),
    h('h1', { tabindex: '-1', class: 'page-title' }, title),
    h('p', { class: 'page-summary' }, summary),
  );
}

export function toolPage(meta: ToolMeta, categoryName: string, ...body: Child[]): HTMLElement {
  return h('article', { class: 'tool-page', 'data-tool': meta.id }, pageHeader(categoryName, meta.name, meta.summary), ...body);
}

export function panel(title: string, body: Child[], actions?: Child, className = ''): HTMLElement {
  const id = uid('panel');
  return h('section', { class: `panel ${className}`.trim(), 'aria-labelledby': id },
    h('div', { class: 'panel-head' },
      h('h2', { id, class: 'panel-title' }, title),
      actions ? h('div', { class: 'panel-actions' }, actions) : null,
    ),
    h('div', { class: 'panel-body' }, ...body),
  );
}

export interface FieldHandle<T extends HTMLElement> {
  readonly root: HTMLElement;
  readonly control: T;
  setError(message: string | null): void;
}

interface FieldOptions {
  readonly label: string;
  readonly hint?: string;
  readonly mono?: boolean;
  /** Keep the label for assistive technology only, when a panel title already says it. */
  readonly hideLabel?: boolean;
}

function fieldShell<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(control: T, options: FieldOptions): FieldHandle<T> {
  const id = control.id || uid('field');
  control.id = id;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hint = options.hint ? h('p', { class: 'hint', id: hintId }, options.hint) : null;
  const error = h('p', { class: 'field-error', id: errorId, hidden: true });
  control.setAttribute('aria-describedby', [hint ? hintId : '', errorId].filter(Boolean).join(' '));
  const root = h('div', { class: 'field' }, h('label', { for: id, class: options.hideLabel ? 'visually-hidden' : 'field-label' }, options.label), control, hint, error);
  return {
    root,
    control,
    setError(message) {
      if (message) {
        replaceChildren(error, icon('error'), h('span', null, message));
        error.hidden = false;
        control.setAttribute('aria-invalid', 'true');
      } else {
        replaceChildren(error);
        error.hidden = true;
        control.removeAttribute('aria-invalid');
      }
    },
  };
}

export function textField(options: FieldOptions & { placeholder?: string; value?: string; id?: string }): FieldHandle<HTMLInputElement> {
  const input = h('input', {
    type: 'text', class: `input${options.mono ? ' mono' : ''}`, id: options.id, placeholder: options.placeholder,
    spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
  });
  if (options.value) input.value = options.value;
  return fieldShell(input, options);
}

export function textArea(options: FieldOptions & { placeholder?: string; rows?: number; readonly?: boolean; id?: string }): FieldHandle<HTMLTextAreaElement> {
  const area = h('textarea', {
    class: `textarea${options.mono ? ' mono' : ''}`, id: options.id, placeholder: options.placeholder, rows: options.rows ?? 12,
    spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', wrap: 'off', readonly: options.readonly,
  });
  return fieldShell(area, options);
}

export interface OptionGroup {
  readonly label: string | null;
  readonly options: readonly { value: string; label: string }[];
}

export function selectField(options: FieldOptions & { groups: readonly OptionGroup[]; value: string; id?: string }): FieldHandle<HTMLSelectElement> {
  const select = h('select', { class: 'select', id: options.id });
  for (const group of options.groups) {
    const items = group.options.map(o => h('option', { value: o.value }, o.label));
    if (group.label) select.appendChild(h('optgroup', { label: group.label }, items));
    else items.forEach(item => select.appendChild(item));
  }
  select.value = options.value;
  return fieldShell(select, options);
}

export interface Segmented {
  readonly root: HTMLElement;
  value(): string;
  set(value: string): void;
}

/** A set of radio buttons styled as a segmented control. Arrow keys move between options. */
export function segmented(options: { label: string; name: string; choices: readonly { value: string; label: string }[]; value: string; onChange: (value: string) => void }): Segmented {
  const name = uid(options.name);
  const inputs = options.choices.map(choice => {
    const input = h('input', { type: 'radio', name, value: choice.value, class: 'segmented-input' });
    input.checked = choice.value === options.value;
    input.addEventListener('change', () => { if (input.checked) options.onChange(choice.value); });
    return { input, label: h('label', { class: 'segmented-option' }, input, h('span', null, choice.label)) };
  });
  const root = h('fieldset', { class: 'segmented' },
    h('legend', { class: 'field-label' }, options.label),
    h('div', { class: 'segmented-track' }, inputs.map(i => i.label)),
  );
  return {
    root,
    value: () => inputs.find(i => i.input.checked)?.input.value ?? options.value,
    set(value) { for (const i of inputs) i.input.checked = i.input.value === value; },
  };
}

export function button(options: { label: string; onClick: () => void; icon?: IconName; variant?: 'primary' | 'secondary' | 'ghost'; iconOnly?: boolean; title?: string; id?: string }): HTMLButtonElement {
  const variant = options.variant ?? 'secondary';
  const b = h('button', {
    type: 'button', class: `btn btn-${variant}${options.iconOnly ? ' btn-icon' : ''}`, id: options.id,
    'aria-label': options.iconOnly ? options.label : undefined, title: options.title ?? (options.iconOnly ? options.label : undefined),
  },
  options.icon ? icon(options.icon) : null,
  options.iconOnly ? null : h('span', null, options.label));
  b.addEventListener('click', options.onClick);
  return b;
}

/** A button that copies `getText()` (disabled while it returns null) and briefly shows a check mark. */
export function copyButton(services: ToolServices, getText: () => string | null, what: string, options: { iconOnly?: boolean; label?: string } = {}): HTMLButtonElement {
  const label = options.label ?? (options.iconOnly ? `Copy ${what}` : 'Copy');
  const b = button({
    label, icon: 'copy', iconOnly: options.iconOnly, variant: options.iconOnly ? 'ghost' : 'secondary',
    onClick: async () => {
      const text = getText();
      if (text === null) return;
      if (await services.copy(text, what)) {
        b.classList.add('copied');
        window.setTimeout(() => b.classList.remove('copied'), 1500);
      }
    },
  });
  return b;
}

export interface ResultRow {
  readonly label: string;
  /** What is shown. */
  readonly value: string;
  /** What is copied, when it differs from the display (digits without grouping, for example). Null hides the copy button. */
  readonly copy?: string | null;
  readonly note?: string;
  readonly key?: string;
}

export function resultTable(caption: string, rows: readonly ResultRow[], services: ToolServices): HTMLTableElement {
  return h('table', { class: 'result-table' },
    h('caption', { class: 'visually-hidden' }, caption),
    h('tbody', null, rows.map(row => {
      const copyValue = row.copy === undefined ? row.value : row.copy;
      return h('tr', { 'data-key': row.key },
        h('th', { scope: 'row' }, row.label),
        h('td', { class: 'result-value' },
          h('span', { class: 'mono value-text' }, row.value),
          row.note ? h('span', { class: 'value-note' }, row.note) : null,
        ),
        h('td', { class: 'result-actions' }, copyValue === null ? null : copyButton(services, () => copyValue, row.label.toLowerCase(), { iconOnly: true })),
      );
    })),
  );
}

export type NoticeKind = 'info' | 'warning' | 'error' | 'ok';

export function notice(kind: NoticeKind, ...content: Child[]): HTMLElement {
  const name: IconName = kind === 'ok' ? 'ok' : kind;
  return h('div', { class: `notice notice-${kind}` }, icon(name), h('div', { class: 'notice-body' }, ...content));
}

export function emptyState(text: string): HTMLElement {
  return h('p', { class: 'empty-state' }, text);
}
