// Renders the app icons in public/ from the mark in public/favicon.svg, using the installed Chrome
// through Playwright (a development dependency). Run it only when the mark changes:
//
//   node scripts/make-icons.mjs
//
// Output: icon-192.png and icon-512.png (rounded tile, purpose "any"), icon-maskable-512.png
// (full-bleed background with the mark inside the safe zone) and apple-touch-icon.png (180 px,
// square, because iOS rounds the corners itself).
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8');
const mark = svg.slice(svg.indexOf('<path'), svg.lastIndexOf('</svg>'));
const BACKGROUND = '#151b23';

/** `radius` in 32-unit space; `scale` shrinks the mark around the center for the maskable safe zone. */
function icon(radius, scale) {
  const offset = (32 - 32 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="${radius}" fill="${BACKGROUND}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${mark}</g></svg>`;
}

const targets = [
  { name: 'icon-192.png', size: 192, svg: icon(7, 1) },
  { name: 'icon-512.png', size: 512, svg: icon(7, 1) },
  { name: 'icon-maskable-512.png', size: 512, svg: icon(0, 0.72) },
  { name: 'apple-touch-icon.png', size: 180, svg: icon(0, 0.86) },
];

const browser = await chromium.launch({ channel: 'chrome' });
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${t.svg.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  writeFileSync(join(root, 'public', t.name), png);
  await page.close();
  console.log(`${t.name}: ${png.length} bytes`);
}
await browser.close();
