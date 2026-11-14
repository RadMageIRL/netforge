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

export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}

/** Clipboard text with line endings normalized: Windows stores copied LF text as CRLF. */
export async function readClipboard(page: Page): Promise<string> {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
}

export async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent('download'), click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, 'utf8') };
}
