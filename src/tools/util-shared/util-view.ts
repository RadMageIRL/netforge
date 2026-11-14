/** Display pieces shared by the Phase 4 utilities. */
import { formatInteger } from '../../core/format';
import { h, type Child } from '../../ui/dom';
import { icon } from '../../ui/icons';

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInteger(n)} ${n === 1 ? one : many}`;
}

/** A status line with an icon: "Valid ..." or "Invalid ...". */
export function statusLine(kind: 'ok' | 'error', title: string, detail?: string): HTMLElement {
  return h('p', { class: `status-line status-${kind}` }, icon(kind), h('strong', null, title), detail ? h('span', { class: 'status-detail' }, detail) : null);
}

export function noteList(notes: readonly string[], id?: string): HTMLElement | null {
  return notes.length === 0 ? null : h('ul', { class: 'notes-list util-notes', id }, notes.map(n => h('li', null, n)));
}

/** Text in a scroll region of its own, so long lines never widen the page. */
export function codeBlock(text: string, label: string, id?: string, wrap = false): HTMLElement {
  return h('pre', { class: `code-block${wrap ? ' code-wrap' : ''}`, tabindex: '0', role: 'region', 'aria-label': label, id }, h('code', null, text));
}

/** Selects the character at a UTF-16 offset in a text area and scrolls it into view. */
export function goToOffset(area: HTMLTextAreaElement | HTMLInputElement, offset: number): void {
  const at = Math.max(0, Math.min(offset, area.value.length));
  area.focus();
  area.setSelectionRange(at, Math.min(at + 1, area.value.length));
  if (area instanceof HTMLTextAreaElement) {
    const line = area.value.slice(0, at).split('\n').length;
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, (line - 3) * lineHeight);
  }
}

/** The UTF-16 offset of a 1-based line and code-point column, as parsers report positions. */
export function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  for (let c = 1; c < column && offset < text.length; c++) {
    const code = text.charCodeAt(offset);
    offset += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
  }
  return offset;
}

export function section(title: string, id: string, ...body: Child[]): HTMLElement {
  return h('div', { class: 'result-section', id }, h('h3', { class: 'sub-title' }, title), ...body);
}

/** A labeled number input kept as text so partial typing is never rewritten. */
export function numberField(options: { id: string; label: string; value: string; hint?: string; onInput: () => void }): { root: HTMLElement; control: HTMLInputElement; setError(message: string | null): void } {
  const control = h('input', { type: 'text', inputmode: 'numeric', class: 'input input-short mono', id: options.id, autocomplete: 'off', spellcheck: 'false' });
  control.value = options.value;
  const errorId = `${options.id}-error`;
  const hintId = `${options.id}-hint`;
  const error = h('p', { class: 'field-error', id: errorId, hidden: true });
  control.setAttribute('aria-describedby', [options.hint ? hintId : '', errorId].filter(Boolean).join(' '));
  control.addEventListener('input', options.onInput);
  return {
    root: h('div', { class: 'field field-narrow' }, h('label', { for: options.id, class: 'field-label' }, options.label), control,
      options.hint ? h('p', { class: 'hint', id: hintId }, options.hint) : null, error),
    control,
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? '';
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}
