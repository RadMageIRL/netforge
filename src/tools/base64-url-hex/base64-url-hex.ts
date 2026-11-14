/**
 * Base64 / URL / Hex: read the input as one representation of some bytes and write those bytes as
 * another. Strict by default; malformed input is an error with its position, not a guess.
 */
import { convert, MAX_INPUT_CHARS, REPRESENTATIONS, type ConvertOptions, type ConvertResult, type Representation } from '../../core/codec/convert';
import { formatByteSize, formatInteger } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, copyButton, notice, panel, selectField, textArea, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { downloadBytes } from '../../ui/download';
import { goToOffset, plural, statusLine } from '../util-shared/util-view';

/** Above this size, conversion waits for a pause in typing. */
const LIVE_LIMIT = 200_000;

const EXTENSIONS: Readonly<Record<Representation, string>> = { text: 'txt', base64: 'base64.txt', base64url: 'base64url.txt', hex: 'hex.txt', url: 'url.txt' };

// "Hello" in several scripts and one emoji, built from code points so this source stays ASCII.
const SAMPLE = `NetForge: caf${String.fromCodePoint(0xe9)}, ${String.fromCodePoint(0x4f60, 0x597d)}, ${String.fromCodePoint(0x1f680)}`;

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let from: Representation = 'text';
  let to: Representation = 'base64';
  let result: ConvertResult | null = null;
  let timer = 0;
  const flags = { lenient: false, replaceInvalid: false, plusAsSpace: false, upperHex: false };

  const groups = [{ label: null, options: REPRESENTATIONS.map(r => ({ value: r.id, label: r.label })) }];
  const fromField = selectField({ id: 'codec-from', label: 'Input is', groups, value: from });
  const toField = selectField({ id: 'codec-to', label: 'Convert to', groups, value: to });
  const inputField = textArea({ id: 'codec-input', label: 'Input', hideLabel: true, placeholder: 'Paste or type the text or encoded data', mono: true, rows: 12 });
  const outputField = textArea({ id: 'codec-output', label: 'Output', hideLabel: true, placeholder: 'The converted output appears here.', mono: true, rows: 12, readonly: true });
  const input = inputField.control;
  const output = outputField.control;
  input.setAttribute('wrap', 'soft');
  output.setAttribute('wrap', 'soft');
  const status = h('div', { class: 'json-status', id: 'codec-status', role: 'status' });

  const option = (id: string, label: string, key: keyof typeof flags) => checkbox({ id, label, onChange: checked => { flags[key] = checked; run(); } });
  const lenient = option('codec-lenient', 'Ignore whitespace and separators in Base64 and hex input (and accept missing padding)', 'lenient');
  const replace = option('codec-replace', 'Replace invalid UTF-8 with the replacement character (U+FFFD) instead of stopping', 'replaceInvalid');
  const plus = option('codec-plus', 'URL: treat "+" as a space (HTML form encoding)', 'plusAsSpace');
  const upper = option('codec-upper', 'Write hex in uppercase', 'upperHex');

  const outputText = () => (result?.ok ? result.value.output : null);
  const bytes = () => (result?.ok ? result.value.bytes : result?.bytes ?? null);
  const copy = copyButton(services, outputText, 'converted output');
  const download = button({
    label: 'Download', icon: 'download', onClick: () => {
      const text = outputText();
      if (text !== null) services.download(`converted.${EXTENSIONS[to]}`, text, 'text/plain');
    },
  });
  const downloadRaw = button({
    label: 'Download bytes', icon: 'download', title: 'Save the decoded data itself as a binary file', onClick: () => {
      const data = bytes();
      if (data) services.announce(`Saved ${downloadBytes('decoded.bin', data)}`);
    },
  });
  const swap = button({
    label: 'Swap', title: 'Use the output as the input and convert back', id: 'codec-swap', onClick: () => {
      const text = outputText();
      [from, to] = [to, from];
      fromField.control.value = from;
      toField.control.value = to;
      if (text !== null) input.value = text;
      run();
    },
  });

  function render(): void {
    const r = result;
    lenient.root.hidden = !(from === 'base64' || from === 'base64url' || from === 'hex');
    replace.root.hidden = !(from === 'text' || to === 'text');
    plus.root.hidden = !(from === 'url' || to === 'url');
    upper.root.hidden = to !== 'hex';
    inputField.setError(null);
    if (!r) {
      replaceChildren(status);
      output.value = '';
    } else if (!r.ok) {
      output.value = '';
      const offset = r.error.offset;
      const canGo = r.stage === 'input' && offset !== undefined && r.error.code !== 'too-large';
      replaceChildren(status,
        statusLine('error', r.stage === 'input' ? 'The input could not be read' : 'The data cannot be written as text'),
        notice('error',
          h('p', { id: 'codec-error' }, r.error.message),
          r.stage === 'output' ? h('p', null, `The input decoded to ${formatByteSize(r.bytes!.length)}. Choose Hex or Base64 as the output to see them, use Download bytes, or turn on the replacement option.`) : null,
          canGo ? h('p', null, h('button', { type: 'button', class: 'btn btn-secondary', id: 'codec-goto', onclick: () => goToOffset(input, offset) }, 'Go to position')) : null,
        ),
      );
      if (r.stage === 'input') input.setAttribute('aria-invalid', 'true');
    } else {
      output.value = r.value.output;
      const detail = `${plural(input.value.length, 'character')} in, ${formatByteSize(r.value.bytes.length)} of data, ${plural(r.value.output.length, 'character')} out`;
      replaceChildren(status,
        statusLine('ok', 'Converted', detail),
        r.value.replaced > 0 ? notice('warning', `${plural(r.value.replaced, 'invalid sequence')} replaced with U+FFFD. The output does not match the original data exactly.`) : null,
      );
    }
    copy.disabled = outputText() === null;
    download.disabled = outputText() === null;
    downloadRaw.disabled = bytes() === null;
    swap.disabled = r !== null && !r.ok;
  }

  function run(): void {
    window.clearTimeout(timer);
    const options: ConvertOptions = { ...flags };
    result = input.value === '' ? null : convert(input.value, from, to, options);
    render();
  }

  input.addEventListener('input', () => {
    if (input.value.length <= LIVE_LIMIT) run();
    else {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 300);
    }
  });
  fromField.control.addEventListener('change', () => { from = fromField.control.value as Representation; run(); });
  toField.control.addEventListener('change', () => { to = toField.control.value as Representation; run(); });

  const sample = button({ label: 'Example', variant: 'ghost', onClick: () => { from = 'text'; fromField.control.value = from; input.value = SAMPLE; run(); input.focus(); } });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { input.value = ''; run(); input.focus(); } });

  host.appendChild(toolPage(meta, categoryName,
    h('div', { class: 'controls-row codec-controls' }, fromField.root, toField.root, h('div', { class: 'toolbar' }, swap)),
    h('div', { class: 'option-stack', id: 'codec-options' }, lenient.root, replace.root, plus.root, upper.root),
    status,
    h('div', { class: 'split' },
      panel('Input', [inputField.root], [sample, clear]),
      panel('Output', [outputField.root], [copy, download, downloadRaw]),
    ),
    h('p', { class: 'source-note' }, `Text is UTF-8. Base64 follows RFC 4648 (the URL-safe alphabet uses "-" and "_" and is written without padding). URL encoding keeps only letters, digits and - . _ ~ (RFC 3986) and writes everything else as %XX. Input is limited to ${formatInteger(MAX_INPUT_CHARS)} characters.`),
  ));
  render();
}
