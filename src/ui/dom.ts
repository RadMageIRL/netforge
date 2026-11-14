/**
 * A small element builder. Text always goes in as text nodes, never as HTML, so nothing a user
 * pastes can become markup.
 */

type AttrValue = string | number | boolean | null | undefined;
type Handler = (event: Event) => void;
export type Child = Node | string | number | null | undefined | false | readonly Child[];

export interface Attrs {
  readonly [name: string]: AttrValue | Handler;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === 'function') {
        el.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
      } else if (name === 'class') {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(name, '');
      } else {
        el.setAttribute(name, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

let idCounter = 0;
/** A unique id for wiring labels and descriptions. */
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** True when keyboard focus is in a place where typing text is expected. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'reset', 'submit', 'range', 'color', 'file'].includes(target.type);
  }
  return false;
}
