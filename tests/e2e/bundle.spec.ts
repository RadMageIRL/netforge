import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

/**
 * Size budgets for the production build, and what a first visit downloads. The numbers are
 * ceilings with room above today's sizes: they exist to make unplanned growth (a new dependency,
 * a tool pulled into the shell) fail loudly, not to chase bytes.
 */
const DIST = join(import.meta.dirname, '..', '..', 'dist');

interface Built { readonly path: string; readonly bytes: number; readonly gzip: number }

function built(): Built[] {
  const out: Built[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const body = readFileSync(full);
        out.push({ path: relative(DIST, full).split(sep).join('/'), bytes: body.length, gzip: gzipSync(body).length });
      }
    }
  };
  walk(DIST);
  return out;
}

const KB = 1024;

test('the build stays inside its size budgets', () => {
  const files = built();
  const one = (pattern: RegExp) => {
    const hits = files.filter(f => pattern.test(f.path));
    expect([pattern.source, hits.length]).toEqual([pattern.source, 1]);
    return hits[0]!;
  };
  const shell = one(/^assets\/index-[^/]+\.js$/);
  const css = one(/^assets\/index-[^/]+\.css$/);
  const yamlWorker = one(/^assets\/data\.worker-[^/]+\.js$/);
  const report = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 12).map(f => `${f.path} ${f.bytes} (${f.gzip} gzip)`);
  console.log(`[bundle] ${files.length} files, ${files.reduce((s, f) => s + f.bytes, 0)} bytes, ${files.reduce((s, f) => s + f.gzip, 0)} gzip\n[bundle] ${report.join('\n[bundle] ')}`);

  // What every visit needs before anything shows.
  expect(shell.bytes).toBeLessThan(60 * KB);
  expect(shell.gzip).toBeLessThan(22 * KB);
  expect(css.bytes).toBeLessThan(48 * KB);
  // The one bundled dependency lives only in the YAML/XML worker.
  expect(yamlWorker.bytes).toBeLessThan(170 * KB);
  // Every other script is a tool or shared code, loaded on first use.
  for (const f of files) {
    if (!f.path.endsWith('.js') || f === yamlWorker || f.path === 'sw.js') continue;
    expect([f.path, f.bytes < 96 * KB]).toEqual([f.path, true]);
  }
  expect(files.reduce((s, f) => s + f.bytes, 0)).toBeLessThan(1100 * KB);
  // No source maps, no stray file types.
  for (const f of files) expect(f.path).toMatch(/^(index\.html|sw\.js|theme-boot\.js|favicon\.svg|manifest\.webmanifest|(icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png|assets\/[A-Za-z0-9_.-]+\.(js|css))$/);
});

test('a first visit downloads the shell only: no tool code until a tool is opened', async ({ page }) => {
  const scripts: string[] = [];
  page.on('response', r => { if (/\.(js|css)$/.test(new URL(r.url()).pathname)) scripts.push(new URL(r.url()).pathname); });
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1, name: 'NetForge' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(scripts.map(s => s.replace(/-[A-Za-z0-9_-]{8}\./, '.')).sort()).toEqual(['/assets/index.css', '/assets/index.js', '/theme-boot.js']);
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) };
  });
  console.log(`[bundle] first visit from the local server: DOMContentLoaded ${timing.domContentLoaded} ms, load ${timing.load} ms`);
  expect(timing.load).toBeLessThan(3000);
  // Opening a tool then fetches that tool's chunk and what it shares.
  const before = scripts.length;
  await page.locator('a[data-tool="chmod-calculator"]').click();
  await expect(page.getByRole('heading', { level: 1, name: 'chmod Calculator' })).toBeVisible();
  expect(scripts.slice(before).some(s => /chmod-calculator/.test(s))).toBe(true);
  expect(scripts.some(s => /yaml|data\.worker|jwt|network-planner/.test(s))).toBe(false);
});
