/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * The Content-Security-Policy added to the built page. connect-src 'none' means the page itself
 * cannot send anything anywhere: no fetch, XHR, WebSocket, EventSource or beacon. Scripts and
 * styles load only from the app's own files, and so does the web app manifest.
 *
 * A meta policy covers the page only. Workers take their policy from the HTTP headers of their
 * own script: the service worker adds this same policy to the worker scripts it serves, each
 * worker removes its own network interfaces on start (worker-lockdown.ts), and the host should
 * send the policy as a header as well, with frame-ancestors, which a meta element cannot carry. Dev builds skip it because Vite's HMR client needs
 * websockets and inline styles.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'netforge-csp',
    apply: 'build',
    transformIndexHtml(html) {
      if (/<script>/.test(html)) throw new Error('Inline scripts are not allowed: the CSP has no hash or nonce for them.');
      return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

/**
 * Writes dist/sw.js from src/sw-template.js with a precache list of every built file and a version
 * derived from the package version and the files' contents. Any change to the app produces a new
 * service worker, and building the same sources twice produces identical files.
 */
function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'netforge-sw',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    closeBundle() {
      const outDir = config.build.outDir;
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(relative(outDir, full).split(sep).join('/'));
        }
      };
      walk(outDir);
      const precache = files.filter(f => f !== 'sw.js' && !f.endsWith('.map')).sort();
      const hash = createHash('sha256');
      for (const f of precache) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = `${pkg.version}-${hash.digest('hex').slice(0, 12)}`;
      const template = readFileSync('src/sw-template.js', 'utf8');
      const urls = ['./', ...precache.map(f => `./${f}`)];
      writeFileSync(join(outDir, 'sw.js'), template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(urls)).replace('__CSP__', JSON.stringify(CSP)));
    },
  };
}

export default defineConfig({
  // Relative paths so the same build works at the site root, under /netforge/ and on GitHub Pages.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [contentSecurityPolicy(), serviceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    // The polyfill fetches preloaded modules with fetch(), which the CSP forbids; every supported
    // browser preloads modules natively.
    modulePreload: { polyfill: false },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // A test that asserts nothing passes for the wrong reason; make that a failure.
    expect: { requireAssertions: true },
  },
});
