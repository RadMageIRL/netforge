import { expect, test, type Page } from '@playwright/test';
import { resultValue } from './helpers';
import { serveDistCopy } from './static-server';

test.use({ serviceWorkers: 'allow' });

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return !!navigator.serviceWorker.controller;
  }, undefined, { timeout: 20_000 });
}

test('works fully offline after the first visit, including tools never opened online', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'NetForge' })).toBeVisible();

  // Each tool is a separate module that was never loaded while online: it must come from the cache.
  await page.locator('a[data-tool="subnet-calculator"]').click();
  await page.fill('#subnet-input', '10.0.0.0/8');
  await expect(resultValue(page, 'broadcast')).toHaveText('10.255.255.255');
  await page.locator('a[data-tool="json-formatter"]').click();
  await page.fill('#json-input', '[1,2]');
  await expect(page.locator('#json-output')).toHaveValue('[\n  1,\n  2\n]');
  await page.locator('a[data-tool="timestamp-converter"]').click();
  await page.fill('#timestamp-input', '0');
  await expect(resultValue(page, 'iso-utc')).toHaveText('1970-01-01T00:00:00Z');

  await page.goto('./#/about');
  await expect(page.locator('.about-page .notice-ok')).toContainText('works without an internet connection');
});

test('works under a subpath such as /netforge/, offline too', async ({ page, context }) => {
  const server = await serveDistCopy({ base: '/netforge/' });
  try {
    await page.goto(`${server.url}#/subnet-calculator`);
    await page.fill('#subnet-input', '192.168.0.1/24');
    await expect(resultValue(page, 'network')).toHaveText('192.168.0.0');
    await waitForController(page);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(server.url);
    await context.setOffline(true);
    await page.reload();
    await page.fill('#subnet-input', '192.168.0.1/30');
    await expect(resultValue(page, 'usable')).toHaveText('2');
  } finally {
    await server.close();
  }
});

test('a new version waits for the user, and Reload activates it', async ({ page }) => {
  const server = await serveDistCopy();
  try {
    await page.goto(`${server.url}#/json-formatter`);
    await waitForController(page);
    await page.fill('#json-input', '{"unsaved":true}');
    const firstVersion = await page.evaluate(async () => (await caches.keys()).find(k => k.startsWith('netforge-')));

    server.deploy('sw.js', text => text.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-update'"));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    await expect(page.locator('#update-bar')).toBeVisible({ timeout: 20_000 });
    // Nothing reloaded on its own: the input is still there.
    await expect(page.locator('#json-input')).toHaveValue('{"unsaved":true}');
    await page.getByRole('button', { name: 'Later' }).click();
    await expect(page.locator('#update-bar')).toBeHidden();
    await expect(page.locator('#json-input')).toHaveValue('{"unsaved":true}');

    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
    const reg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
    expect(reg).toBe(true);
    await page.reload();
    await expect(page.locator('#update-bar')).toBeVisible({ timeout: 20_000 });
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()]);
    await expect.poll(async () => page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('netforge-')))).toContain('netforge-test-update');
    expect(firstVersion).toMatch(/^netforge-0\.1\.0-dev-[0-9a-f]{12}$/);
  } finally {
    await server.close();
  }
});

test('leaves other apps\' caches on the same site alone', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(async () => { await (await caches.open('other-app-v1')).put('/x', new Response('x')); });
  await waitForController(page);
  await page.reload();
  expect(await page.evaluate(async () => (await caches.keys()).includes('other-app-v1'))).toBe(true);
});
