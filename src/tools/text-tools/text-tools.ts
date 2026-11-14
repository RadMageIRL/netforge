/**
 * List / Text Tools: line operations (trim, remove blanks and duplicates, change case, sort,
 * prefix, suffix, number), list comparison, and text statistics. The input is never altered:
 * results appear beside it, and with no operation selected the output equals the input exactly.
 */
import { formatInteger } from '../../core/format';
import {
  compareLists, DEFAULT_TRANSFORM, TEXT_LIMITS, textStats, transformLines,
  type CaseMode, type CompareResult, type SortMode, type TransformOptions, type TransformResult, type TrimMode,
} from '../../core/textops/lines';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, copyButton, notice, panel, selectField, summaryTable, tabs, textArea, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { numberField, plural, statusLine } from '../util-shared/util-view';

const LIVE_LIMIT = 200_000;

type CompareView = 'both' | 'onlyA' | 'onlyB' | 'union';
const COMPARE_VIEWS: readonly { value: CompareView; label: string; file: string }[] = [
  { value: 'both', label: 'In both lists (intersection)', file: 'in-both.txt' },
  { value: 'onlyA', label: 'Only in list A (A minus B)', file: 'only-in-a.txt' },
  { value: 'onlyB', label: 'Only in list B (B minus A)', file: 'only-in-b.txt' },
  { value: 'union', label: 'In either list (union)', file: 'in-either.txt' },
];

const simple = (options: readonly { value: string; label: string }[]) => [{ label: null, options }];

function transformView(services: ToolServices): HTMLElement {
  let options: TransformOptions = { ...DEFAULT_TRANSFORM };
  let result: TransformResult | null = null;
  let timer = 0;
  const set = (patch: Partial<TransformOptions>) => { options = { ...options, ...patch }; run(); };

  const inputField = textArea({ id: 'text-input', label: 'Text', hideLabel: true, mono: true, rows: 12, placeholder: 'Paste lines of text' });
  const outputField = textArea({ id: 'text-output', label: 'Result', hideLabel: true, mono: true, rows: 12, readonly: true, placeholder: 'The result appears here.' });
  const input = inputField.control;
  const output = outputField.control;
  const status = h('div', { class: 'json-status', id: 'text-status', role: 'status' });
  const stats = h('div', { id: 'text-stats' });
  const statsEmpty = h('p', { class: 'muted', id: 'text-stats-empty' }, 'Counts for the input appear here.');

  const trim = selectField({ id: 'text-trim', label: 'Trim whitespace', value: 'none', groups: simple([
    { value: 'none', label: 'Leave as is' }, { value: 'both', label: 'Both ends' }, { value: 'start', label: 'Start of line' }, { value: 'end', label: 'End of line' }]) });
  const changeCase = selectField({ id: 'text-case', label: 'Change case', value: 'none', groups: simple([
    { value: 'none', label: 'Leave as is' }, { value: 'lower', label: 'lowercase' }, { value: 'upper', label: 'UPPERCASE' }]) });
  const sort = selectField({ id: 'text-sort', label: 'Sort lines', value: 'none', groups: simple([
    { value: 'none', label: 'Keep order' }, { value: 'text', label: 'By character code' }, { value: 'natural', label: 'Natural (2 before 10)' }, { value: 'length', label: 'By length' }]) });
  trim.control.addEventListener('change', () => set({ trim: trim.control.value as TrimMode }));
  changeCase.control.addEventListener('change', () => set({ changeCase: changeCase.control.value as CaseMode }));
  sort.control.addEventListener('change', () => set({ sort: sort.control.value as SortMode }));

  const removeEmpty = checkbox({ id: 'text-remove-empty', label: 'Remove empty lines (blank or only whitespace)', onChange: on => set({ removeEmpty: on }) });
  const dedupe = checkbox({ id: 'text-dedupe', label: 'Remove duplicate lines (keep the first)', onChange: on => set({ dedupe: on }) });
  const descending = checkbox({ id: 'text-descending', label: 'Sort descending', onChange: on => set({ descending: on }) });
  const ignoreCase = checkbox({ id: 'text-ignore-case', label: 'Ignore case when sorting and finding duplicates', onChange: on => set({ ignoreCase: on }) });
  const number = checkbox({ id: 'text-number', label: 'Number the lines', onChange: on => { numberRow.hidden = !on; set({ number: on }); } });
  const pad = checkbox({ id: 'text-number-pad', label: 'Pad numbers with zeros to equal width', onChange: on => set({ numberPad: on }) });

  const prefix = textField({ id: 'text-prefix', label: 'Add before each line', mono: true });
  const suffix = textField({ id: 'text-suffix', label: 'Add after each line', mono: true });
  prefix.control.addEventListener('input', () => set({ prefix: prefix.control.value }));
  suffix.control.addEventListener('input', () => set({ suffix: suffix.control.value }));
  const start = numberField({ id: 'text-number-start', label: 'First number', value: '1', onInput: () => {
    const v = start.control.value.trim();
    if (/^-?\d{1,9}$/.test(v)) { start.setError(null); set({ numberStart: Number(v) }); } else start.setError('Enter a whole number.');
  } });
  const separator = textField({ id: 'text-number-separator', label: 'Between number and line', mono: true, value: DEFAULT_TRANSFORM.numberSeparator });
  separator.control.addEventListener('input', () => set({ numberSeparator: separator.control.value }));
  const numberRow = h('div', { class: 'controls-row', id: 'text-number-row', hidden: true }, start.root, separator.root, pad.root);

  const outputText = () => (result?.ok ? result.output : null);
  const copy = copyButton(services, outputText, 'result');
  const download = button({ label: 'Download', icon: 'download', onClick: () => { const t = outputText(); if (t !== null) services.download('lines.txt', t, 'text/plain'); } });

  function render(): void {
    const r = result;
    if (!r) {
      output.value = '';
      replaceChildren(status);
      replaceChildren(stats);
    } else if (!r.ok) {
      output.value = '';
      replaceChildren(status, notice('error', h('p', { id: 'text-error' }, r.message)));
      replaceChildren(stats);
    } else {
      output.value = r.output;
      replaceChildren(status,
        statusLine('ok', r.steps.length === 0 ? 'No operation selected' : `${plural(r.linesIn, 'line')} in, ${plural(r.linesOut, 'line')} out`,
          r.steps.length === 0 ? 'The result is the input, unchanged.' : undefined),
        r.steps.length > 0 ? h('ol', { class: 'notes-list step-list', id: 'text-steps' }, r.steps.map(s => h('li', null, s))) : null,
        r.mixedEol ? notice('info', 'The input mixes line endings (LF, CRLF or CR). The result uses the first kind found throughout.') : null,
      );
      const s = textStats(input.value);
      replaceChildren(stats, summaryTable('Statistics for the input', [
        ['Lines', formatInteger(s.lines)], ['Empty lines', formatInteger(s.emptyLines)], ['Unique lines', formatInteger(s.uniqueLines)],
        ['Words', formatInteger(s.words)], ['Characters (code points)', formatInteger(s.characters)], ['Characters without whitespace', formatInteger(s.nonWhitespace)],
        ['UTF-8 bytes', formatInteger(s.utf8Bytes)], ['UTF-16 units', formatInteger(s.utf16Units)], ['Longest line (characters)', formatInteger(s.longestLine)],
      ]));
    }
    statsEmpty.hidden = stats.childElementCount > 0;
    copy.disabled = outputText() === null;
    download.disabled = outputText() === null;
  }

  function run(): void {
    window.clearTimeout(timer);
    result = input.value === '' ? null : transformLines(input.value, options);
    render();
  }
  input.addEventListener('input', () => {
    if (input.value.length <= LIVE_LIMIT) run();
    else { window.clearTimeout(timer); timer = window.setTimeout(run, 300); }
  });

  const sample = button({ label: 'Example', variant: 'ghost', onClick: () => { input.value = 'server10\nserver2\n  Server2\n\nserver1\nserver10\ngateway\n'; run(); input.focus(); } });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { input.value = ''; run(); input.focus(); } });
  render();
  return h('div', { class: 'tool-stack' },
    panel('Operations', [
      h('p', { class: 'muted' }, 'Applied in this order: trim, remove empty lines, change case, remove duplicates, sort, add text, number.'),
      h('div', { class: 'editor-grid' }, trim.root, changeCase.root, sort.root, prefix.root, suffix.root),
      h('div', { class: 'check-list', id: 'text-options' }, removeEmpty.root, dedupe.root, descending.root, ignoreCase.root, number.root),
      numberRow,
    ]),
    status,
    h('div', { class: 'split' },
      panel('Input', [inputField.root], [sample, clear]),
      panel('Result', [outputField.root], [copy, download]),
    ),
    panel('Statistics', [stats, statsEmpty]),
  );
}

function compareView(services: ToolServices): HTMLElement {
  let view: CompareView = 'both';
  let result: CompareResult | null = null;
  let timer = 0;
  const flags = { ignoreCase: false, trim: true, ignoreEmpty: true };

  const a = textArea({ id: 'compare-a', label: 'List A', hideLabel: true, mono: true, rows: 10, placeholder: 'One item per line' });
  const b = textArea({ id: 'compare-b', label: 'List B', hideLabel: true, mono: true, rows: 10, placeholder: 'One item per line' });
  const outputField = textArea({ id: 'compare-output', label: 'Comparison result', hideLabel: true, mono: true, rows: 10, readonly: true });
  const status = h('div', { class: 'json-status', id: 'compare-status', role: 'status' });
  const viewField = selectField({ id: 'compare-view', label: 'Show', value: view, groups: simple(COMPARE_VIEWS) });

  const option = (id: string, label: string, key: keyof typeof flags) => checkbox({ id, label, checked: flags[key], onChange: on => { flags[key] = on; run(); } });
  const boxes = [
    option('compare-ignore-case', 'Ignore case', 'ignoreCase'),
    option('compare-trim', 'Ignore whitespace at the ends of lines', 'trim'),
    option('compare-ignore-empty', 'Ignore empty lines', 'ignoreEmpty'),
  ];

  const lines = () => (result?.ok ? result[view] : null);
  const outputText = () => { const l = lines(); return l === null ? null : l.join('\n'); };
  const copy = copyButton(services, outputText, 'comparison result');
  const download = button({ label: 'Download', icon: 'download', onClick: () => {
    const t = outputText();
    if (t !== null) services.download(COMPARE_VIEWS.find(v => v.value === view)!.file, t === '' ? '' : `${t}\n`, 'text/plain');
  } });

  function render(): void {
    const r = result;
    if (!r) {
      outputField.control.value = '';
      replaceChildren(status);
    } else if (!r.ok) {
      outputField.control.value = '';
      replaceChildren(status, notice('error', h('p', { id: 'compare-error' }, r.message)));
    } else {
      outputField.control.value = r[view].join('\n');
      const repeats = r.repeatsA + r.repeatsB;
      replaceChildren(status,
        summaryTable('List comparison', [
          ['Distinct items in A', formatInteger(r.uniqueA)], ['Distinct items in B', formatInteger(r.uniqueB)],
          ['In both', formatInteger(r.both.length)], ['Only in A', formatInteger(r.onlyA.length)], ['Only in B', formatInteger(r.onlyB.length)], ['In either', formatInteger(r.union.length)],
        ]),
        repeats > 0 ? h('p', { class: 'reach-note', id: 'compare-repeats' }, `${plural(repeats, 'repeated line')} counted once (${formatInteger(r.repeatsA)} in A, ${formatInteger(r.repeatsB)} in B).`) : null,
      );
    }
    copy.disabled = outputText() === null;
    download.disabled = outputText() === null;
  }

  function run(): void {
    window.clearTimeout(timer);
    result = a.control.value === '' && b.control.value === '' ? null : compareLists(a.control.value, b.control.value, flags);
    render();
  }
  for (const field of [a, b]) {
    field.control.addEventListener('input', () => {
      if (a.control.value.length + b.control.value.length <= LIVE_LIMIT) run();
      else { window.clearTimeout(timer); timer = window.setTimeout(run, 300); }
    });
  }
  viewField.control.addEventListener('change', () => { view = viewField.control.value as CompareView; render(); });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { a.control.value = ''; b.control.value = ''; run(); a.control.focus(); } });
  render();
  return h('div', { class: 'tool-stack' },
    h('div', { class: 'split' }, panel('List A', [a.root], clear), panel('List B', [b.root])),
    h('div', { class: 'check-list', id: 'compare-options' }, boxes.map(x => x.root)),
    status,
    panel('Result', [viewField.root, outputField.root, h('p', { class: 'muted' }, 'Each list is treated as a set of lines: an item that appears several times counts once. Results keep the order and spelling of the first occurrence.')], [copy, download], 'result-panel'),
  );
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  const views = tabs({ id: 'text-tabs', label: 'Text tools', items: [{ id: 'lines', label: 'Lines' }, { id: 'compare', label: 'Compare lists' }] });
  views.panels.lines.appendChild(transformView(services));
  views.panels.compare.appendChild(compareView(services));
  host.appendChild(toolPage(meta, categoryName,
    views.root,
    h('p', { class: 'source-note' }, `Sorting and comparing use Unicode code points (or lowercase forms when case is ignored), so results are the same on every device and do not follow any one language's alphabet. Limits: ${formatInteger(TEXT_LIMITS.chars)} characters and ${formatInteger(TEXT_LIMITS.lines)} lines.`),
  ));
}
