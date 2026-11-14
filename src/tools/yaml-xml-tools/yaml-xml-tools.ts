/**
 * YAML/XML Tools: validate and format YAML and XML, and convert YAML to JSON, JSON to YAML and
 * XML to JSON. Parsing runs in a worker with a time limit. Whatever a conversion cannot carry
 * across (comments, anchors, layout whitespace) is listed with the result, never dropped quietly.
 * XML is read by NetForge's own parser, which cannot load external entities, DTDs or anything else.
 */
import type { DataResult } from '../../core/data/data-result';
import { XML_LIMITS, YAML_LIMITS } from '../../core/data/limits';
import { formatInteger } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, copyButton, notice, panel, segmented, selectField, textArea, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { createRunner, failureText } from '../util-shared/worker-client';
import { goToOffset, noteList, offsetOf, statusLine } from '../util-shared/util-view';
import type { DataOperation, DataRequest } from './data.worker';

const TIMEOUT_MS = 30_000;

interface OperationInfo {
  readonly label: string;
  readonly input: string;
  readonly output: string;
  readonly file: string;
  readonly mime: string;
  readonly sample: string;
  readonly limit: number;
}

const YAML_SAMPLE = [
  '# Service settings', 'service: edge-proxy', 'replicas: 3', 'listen:', '  - 0.0.0.0:443', '  - "[::]:443"',
  'limits: &limits', '  rps: 1e3', '  burst: 250', 'staging:', '  limits: *limits', 'enabled: true', '',
].join('\n');
const JSON_SAMPLE = '{"service":"edge-proxy","replicas":3,"listen":["0.0.0.0:443","[::]:443"],"limits":{"rps":1.0e3,"burst":250},"enabled":true,"note":"yes"}';
const XML_SAMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>', '<!-- Device inventory -->',
  '<inventory xmlns:net="urn:example:net"><device id="sw1" net:role="core"><name>Core switch</name><port n="1"/><port n="2"/></device>',
  '<device id="fw1"><name>Edge &amp; DMZ firewall</name><note><![CDATA[rules < 100]]></note></device></inventory>', '',
].join('\n');

const OPERATIONS: Readonly<Record<DataOperation, OperationInfo>> = {
  'yaml-format': { label: 'YAML: validate and format', input: 'YAML', output: 'Formatted YAML', file: 'formatted.yaml', mime: 'application/yaml', sample: YAML_SAMPLE, limit: YAML_LIMITS.inputChars },
  'yaml-json': { label: 'YAML to JSON', input: 'YAML', output: 'JSON', file: 'converted.json', mime: 'application/json', sample: YAML_SAMPLE, limit: YAML_LIMITS.inputChars },
  'json-yaml': { label: 'JSON to YAML', input: 'JSON', output: 'YAML', file: 'converted.yaml', mime: 'application/yaml', sample: JSON_SAMPLE, limit: YAML_LIMITS.inputChars },
  'xml-format': { label: 'XML: validate and format', input: 'XML', output: 'Formatted XML', file: 'formatted.xml', mime: 'application/xml', sample: XML_SAMPLE, limit: XML_LIMITS.inputChars },
  'xml-minify': { label: 'XML: validate and minify', input: 'XML', output: 'Minified XML', file: 'minified.xml', mime: 'application/xml', sample: XML_SAMPLE, limit: XML_LIMITS.inputChars },
  'xml-json': { label: 'XML to JSON', input: 'XML', output: 'JSON', file: 'converted.json', mime: 'application/json', sample: XML_SAMPLE, limit: XML_LIMITS.inputChars },
};

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let operation: DataOperation = 'yaml-format';
  let indent: DataRequest['indent'] = '2';
  let keepWhitespace = false;
  let result: DataResult | null = null;
  let timer = 0;
  const runner = createRunner<DataRequest, DataResult>(() => new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' }), TIMEOUT_MS);

  const operationField = selectField({
    id: 'data-operation', label: 'Operation', value: operation,
    groups: [
      { label: 'YAML', options: (['yaml-format', 'yaml-json', 'json-yaml'] as const).map(o => ({ value: o, label: OPERATIONS[o].label })) },
      { label: 'XML', options: (['xml-format', 'xml-minify', 'xml-json'] as const).map(o => ({ value: o, label: OPERATIONS[o].label })) },
    ],
  });
  const indentControl = segmented({
    label: 'Indent', name: 'data-indent', value: indent,
    choices: [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: 'tab', label: 'Tab' }],
    onChange: value => { indent = value as DataRequest['indent']; schedule(0); },
  });
  const whitespace = checkbox({ id: 'data-keep-whitespace', label: 'Keep whitespace between tags', onChange: on => { keepWhitespace = on; schedule(0); } });
  const inputField = textArea({ id: 'data-input', label: 'Input', hideLabel: true, mono: true, rows: 16, placeholder: 'Paste YAML' });
  const outputField = textArea({ id: 'data-output', label: 'Output', hideLabel: true, mono: true, rows: 16, readonly: true, placeholder: 'The result appears here.' });
  const input = inputField.control;
  const output = outputField.control;
  const status = h('div', { class: 'json-status', id: 'data-status', role: 'status' });
  const inputTitle = h('span', null, 'Input');
  const yamlTabNote = h('p', { class: 'hint', id: 'data-tab-note', hidden: true }, 'YAML does not allow tabs for indentation, so Tab uses 2 spaces for YAML output.');

  const outputText = () => (result?.ok && result.output !== '' ? result.output : null);
  const copy = copyButton(services, outputText, 'output');
  const download = button({ label: 'Download', icon: 'download', onClick: () => { const t = outputText(); if (t !== null) services.download(OPERATIONS[operation].file, t, OPERATIONS[operation].mime); } });

  function syncControls(): void {
    const info = OPERATIONS[operation];
    input.placeholder = `Paste ${info.input}`;
    indentControl.root.hidden = operation === 'xml-minify';
    whitespace.root.hidden = operation !== 'xml-json';
    yamlTabNote.hidden = !(indent === 'tab' && (operation === 'yaml-format' || operation === 'json-yaml'));
    inputTitle.textContent = `Input (${info.input})`;
  }

  function render(): void {
    const r = result;
    syncControls();
    inputField.setError(null);
    if (!r) {
      output.value = '';
      replaceChildren(status);
    } else if (!r.ok) {
      output.value = '';
      const first = r.errors[0];
      replaceChildren(status,
        statusLine('error', `Invalid ${OPERATIONS[operation].input}`),
        notice('error',
          h('ul', { class: 'problem-list', id: 'data-errors' }, r.errors.map(e => h('li', null, h('strong', null, `Line ${e.line}, column ${e.column}: `), e.message))),
          r.omitted > 0 ? h('p', null, `${formatInteger(r.omitted)} more not shown.`) : null,
          h('p', null, h('button', { type: 'button', class: 'btn btn-secondary', id: 'data-goto', onclick: () => goToOffset(input, offsetOf(input.value, first.line, first.column)) }, 'Go to error')),
        ),
      );
      input.setAttribute('aria-invalid', 'true');
    } else {
      output.value = r.output;
      replaceChildren(status,
        statusLine('ok', r.summary),
        r.warnings.length > 0 ? notice('warning', h('ul', { class: 'warning-list', id: 'data-warnings' }, r.warnings.map(w => h('li', null, `Line ${w.line}, column ${w.column}: ${w.message}`)))) : null,
        r.notes.length > 0 ? h('div', { class: 'result-section' }, h('p', { class: 'sub-title' }, 'About this result'), noteList(r.notes, 'data-notes')) : null,
      );
    }
    copy.disabled = outputText() === null;
    download.disabled = outputText() === null;
  }

  async function run(): Promise<void> {
    const text = input.value;
    if (text === '') { result = null; render(); return; }
    const info = OPERATIONS[operation];
    if (text.length > info.limit) {
      result = { ok: false, errors: [{ line: 1, column: 1, message: `The ${info.input} has ${formatInteger(text.length)} characters; the limit is ${formatInteger(info.limit)}. Nothing was processed.` }], omitted: 0 };
      render();
      return;
    }
    const outcome = await runner.run({ operation, text, indent, keepWhitespace });
    if (outcome.status === 'superseded') return;
    if (outcome.status === 'done' && outcome.value.ok) {
      result = outcome.value.value;
      render();
      return;
    }
    result = null;
    render();
    const message = outcome.status === 'done' ? `The ${info.input} could not be processed: ${(outcome.value as { message: string }).message}` : failureText(outcome, 'processing');
    replaceChildren(status, notice('error', h('p', { id: 'data-failure', 'data-outcome': outcome.status }, message)));
  }

  function schedule(delay: number): void {
    window.clearTimeout(timer);
    syncControls();
    timer = window.setTimeout(() => { void run(); }, delay);
  }

  input.addEventListener('input', () => schedule(input.value.length > 100_000 ? 500 : 200));
  operationField.control.addEventListener('change', () => { operation = operationField.control.value as DataOperation; result = null; render(); schedule(0); });
  const sample = button({ label: 'Example', variant: 'ghost', onClick: () => { input.value = OPERATIONS[operation].sample; schedule(0); input.focus(); } });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { input.value = ''; schedule(0); input.focus(); } });

  const inputPanel = panel('Input', [inputField.root], [sample, clear]);
  inputPanel.querySelector('.panel-title')!.replaceChildren(inputTitle);
  host.appendChild(toolPage(meta, categoryName,
    h('div', { class: 'controls-row' }, operationField.root, indentControl.root),
    h('div', { class: 'option-stack' }, whitespace.root, yamlTabNote),
    status,
    h('div', { class: 'split' }, inputPanel, panel('Output', [outputField.root], [copy, download])),
    h('p', { class: 'source-note' },
      'YAML follows version 1.2 (core schema), read by the bundled "yaml" parser. XML is checked for well-formedness and namespaces by NetForge\'s own XML 1.0 parser: it never loads a DTD, an external entity or any other resource, and it expands no entities beyond the five built into XML.'),
  ));
  render();
}
