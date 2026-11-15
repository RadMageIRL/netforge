/**
 * The production host configuration (vercel.json): the response headers the security review
 * requires, checked against the policy the build writes into the page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostHeaderRules, hostHeadersFor, rulesFor, sourceToRegExp } from './helpers/host-headers';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** The page policy, read from the build configuration's source text. */
function pagePolicy(): string {
  const block = /export const CSP = \[([^\]]+)\]/.exec(read('vite.config.ts'))![1]!;
  return [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]!).join('; ');
}

const PATHS = ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/theme-boot.js', '/favicon.svg', '/icon-192.png', '/assets/index-abc123.js', '/assets/hash.worker-abc123.js', '/assets/index-abc123.css', '/assets/missing.js', '/nothing-here', '/sw.js.map', '/x/sw.js'];

describe('host headers (vercel.json)', () => {
  const rules = hostHeaderRules();

  it('reads the page policy from the build configuration', () => {
    expect(pagePolicy()).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'");
  });

  it('gives every path exactly one rule, so no header depends on how the host merges rules', () => {
    expect(rules.map(r => r.source)).toEqual(['/sw.js', '/assets/(.*)', '/((?!sw\\.js$|assets/).*)']);
    for (const path of PATHS) expect([path, rulesFor(path, rules).length]).toEqual([path, 1]);
    expect(rulesFor('/sw.js', rules)[0]!.source).toBe('/sw.js');
    expect(rulesFor('/assets/hash.worker-abc123.js', rules)[0]!.source).toBe('/assets/(.*)');
    expect(rulesFor('/sw.js.map', rules)[0]!.source).not.toBe('/sw.js');
    expect(sourceToRegExp('/sw.js').test('/swxjs')).toBe(false);
  });

  it('sends the page policy plus frame-ancestors on everything, and lets only the service worker fetch', () => {
    const everywhere = `${pagePolicy()}; frame-ancestors 'none'`;
    for (const path of PATHS) {
      const policy = hostHeadersFor(path, rules)['Content-Security-Policy'];
      if (path === '/sw.js') expect(policy).toBe(everywhere.replace("connect-src 'none'", "connect-src 'self'"));
      else expect([path, policy]).toEqual([path, everywhere]);
      expect(policy).not.toMatch(/unsafe|\*|data:|blob:|https?:/);
    }
  });

  it('sends the other security headers on every path', () => {
    for (const path of PATHS) {
      const h = hostHeadersFor(path, rules);
      expect(Object.keys(h).sort()).toEqual(['Access-Control-Allow-Origin', 'Cache-Control', 'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Permissions-Policy', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options']);
      expect(h['X-Content-Type-Options']).toBe('nosniff');
      expect(h['X-Frame-Options']).toBe('DENY');
      expect(h['Referrer-Policy']).toBe('no-referrer');
      expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
      expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
      // The host adds a wildcard to static files unless told otherwise: name the app's own origin.
      expect(h['Access-Control-Allow-Origin']).toBe(`${'https'}://netforge.radmagelabs.com`);
      expect(h['Strict-Transport-Security']).toMatch(/^max-age=63072000(; includeSubDomains)?$/);
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'bluetooth']) expect(h['Permissions-Policy']).toContain(`${feature}=()`);
      // Copying to the clipboard must keep working.
      expect(h['Permissions-Policy']).not.toContain('clipboard');
    }
  });

  it('caches only the files whose names carry a content hash', () => {
    for (const path of PATHS) expect([path, hostHeadersFor(path, rules)['Cache-Control']]).toEqual([path, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache']);
  });

  it('never widens the service worker scope, allows reads from other origins or sets a cookie', () => {
    const keys = rules.flatMap(r => r.headers.map(h => h.key.toLowerCase()));
    for (const forbidden of ['service-worker-allowed', 'access-control-allow-credentials', 'set-cookie']) expect(keys).not.toContain(forbidden);
    expect(rules.flatMap(r => r.headers).filter(h => h.value.trim() === '*')).toEqual([]);
    const doc = JSON.parse(read('vercel.json')) as Record<string, unknown>;
    expect(doc.rewrites).toBeUndefined();
    expect(doc.redirects).toBeUndefined();
    expect(doc.outputDirectory).toBe('dist');
  });
});
