/** JSON Formatter: validate, pretty-print or minify, keeping every value exactly as written. */
import { analyzeJson, INDENTS, type IndentChoice, type JsonAnalysis } from '../../core/data/json';
import { formatByteSize, formatInteger, utf8Length } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, notice, panel, segmented, textArea, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { icon } from '../../ui/icons';

/** Above this size, analysis waits for a pause in typing instead of running on every keystroke. */
const LIVE_LIMIT = 200_000;

const SAMPLE = '{"service":"edge-proxy","replicas":3,"enabled":true,"listen":["0.0.0.0:443","[::]:443"],"limits":{"rps":1.0e3,"burst":250},"build":12345678901234567890,"owner":null}';

type Mode = 'pretty' | 'minify';

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let mode: Mode = 'pretty';
  let indent = services.prefs.get('jsonIndent') as IndentChoice;
  let result: JsonAnalysis | null = null;
  let timer = 0;

  const inputField = textArea({ id: 'json-input', label: 'JSON input', hideLabel: true, placeholder: 'Paste or type JSON', mono: true, rows: 16 });
  const outputField = textArea({ id: 'json-output', label: 'JSON output', hideLabel: true, placeholder: 'The formatted JSON appears here.', mono: true, rows: 16, readonly: true,
    hint: 'Only whitespace changes. Numbers, strings, escapes and duplicate names are kept exactly as written.' });
  const input = inputField.control;
  const output = outputField.control;
  const status = h('div', { class: 'json-status', id: 'json-status', role: 'status' });

  const modeControl = segmented({
    label: 'Output', name: 'json-mode', value: mode,
    choices: [{ value: 'pretty', label: 'Pretty' }, { value: 'minify', label: 'Minified' }],
    onChange: value => { mode = value as Mode; indentControl.root.hidden = mode !== 'pretty'; analyze(); },
  });
  const indentControl = segmented({
    label: 'Indent', name: 'json-indent', value: indent,
    choices: [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tab' }],
    onChange: value => { indent = value as IndentChoice; services.prefs.set('jsonIndent', indent); analyze(); },
  });

  const outputText = () => (result?.ok && result.output !== null ? result.output : null);
  const copy = copyButton(services, outputText, 'JSON output');
  const download = button({
    label: 'Download', icon: 'download', onClick: () => {
      const text = outputText();
      if (text !== null) services.download(mode === 'pretty' ? 'formatted.json' : 'minified.json', text, 'application/json');
    },
  });
  const clearButton = button({ label: 'Clear', variant: 'ghost', onClick: () => { input.value = ''; analyze(); input.focus(); } });
  const sampleButton = button({ label: 'Example', variant: 'ghost', onClick: () => { input.value = SAMPLE; analyze(); input.focus(); } });

  function goTo(offset: number, line: number): void {
    input.focus();
    input.setSelectionRange(offset, Math.min(offset + 1, input.value.length));
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
    input.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }

  function render(): void {
    const r = result;
    if (!r) {
      replaceChildren(status);
      output.value = '';
    } else if (!r.ok) {
      const { line, column, offset } = r.error.location;
      replaceChildren(status,
        h('p', { class: 'status-line status-error' }, icon('error'), h('strong', null, 'Invalid JSON')),
        notice('error',
          h('p', null, h('strong', null, `Line ${line}, column ${column}: `), r.error.message),
          h('p', null, h('button', { type: 'button', class: 'btn btn-secondary', id: 'json-goto', onclick: () => goTo(offset, line) }, 'Go to error')),
        ),
      );
      output.value = '';
    } else {
      const s = r.stats;
      const bytes = formatByteSize(utf8Length(input.value));
      const detail = `${s.rootType}, ${formatInteger(s.values)} ${s.values === 1 ? 'value' : 'values'}, depth ${s.maxDepth}, ${bytes}`;
      replaceChildren(status,
        h('p', { class: 'status-line status-ok' }, icon('ok'), h('strong', null, 'Valid JSON'), h('span', { class: 'status-detail' }, detail)),
        r.outputTooLarge ? notice('warning', 'The formatted output would be larger than 50 MB, mostly indentation, so it is not shown. Try Minified.') : null,
      );
      output.value = r.output ?? '';
    }
    if (r && r.warnings.length > 0) {
      status.appendChild(notice('warning',
        h('p', null, h('strong', null, `${r.warnings.length + r.omittedWarnings} ${r.warnings.length + r.omittedWarnings === 1 ? 'warning' : 'warnings'}`)),
        h('ul', { class: 'warning-list' }, r.warnings.map(w => h('li', null, `Line ${w.location.line}, column ${w.location.column}: ${w.message}`))),
        r.omittedWarnings > 0 ? h('p', null, `${r.omittedWarnings} more not shown.`) : null,
      ));
    }
    const has = outputText() !== null;
    copy.disabled = !has;
    download.disabled = !has;
    inputField.setError(null);
    if (r && !r.ok) input.setAttribute('aria-invalid', 'true');
  }

  function analyze(): void {
    window.clearTimeout(timer);
    const text = input.value;
    result = text === '' ? null : analyzeJson(text, mode === 'pretty' ? { kind: 'pretty', indent: INDENTS[indent] } : { kind: 'minify' });
    render();
  }

  input.addEventListener('input', () => {
    if (input.value.length <= LIVE_LIMIT) analyze();
    else {
      window.clearTimeout(timer);
      timer = window.setTimeout(analyze, 300);
    }
  });

  indentControl.root.hidden = mode !== 'pretty';
  host.appendChild(toolPage(meta, categoryName,
    h('div', { class: 'controls-row' }, modeControl.root, indentControl.root),
    status,
    h('div', { class: 'split' },
      panel('Input', [inputField.root], [sampleButton, clearButton]),
      panel('Output', [outputField.root], [copy, download]),
    ),
  ));
  render();
}
