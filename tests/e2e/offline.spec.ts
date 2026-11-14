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

test('the Phase 1 network tools work offline without having been opened online', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await page.locator('a[data-tool="vlsm-allocator"]').click();
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#vlsm-table tbody tr')).toHaveCount(6);
  await page.locator('a[data-tool="ip-range-analyzer"]').click();
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#ranges-findings tbody tr')).toHaveCount(6);
  await page.locator('a[data-tool="route-summarization"]').click();
  await page.fill('#routes-input', '10.0.0.0/25\n10.0.0.128/25');
  await expect(page.locator('#routes-v4-table tbody tr td').first()).toHaveText('10.0.0.0/24');
  await page.locator('a[data-tool="subnet-calculator"]').click();
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await page.fill('#subnet-input', '2001:db8::/32');
  await expect(resultValue(page, 'cidr')).toHaveText('2001:db8::/32');
  await expect(page.locator('#class-result .chip-static').first()).toHaveText('Documentation');
});

test('the VLAN planner works offline without having been opened online', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await page.locator('a[data-tool="network-planner"]').click();
  await page.locator('#plan-example').click();
  await expect(page.locator('#vlan-table tbody tr')).toHaveCount(10);
  await page.getByRole('tab', { name: 'Allocate' }).click();
  await page.locator('#alloc-preview').click();
  await expect(page.locator('#alloc-changes tbody tr')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Address map' }).click();
  await expect(page.locator('#map-grid button')).toHaveCount(256);
  await page.setInputFiles('#plan-file', { name: 'offline.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"netforge-plan","version":1,"plan":{"vlans":[{"id":"v1","vlanId":5}]}}') });
  await expect(page.locator('#plan-messages .notice-ok')).toHaveText('Opened offline.json: 1 VLAN at 0 sites.');
});

test('the ScheduleForge tools work offline without having been opened online', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await page.locator('a[data-tool="cron-explainer"]').click();
  await page.fill('#cron-from', '2026-11-14 12:00');
  await page.fill('#cron-input', '0 9 * * 1-5');
  await expect(page.locator('#cron-summary')).toHaveText('At 09:00, on Monday through Friday.');
  await expect(page.locator('#cron-runs tbody tr').first().locator('td').nth(3)).toHaveText('2026-11-16T14:00:00Z');
  await page.locator('a[data-tool="schedule-builder"]').click();
  await page.selectOption('#builder-frequency', 'weekdays');
  await expect(page.locator('#builder-text-cron')).toHaveText('0 9 * * 1-5');
  await expect(page.locator('#builder-outputs article')).toHaveCount(5);
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

test('the Phase 4 utilities work offline without having been opened online, workers included', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await page.locator('a[data-tool="base64-url-hex"]').click();
  await page.fill('#codec-input', 'offline');
  await expect(page.locator('#codec-output')).toHaveValue('b2ZmbGluZQ==');
  await page.locator('a[data-tool="hash-hmac"]').click();
  await page.fill('#hash-text', 'abc');
  await expect(page.locator('#hash-list [data-key="SHA-256-hex"] .hash-value')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await expect(page.locator('#hash-list [data-key="MD5-hex"] .hash-value')).toHaveText('900150983cd24fb0d6963f7d28e17f72');
  await page.locator('a[data-tool="jwt-decoder"]').click();
  await page.getByRole('button', { name: 'Example' }).click();
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await page.locator('a[data-tool="regex-tester"]').click();
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#regex-status')).toContainText('4 matches');
  await page.locator('a[data-tool="text-tools"]').click();
  await page.fill('#text-input', 'b\na');
  await page.selectOption('#text-sort', 'text');
  await expect(page.locator('#text-output')).toHaveValue('a\nb');
  await page.locator('a[data-tool="uuid-tokens"]').click();
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-output')).toHaveValue(/^[0-9a-f-]{36}$/);
  await page.locator('a[data-tool="yaml-xml-tools"]').click();
  await page.selectOption('#data-operation', 'yaml-json');
  await page.fill('#data-input', 'a: [1, 2]');
  await expect(page.locator('#data-output')).toHaveValue('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  await page.selectOption('#data-operation', 'xml-format');
  await page.fill('#data-input', '<a><b/></a>');
  await expect(page.locator('#data-output')).toHaveValue('<a>\n  <b/>\n</a>\n');
});

test('the Phase 5 exports and utilities work offline without having been opened online', async ({ page, context }) => {
  await page.goto('./');
  await waitForController(page);
  await context.setOffline(true);
  await page.reload();
  await page.locator('a[data-tool="powershell-generator"]').click();
  await page.locator('#ps-example').click();
  await expect(page.locator('#ps-code-0')).toContainText('Add-DhcpServerv4Scope');
  await page.locator('a[data-tool="terraform-export"]').click();
  await page.locator('#tf-example').click();
  await page.getByRole('radio', { name: 'AWS VPC and subnets', exact: true }).check();
  await expect(page.locator('#tf-code-0')).toContainText('resource "aws_subnet" "vlan_10_users"');
  await page.locator('a[data-tool="network-config-export"]').click();
  await page.locator('#nc-example').click();
  await page.getByRole('radio', { name: 'Juniper Junos', exact: true }).check();
  await page.selectOption('#nc-site', { label: 'Branch office' });
  await expect(page.locator('#nc-code-0')).toContainText('set vlans Users vlan-id 10');
  await page.locator('a[data-tool="number-bases"]').click();
  await page.fill('#num-input', '255');
  await expect(page.locator('#num-result')).toContainText('ff');
  await page.locator('a[data-tool="chmod-calculator"]').click();
  await page.fill('#chmod-octal', '755');
  await expect(page.locator('#chmod-ls')).toHaveValue('rwxr-xr-x');
});
