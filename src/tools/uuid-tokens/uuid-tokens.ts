/**
 * UUID / Random Tokens: UUID versions 4 and 7 and random tokens in hex or Base64URL. Every random
 * bit comes from crypto.getRandomValues, the browser's cryptographically secure generator.
 * Generated values exist only on this page until you copy or download them.
 */
import { generate, TOKEN_LIMITS, type Generated, type RandomFill, type TokenKind } from '../../core/random/tokens';
import { formatInteger } from '../../core/format';
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { readTokenShare, tokenOffer } from './uuid-share';
import { button, copyButton, notice, panel, selectField, textArea, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { noteList, numberField, plural, statusLine } from '../util-shared/util-view';

const KINDS: readonly { value: TokenKind; label: string }[] = [
  { value: 'uuid-v4', label: 'UUID version 4 (random)' },
  { value: 'uuid-v7', label: 'UUID version 7 (time-ordered)' },
  { value: 'hex', label: 'Random token, hexadecimal' },
  { value: 'base64url', label: 'Random token, Base64URL' },
];

/** getRandomValues accepts at most 65,536 bytes per call. */
const secureFill: RandomFill = bytes => {
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)) as Uint8Array<ArrayBuffer>);
  }
};

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  let kind: TokenKind = 'uuid-v4';
  let generated: Generated | null = null;

  const kindField = selectField({ id: 'token-kind', label: 'Generate', groups: [{ label: null, options: KINDS }], value: kind });
  const count = numberField({ id: 'token-count', label: 'How many', value: '1', hint: `1 to ${formatInteger(TOKEN_LIMITS.maxCount)}`, onInput: () => { count.setError(null); } });
  const bytes = numberField({ id: 'token-bytes', label: 'Bytes per token', value: '32', hint: `1 to ${formatInteger(TOKEN_LIMITS.maxBytes)}. 32 bytes is 256 bits.`, onInput: () => { bytes.setError(null); } });
  const outputField = textArea({ id: 'token-output', label: 'Generated values', hideLabel: true, mono: true, rows: 10, readonly: true, placeholder: 'Press Generate.' });
  const output = outputField.control;
  const status = h('div', { class: 'json-status', id: 'token-status', role: 'status' });
  const notes = h('div', { id: 'token-notes' });

  const text = () => (generated ? generated.values.join('\n') : null);
  const copy = copyButton(services, text, 'generated values');
  const download = button({ label: 'Download', icon: 'download', onClick: () => { const t = text(); if (t !== null) services.download(kind.startsWith('uuid') ? 'uuids.txt' : 'tokens.txt', `${t}\n`, 'text/plain'); } });

  const wholeNumber = (value: string) => (/^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : NaN);

  function render(): void {
    bytes.root.hidden = kind === 'uuid-v4' || kind === 'uuid-v7';
    copy.disabled = generated === null;
    download.disabled = generated === null;
    if (!generated) {
      output.value = '';
      replaceChildren(status);
      replaceChildren(notes);
      return;
    }
    output.value = generated.values.join('\n');
    replaceChildren(status, statusLine('ok', `Generated ${plural(generated.values.length, 'value')}`,
      `${plural(generated.length, 'character')} each, ${kind === 'uuid-v7' ? 'at least ' : ''}${generated.randomBits} random bits each`));
    replaceChildren(notes, noteList(generated.notes, 'token-note-list'));
  }

  function run(): void {
    count.setError(null);
    bytes.setError(null);
    if (!globalThis.crypto?.getRandomValues) {
      generated = null;
      render();
      replaceChildren(status, notice('error', 'This browser does not provide a secure random generator, so nothing was generated. NetForge never falls back to a weaker one.'));
      return;
    }
    const result = generate({ kind, count: wholeNumber(count.control.value), byteLength: wholeNumber(bytes.control.value) }, secureFill, () => Date.now());
    if (!result.ok) {
      (result.error.code === 'count' ? count : bytes).setError(result.error.message);
      generated = null;
      render();
      return;
    }
    generated = result.value;
    render();
    services.announce(`Generated ${plural(generated.values.length, 'value')}`);
  }

  kindField.control.addEventListener('change', () => { kind = kindField.control.value as TokenKind; generated = null; render(); });
  for (const field of [count, bytes]) field.control.addEventListener('keydown', event => { if (event.key === 'Enter') run(); });
  const generateButton = button({ label: 'Generate', variant: 'primary', id: 'token-generate', onClick: run });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { generated = null; render(); } });

  host.appendChild(toolPage(meta, categoryName,
    panel('Options', [
      h('div', { class: 'controls-row' }, kindField.root, count.root, bytes.root),
      h('div', { class: 'toolbar' }, generateButton),
    ]),
    status,
    panel('Generated', [outputField.root, notes], [copy, download, clear], 'result-panel'),
    h('p', { class: 'source-note' }, 'Randomness comes from crypto.getRandomValues, the secure generator built into the browser, and never from a predictable one. Values are not stored: copy or download what you need before leaving the page.'),
  ));
  render();

  return {
    share: {
      offer: () => tokenOffer(kind, count.control.value, bytes.control.value),
      // Fills in the options only. Nothing is generated until Generate is pressed.
      apply(params) {
        const s = readTokenShare(params);
        if (!s) return false;
        kind = s.kind;
        kindField.control.value = s.kind;
        count.control.value = String(s.count);
        if (s.bytes !== null) bytes.control.value = String(s.bytes);
        count.setError(null);
        bytes.setError(null);
        generated = null;
        render();
        return true;
      },
    },
  };
}
