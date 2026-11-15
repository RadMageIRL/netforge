import { readFile } from 'node:fs/promises';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/** Collects console errors and uncaught exceptions so every test can assert there were none. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));
  return errors;
}

export interface RequestLog {
  readonly all: { url: string; method: string; postData: string | null }[];
  readonly blockedExternal: string[];
}

/**
 * Records every request the page makes. Anything addressed to another host is aborted before it
 * leaves the machine, and recorded, so a failing privacy test cannot itself leak data.
 */
export async function recordRequests(context: BrowserContext, allowedOrigin: string): Promise<RequestLog> {
  const log: RequestLog = { all: [], blockedExternal: [] };
  await context.route('**/*', route => {
    const request = route.request();
    // WebKit reports a download of a blob made by the page as a request for its blob: URL.
    // Nothing leaves the browser, so it is not a network request.
    if (request.url().startsWith('blob:')) return route.continue();
    log.all.push({ url: request.url(), method: request.method(), postData: request.postData() });
    if (new URL(request.url()).origin !== allowedOrigin) {
      log.blockedExternal.push(request.url());
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return log;
}

export async function openTool(page: Page, id: string, heading: string): Promise<void> {
  await page.goto(`./#/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
}

/** The displayed value in a result row. */
export function resultValue(page: Page, key: string): Locator {
  return page.locator(`tr[data-key="${key}"] .value-text`);
}

/**
 * Lets a test read the clipboard. Chromium takes a permission grant. Firefox is started with
 * preferences that allow it (see playwright.config.ts). WebKit has neither, so there the
 * Clipboard API is replaced by one that remembers what the page wrote: the test still proves the
 * app copied exactly the right text, though not that it reached the system clipboard.
 */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  const engine = context.browser()?.browserType().name();
  if (engine === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  else if (engine === 'webkit') {
    const shim = () => {
      let held = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { held = String(t); }, readText: async () => held } });
    };
    await context.addInitScript(shim);
    // Pages that are already open (a test that grants after navigating) get it too.
    for (const page of context.pages()) await page.evaluate(shim).catch(() => undefined);
  }
}

/** The path of a file that belongs to the app: the page, its scripts and styles, the manifest and the icons. */
export const APP_FILE = /^\/(index\.html|theme-boot\.js|favicon\.svg|manifest\.webmanifest|(icon-192|icon-512|icon-maskable-512|apple-touch-icon)\.png|assets\/[A-Za-z0-9_.-]+\.(js|css))?$/;

/** Clipboard text with line endings normalized: Windows stores copied LF text as CRLF. */
export async function readClipboard(page: Page): Promise<string> {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
}

export async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, 'utf8') };
}
