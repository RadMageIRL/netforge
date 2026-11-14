import { expect, test } from '@playwright/test';
import { openTool, recordRequests, resultValue } from './helpers';

const SENTINELS = { subnet: '10.77.66.55/27', json: '{"secretToken":"nf-sentinel-7c1e"}', time: '1234567890' };

test('using every tool sends nothing anywhere: only the app files are requested', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const log = await recordRequests(context, origin);

  await openTool(page, 'subnet-calculator', 'Subnet Calculator');
  await page.fill('#subnet-input', SENTINELS.subnet);
  await expect(resultValue(page, 'network')).toHaveText('10.77.66.32');
  await page.locator('a[data-tool="json-formatter"]').click();
  await page.fill('#json-input', SENTINELS.json);
  await expect(page.locator('.status-ok')).toBeVisible();
  await page.locator('a[data-tool="timestamp-converter"]').click();
  await page.fill('#timestamp-input', SENTINELS.time);
  await expect(resultValue(page, 'iso-utc')).toHaveText('2009-02-13T23:31:30Z');
  await page.goto('./#/about');
  const afterUse = log.all.length;
  // Typing more must not cause a single further request.
  await page.goto('./#/json-formatter');
  await page.waitForLoadState('networkidle');
  const settled = log.all.length;
  await page.fill('#json-input', '{"more":"typing"}');
  await page.waitForTimeout(500);

  expect(log.blockedExternal).toEqual([]);
  expect(log.all.filter(r => r.method !== 'GET')).toEqual([]);
  for (const r of log.all) {
    const url = new URL(r.url);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(/^\/(index\.html|theme-boot\.js|favicon\.svg|assets\/[A-Za-z0-9_-]+\.(js|css))?$/);
    expect(url.search).toBe('');
    for (const s of Object.values(SENTINELS)) expect(decodeURIComponent(r.url)).not.toContain(s);
  }
  expect(afterUse).toBeGreaterThan(0);
  expect(log.all.length).toBe(settled);
});

test('the Content-Security-Policy blocks network connections from the page', async ({ page, context, baseURL }) => {
  const log = await recordRequests(context, new URL(baseURL!).origin);
  await page.goto('./');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
    const results: string[] = [];
    for (const url of ['/', 'https://example.com/collect']) {
      try {
        await fetch(url, { method: 'POST', body: 'x' });
        results.push('sent');
      } catch {
        results.push('blocked');
      }
    }
    const beacon = navigator.sendBeacon('https://example.com/beacon', 'x');
    await new Promise(r => setTimeout(r, 200));
    return { results, beacon, violations };
  });
  expect(outcome.results).toEqual(['blocked', 'blocked']);
  expect(outcome.violations.filter(d => d === 'connect-src').length).toBeGreaterThanOrEqual(2);
  expect(log.all.filter(r => r.method === 'POST')).toEqual([]);
  expect(log.blockedExternal).toEqual([]);
});

test('tool input is never written to storage, cookies or caches', async ({ page }) => {
  await openTool(page, 'subnet-calculator', 'Subnet Calculator');
  await page.fill('#subnet-input', SENTINELS.subnet);
  await page.locator('a[data-tool="json-formatter"]').click();
  await page.fill('#json-input', SENTINELS.json);
  await page.locator('a[data-tool="timestamp-converter"]').click();
  await page.locator('#timestamp-zone').selectOption('Europe/Berlin');
  await page.fill('#timestamp-input', SENTINELS.time);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();

  const state = await page.evaluate(async () => ({
    local: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
  expect(state.local).toEqual({
    'netforge.lastTool': 'timestamp-converter',
    'netforge.timeZone': 'Europe/Berlin',
    'netforge.theme': 'light',
  });
  expect(state.session).toBe(0);
  expect(state.cookie).toBe('');
  expect(state.databases).toBe(0);
  expect(state.caches).toBe(0);
});
