/**
 * An editable table of rows (name and value columns), keyboard friendly: every cell is a labeled
 * input, Enter in the last row adds a row, and removing a row moves focus to a sensible neighbor.
 * Values live only in the page.
 */
import { h, replaceChildren, uid } from './dom';
import { icon } from './icons';

export interface EditorColumn {
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly numeric?: boolean;
  readonly mono?: boolean;
}

export interface RowEditor {
  readonly root: HTMLElement;
  /** Every row's values, in order, including empty rows. */
  rows(): Record<string, string>[];
  setRows(rows: readonly Record<string, string>[]): void;
  setRowError(index: number, message: string | null): void;
  clearErrors(): void;
}

export function rowEditor(options: {
  id: string;
  label: string;
  description?: string;
  columns: readonly EditorColumn[];
  addLabel: string;
  rowNoun: string;
  initialRows?: number;
  onChange: () => void;
}): RowEditor {
  const body = h('tbody');
  let rows: { tr: HTMLTableRowElement; inputs: HTMLInputElement[]; error: HTMLTableRowElement }[] = [];
  const descId = `${options.id}-desc`;

  function renumber(): void {
    rows.forEach((row, i) => {
      row.inputs.forEach((input, c) => input.setAttribute('aria-label', `${options.columns[c].label}, ${options.rowNoun} ${i + 1}`));
      const remove = row.tr.querySelector('button')!;
      remove.setAttribute('aria-label', `Remove ${options.rowNoun} ${i + 1}`);
      remove.title = `Remove ${options.rowNoun} ${i + 1}`;
    });
  }

  function addRow(values: Record<string, string> = {}, focus = false): void {
    const inputs = options.columns.map(c => {
      const input = h('input', {
        type: 'text', class: `input${c.mono ? ' mono' : ''}`, placeholder: c.placeholder, inputmode: c.numeric ? 'numeric' : undefined,
        spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      });
      input.value = values[c.key] ?? '';
      input.addEventListener('input', options.onChange);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && rows[rows.length - 1]?.inputs.includes(input)) {
          event.preventDefault();
          addRow({}, true);
          options.onChange();
        }
      });
      return input;
    });
    const remove = h('button', { type: 'button', class: 'btn btn-ghost btn-icon' }, icon('close'));
    const tr = h('tr', null, inputs.map(i => h('td', null, i)), h('td', { class: 'editor-actions' }, remove));
    const error = h('tr', { class: 'editor-error', hidden: true }, h('td', { colspan: String(options.columns.length + 1), id: uid(`${options.id}-error`) }));
    const row = { tr, inputs, error };
    remove.addEventListener('click', () => {
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      tr.remove();
      error.remove();
      renumber();
      (rows[index]?.inputs[0] ?? rows[index - 1]?.inputs[0] ?? addButton).focus();
      options.onChange();
    });
    rows.push(row);
    body.append(tr, error);
    renumber();
    if (focus) inputs[0].focus();
  }

  const addButton = h('button', { type: 'button', class: 'btn btn-secondary', id: `${options.id}-add` }, icon('plus'), h('span', null, options.addLabel));
  addButton.addEventListener('click', () => {
    addRow({}, true);
    options.onChange();
  });

  const root = h('fieldset', { class: 'row-editor', id: options.id, 'aria-describedby': options.description ? descId : undefined },
    h('legend', { class: 'field-label' }, options.label),
    options.description ? h('p', { class: 'hint', id: descId }, options.description) : null,
    h('div', { class: 'table-scroll' },
      h('table', { class: 'editor-table' },
        h('thead', null, h('tr', null, options.columns.map(c => h('th', { scope: 'col' }, c.label)), h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Remove')))),
        body,
      ),
    ),
    h('div', { class: 'toolbar' }, addButton),
  );
  for (let i = 0; i < (options.initialRows ?? 1); i++) addRow();

  return {
    root,
    rows: () => rows.map(r => Object.fromEntries(options.columns.map((c, i) => [c.key, r.inputs[i].value]))),
    setRows(values) {
      for (const r of rows) {
        r.tr.remove();
        r.error.remove();
      }
      rows = [];
      if (values.length === 0) addRow();
      for (const v of values) addRow(v);
    },
    setRowError(index, message) {
      const row = rows[index];
      if (!row) return;
      const cell = row.error.firstElementChild as HTMLElement;
      if (message) {
        replaceChildren(cell, h('span', { class: 'field-error' }, icon('error'), h('span', null, message)));
        row.error.hidden = false;
        row.inputs.forEach(i => {
          i.setAttribute('aria-invalid', 'true');
          i.setAttribute('aria-describedby', cell.id);
        });
      } else {
        replaceChildren(cell);
        row.error.hidden = true;
        row.inputs.forEach(i => {
          i.removeAttribute('aria-invalid');
          i.removeAttribute('aria-describedby');
        });
      }
    },
    clearErrors() {
      rows.forEach((_r, i) => this.setRowError(i, null));
    },
  };
}
