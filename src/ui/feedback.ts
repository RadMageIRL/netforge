/**
 * Feedback that does not move focus: a polite live region for screen readers and brief visual
 * toasts. Toasts are hidden from assistive technology because the live region already speaks.
 */
import { byId, h } from './dom';
import { icon, type IconName } from './icons';

export function announce(message: string): void {
  const region = byId('live-region');
  // Clearing first makes a repeated message ("Copied") be read again.
  region.textContent = '';
  window.setTimeout(() => { region.textContent = message; }, 30);
}

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const stack = byId('toasts');
  const name: IconName = kind === 'ok' ? 'check' : 'error';
  const item = h('div', { class: `toast toast-${kind}` }, icon(name), h('span', null, message));
  stack.appendChild(item);
  while (stack.children.length > 3) stack.firstElementChild?.remove();
  window.setTimeout(() => item.classList.add('toast-leaving'), 2200);
  window.setTimeout(() => item.remove(), 2600);
}
