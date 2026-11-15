import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The response headers the production host sends, read from vercel.json at the repository root.
 * Tests apply them to a local server so the browser sees what it will see in production.
 *
 * A rule's `source` is a path-to-regexp pattern. Only the two forms vercel.json uses here are
 * understood: literal text, and a group in parentheses that holds a regular expression.
 */
export interface HeaderRule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

export function hostHeaderRules(): readonly HeaderRule[] {
  const doc = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'vercel.json'), 'utf8')) as { headers: HeaderRule[] };
  return doc.headers;
}

export function sourceToRegExp(source: string): RegExp {
  let out = '';
  let depth = 0;
  for (const ch of source) {
    if (ch === '(') depth++;
    if (depth > 0) out += ch;
    else if (/[A-Za-z0-9/_-]/.test(ch)) out += ch;
    else if (ch === '.') out += '[.]';
    else throw new Error(`Unsupported character in a header rule source: ${source}`);
    if (ch === ')') depth--;
  }
  if (depth !== 0) throw new Error(`Unbalanced group in a header rule source: ${source}`);
  return new RegExp(`^${out}$`);
}

/** The rules that match a path such as "/assets/app.js", in file order. */
export function rulesFor(path: string, rules: readonly HeaderRule[] = hostHeaderRules()): readonly HeaderRule[] {
  return rules.filter(rule => sourceToRegExp(rule.source).test(path));
}

/** The headers the host adds to a path, as an object keyed by header name. */
export function hostHeadersFor(path: string, rules: readonly HeaderRule[] = hostHeaderRules()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rulesFor(path, rules)) for (const h of rule.headers) out[h.key] = h.value;
  return out;
}
