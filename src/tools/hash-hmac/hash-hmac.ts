/**
 * Hash / HMAC: SHA-256, SHA-384, SHA-512, legacy SHA-1 and MD5, and HMAC with the SHA-2 family,
 * for text or a file. Hashing runs in a worker on this device. Keys and file contents are held
 * only while a digest is being computed: nothing is stored and nothing is sent anywhere.
 */
import { matchExpected, MAX_HASH_BYTES, parseKey, type KeyFormat } from '../../core/crypto/digest';
import { formatByteSize } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, emptyState, notice, panel, segmented, textArea, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { createRunner, failureText } from '../util-shared/worker-client';
import { statusLine } from '../util-shared/util-view';
import type { HashReply, HashRequest } from './hash.worker';

const TEXT_LIMIT = 8_000_000;
/** Enough for the largest file on a slow device; a stuck worker is still stopped. */
const TIMEOUT_MS = 120_000;

type Mode = 'hash' | 'hmac';
type Source = 'text' | 'file';

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let mode: Mode = 'hash';
  let source: Source = 'text';
  let keyFormat: KeyFormat = 'text';
  let file: File | null = null;
  let reply: HashReply | null = null;
  let timer = 0;
  const runner = createRunner<HashRequest, HashReply>(() => new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' }), TIMEOUT_MS);

  const textInput = textArea({ id: 'hash-text', label: 'Text to hash', placeholder: 'Type or paste text. It is hashed as UTF-8, exactly as entered.', mono: true, rows: 8,
    hint: 'Hashed byte for byte as UTF-8. A trailing line break changes the result, so none is added or removed.' });
  textInput.control.setAttribute('wrap', 'soft');
  const fileInput = h('input', { type: 'file', id: 'hash-file', class: 'input file-input', 'aria-describedby': 'hash-file-hint' });
  const fileInfo = h('p', { class: 'hint', id: 'hash-file-hint' }, `The file is read and hashed on this device, up to ${formatByteSize(MAX_HASH_BYTES)}. It is never uploaded.`);
  const fileField = h('div', { class: 'field', hidden: true }, h('label', { for: 'hash-file', class: 'field-label' }, 'File to hash'), fileInput, fileInfo);

  const keyField = textField({ id: 'hash-key', label: 'Secret key', mono: true, placeholder: 'The HMAC key',
    hint: 'Used only to compute the HMAC on this device. It is not stored, and it is gone when you leave or reload the page.' });
  const keyFormatControl = segmented({
    label: 'Key is', name: 'hash-key-format', value: keyFormat,
    choices: [{ value: 'text', label: 'Text (UTF-8)' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }],
    onChange: value => { keyFormat = value as KeyFormat; schedule(0); },
  });
  const keyRow = h('div', { class: 'controls-row', id: 'hash-key-row', hidden: true }, keyField.root, keyFormatControl.root);

  const expected = textField({ id: 'hash-expected', label: 'Compare with (optional)', mono: true, placeholder: 'Paste a published checksum to compare',
    hint: 'Hex is compared ignoring case; Base64 must match exactly.' });
  const status = h('div', { class: 'json-status', id: 'hash-status', role: 'status' });
  const results = h('div', { class: 'result-area', id: 'hash-results' });
  const compare = h('div', { id: 'hash-compare' });

  const modeControl = segmented({
    label: 'Compute', name: 'hash-mode', value: mode,
    choices: [{ value: 'hash', label: 'Hash' }, { value: 'hmac', label: 'HMAC' }],
    onChange: value => { mode = value as Mode; keyRow.hidden = mode !== 'hmac'; schedule(0); },
  });
  const sourceControl = segmented({
    label: 'Input', name: 'hash-source', value: source,
    choices: [{ value: 'text', label: 'Text' }, { value: 'file', label: 'File' }],
    onChange: value => {
      source = value as Source;
      textInput.root.hidden = source !== 'text';
      fileField.hidden = source !== 'file';
      schedule(0);
    },
  });

  function renderCompare(): void {
    const want = expected.control.value;
    const rows = reply?.rows.filter(r => r.digest) ?? [];
    if (want.trim() === '' || rows.length === 0) { replaceChildren(compare); return; }
    const match = matchExpected(want, rows.map(r => r.digest!));
    replaceChildren(compare, match
      ? notice('ok', h('strong', null, 'Match. '), `The value equals the ${rows[match.index].label} digest (${match.form === 'hex' ? 'hex' : 'Base64'}).${rows[match.index].caution ? ` ${rows[match.index].label} is a legacy algorithm: a match shows the data is not accidentally damaged, not that nobody tampered with it.` : ''}`)
      : notice('error', h('strong', null, 'No match. '), 'The value does not equal any digest shown here. The data differs, or the checksum uses another algorithm or encoding.'));
  }

  function renderRows(): void {
    if (!reply) { replaceChildren(results, emptyState(mode === 'hmac' ? 'Enter a key and some text, or choose a file.' : 'Enter text or choose a file to see its hashes.')); return; }
    const list = h('div', { class: 'hash-list', id: 'hash-list' }, reply.rows.map(row => {
      const head = h('h3', { class: 'sub-title hash-name' }, row.label, row.caution ? h('span', { class: 'badge badge-warning hash-legacy' }, 'Legacy') : null);
      if (!row.digest) return h('section', { class: 'hash-item', 'data-key': row.id }, head, h('p', { class: 'muted' }, row.unavailable));
      const line = (form: 'hex' | 'base64', label: string) => h('div', { class: 'hash-line', 'data-key': `${row.id}-${form}` },
        h('span', { class: 'hash-form' }, label),
        h('span', { class: 'mono hash-value' }, row.digest![form]),
        copyButton(services, () => row.digest![form], `${row.label} ${label}`, { iconOnly: true }),
      );
      return h('section', { class: 'hash-item', 'data-key': row.id }, head, line('hex', 'Hex'), line('base64', 'Base64'));
    }));
    const cautions = reply.rows.filter(r => r.caution);
    replaceChildren(results,
      list,
      cautions.length > 0 ? notice('warning', h('ul', { class: 'warning-list', id: 'hash-cautions' }, cautions.map(c => h('li', null, h('strong', null, `${c.label}: `), c.caution)))) : null,
    );
  }

  async function compute(): Promise<void> {
    keyField.setError(null);
    textInput.setError(null);
    let key: Uint8Array | null = null;
    if (mode === 'hmac') {
      if (keyField.control.value === '') { reply = null; replaceChildren(status); renderRows(); renderCompare(); return; }
      const parsed = parseKey(keyField.control.value, keyFormat);
      if (!parsed.ok) { keyField.setError(parsed.error.message); reply = null; replaceChildren(status); renderRows(); renderCompare(); return; }
      key = parsed.value;
    }
    let request: HashRequest;
    let what: string;
    if (source === 'text') {
      const text = textInput.control.value;
      if (text === '' && mode === 'hash') { reply = null; replaceChildren(status); renderRows(); renderCompare(); return; }
      if (text.length > TEXT_LIMIT) {
        textInput.setError(`The text has ${text.length.toLocaleString('en-US')} characters; the limit is ${TEXT_LIMIT.toLocaleString('en-US')}. Save it as a file and hash the file instead.`);
        reply = null; replaceChildren(status); renderRows(); renderCompare();
        return;
      }
      request = { source: { kind: 'text', text }, key };
      what = 'text';
    } else {
      if (!file) { reply = null; replaceChildren(status); renderRows(); renderCompare(); return; }
      if (file.size > MAX_HASH_BYTES) {
        reply = null;
        replaceChildren(status, notice('error', h('p', { id: 'hash-error' }, `${file.name} is ${formatByteSize(file.size)}; the limit is ${formatByteSize(MAX_HASH_BYTES)}. The browser must hold the whole file in memory to hash it, so larger files are refused rather than risk freezing the page. Nothing was hashed.`)));
        renderRows(); renderCompare();
        return;
      }
      request = { source: { kind: 'file', file }, key };
      what = file.name;
    }
    if (source === 'file') replaceChildren(status, h('p', { class: 'loading', id: 'hash-busy' }, `Hashing ${what} (${formatByteSize(file!.size)})...`));
    const outcome = await runner.run(request);
    if (outcome.status !== 'done') {
      const message = failureText(outcome, 'hashing');
      if (message === null) return;
      reply = null;
      replaceChildren(status, notice('error', h('p', { id: 'hash-error' }, message)));
    } else if (!outcome.value.ok) {
      reply = null;
      replaceChildren(status, notice('error', h('p', { id: 'hash-error' }, `The input could not be hashed: ${outcome.value.message}`)));
    } else {
      reply = outcome.value.value;
      const subject = source === 'file' ? `${what}, ` : '';
      replaceChildren(status, statusLine('ok', mode === 'hmac' ? 'HMAC computed' : 'Hashed', `${subject}${formatByteSize(reply.bytes)}${key ? `, key of ${formatByteSize(key.length)}` : ''}`));
    }
    renderRows();
    renderCompare();
  }

  function schedule(delay: number): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void compute(); }, delay);
  }

  textInput.control.addEventListener('input', () => schedule(textInput.control.value.length > 100_000 ? 400 : 120));
  keyField.control.addEventListener('input', () => schedule(120));
  expected.control.addEventListener('input', renderCompare);
  fileInput.addEventListener('change', () => {
    file = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
    schedule(0);
  });
  const clear = button({
    label: 'Clear', variant: 'ghost', onClick: () => {
      textInput.control.value = '';
      keyField.control.value = '';
      expected.control.value = '';
      fileInput.value = '';
      file = null;
      schedule(0);
    },
  });

  host.appendChild(toolPage(meta, categoryName,
    h('div', { class: 'controls-row' }, modeControl.root, sourceControl.root),
    panel('Input', [keyRow, textInput.root, fileField], clear),
    status,
    panel('Result', [results, expected.root, compare], undefined, 'result-panel'),
    h('p', { class: 'source-note' }, 'SHA-1, SHA-256, SHA-384, SHA-512 and HMAC are computed by the browser\'s Web Crypto API. MD5 is not part of Web Crypto, so NetForge includes its own implementation of RFC 1321 for checking old checksums.'),
  ));
  renderRows();
}
