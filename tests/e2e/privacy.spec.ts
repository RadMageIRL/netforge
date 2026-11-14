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

test('the Phase 1 network tools send nothing and store nothing', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const log = await recordRequests(context, origin);
  const secretNet = '10.66.55.0/24';
  await openTool(page, 'subnet-calculator', 'Subnet Calculator');
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await page.fill('#subnet-input', 'fd66:5544::/48');
  await page.locator('#split-panel summary').click();
  await page.locator('a[data-tool="vlsm-allocator"]').click();
  await page.fill('#vlsm-parent', secretNet);
  await page.getByLabel('Name, request 1', { exact: true }).fill('SecretLab');
  await page.getByLabel('Hosts, request 1', { exact: true }).fill('20');
  await expect(page.locator('#vlsm-table')).toContainText('10.66.55.0/27');
  await page.locator('a[data-tool="ip-range-analyzer"]').click();
  await page.fill('#ranges-input', `${secretNet}\n10.66.55.128/25`);
  await page.locator('a[data-tool="route-summarization"]').click();
  await page.fill('#routes-input', '10.66.55.0/25\n10.66.55.128/25');
  await expect(page.locator('#routes-v4-table')).toContainText('10.66.55.0/24');

  expect(log.blockedExternal).toEqual([]);
  expect(log.all.filter(r => r.method !== 'GET')).toEqual([]);
  for (const r of log.all) {
    expect(new URL(r.url).pathname).toMatch(/^\/(index\.html|theme-boot\.js|favicon\.svg|assets\/[A-Za-z0-9_-]+\.(js|css))?$/);
    expect(decodeURIComponent(r.url)).not.toContain('10.66.55');
    expect(decodeURIComponent(r.url)).not.toContain('SecretLab');
  }
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain('10.66.55');
  expect(stored).not.toContain('SecretLab');
  expect(stored).not.toContain('fd66');
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(['netforge.lastTool']);
});

test('the VLAN planner sends nothing, stores nothing and does not restore a plan after a reload', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const log = await recordRequests(context, origin);
  const secrets = ['10.66.55', 'SecretLab', 'SecretCampus', 'fd66'];
  await page.goto('./#/network-planner');
  await page.fill('#plan-name', 'SecretCampus');
  await page.locator('#vlan-add').click();
  await page.fill('#vlan-edit-vlanid', '777');
  await page.fill('#vlan-edit-name', 'SecretLab');
  await page.fill('#vlan-edit-ipv4', '10.66.55.0/24');
  await page.fill('#vlan-edit-ipv6', 'fd66:5544:3322::/64');
  await expect(page.locator('#vlan-table tr[data-vlan="v1"]')).toContainText('10.66.55.0/24');
  await page.getByRole('tab', { name: 'Allocate' }).click();
  await page.locator('#alloc-preview').click();
  await page.getByRole('tab', { name: 'Address map' }).click();
  await page.getByRole('tab', { name: 'Issues' }).click();
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#plan-save').click()]);
  expect(file.suggestedFilename()).toBe('SecretCampus.netforge-plan.json');

  expect(log.blockedExternal).toEqual([]);
  expect(log.all.filter(r => r.method !== 'GET')).toEqual([]);
  for (const r of log.all) {
    expect(new URL(r.url).pathname).toMatch(/^\/(index\.html|theme-boot\.js|favicon\.svg|assets\/[A-Za-z0-9_-]+\.(js|css))?$/);
    for (const s of secrets) expect(decodeURIComponent(r.url)).not.toContain(s);
  }
  const state = await page.evaluate(async () => ({
    stored: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie,
    keys: Object.keys(localStorage).sort(),
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
  for (const s of secrets) expect(state.stored).not.toContain(s);
  expect(state.keys).toEqual(['netforge.lastTool']);
  expect([state.databases, state.caches]).toEqual([0, 0]);
  // Nothing comes back on its own.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'NetForge Subnet & VLAN Planner' })).toBeVisible();
  await expect(page.locator('#plan-name')).toHaveValue('');
  await expect(page.locator('#vlan-empty')).toHaveText('No VLANs yet. Add one, open a plan file or load the example.');
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
