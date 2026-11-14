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

test('the ScheduleForge tools send nothing, store nothing and restore nothing after a reload', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const log = await recordRequests(context, origin);
  const secrets = ['43 21 17 * *', 'nf-sentinel-task', 'nf-sentinel.exe', '--nf-sentinel-arg', '2031-07-04'];
  await openTool(page, 'cron-explainer', 'Cron Explainer');
  await page.locator('#cron-zone').selectOption('Europe/Berlin');
  await page.fill('#cron-from', '2031-07-04 08:00');
  await page.fill('#cron-input', '43 21 17 * *');
  await expect(page.locator('#cron-summary')).toHaveText('At 21:43, on the 17th of the month.');
  await page.getByRole('radio', { name: 'systemd calendar', exact: true }).check();
  await page.fill('#cron-input', '*-*-17 21:43 Europe/Berlin');
  await expect(page.locator('#cron-normalized')).toBeVisible();
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  expect(csv.suggestedFilename()).toBe('schedule-systemd-runs.csv');

  await page.locator('a[data-tool="schedule-builder"]').click();
  await page.locator('#builder-zone').selectOption('Asia/Tokyo');
  await page.fill('#builder-start', '2031-07-04');
  await page.locator('#builder-details summary').click();
  await page.fill('#builder-name', 'nf-sentinel-task');
  await page.fill('#builder-program', 'C:\\Secret\\nf-sentinel.exe');
  await page.fill('#builder-arguments', '--nf-sentinel-arg');
  await expect(page.locator('#builder-text-schtasks')).toContainText('nf-sentinel-task');
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON', exact: true }).click()]);
  expect(json.suggestedFilename()).toBe('schedule-builder.json');

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
  // No new preference: the schedule tools do not even remember the chosen zone.
  expect(state.keys).toEqual(['netforge.lastTool']);
  expect([state.databases, state.caches]).toEqual([0, 0]);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Schedule Builder' })).toBeVisible();
  await expect(page.locator('#builder-name')).toHaveValue('');
  await expect(page.locator('#builder-program')).toHaveValue('');
  await expect(page.locator('#builder-zone')).toHaveValue('');
  await page.goto('./#/cron-explainer');
  await expect(page.locator('#cron-input')).toHaveValue('');
  await expect(page.locator('#cron-from')).toHaveValue('');
  await expect(page.getByRole('radio', { name: 'Standard cron', exact: true })).toBeChecked();
});

test('the Phase 4 utilities send nothing, store nothing and restore nothing after a reload', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const log = await recordRequests(context, origin);
  const secrets = ['nf-sentinel-text', 'nf-sentinel-key', 'nf-sentinel-secret', 'nf-sentinel-subject', 'nf-sentinel-pattern', 'nf-sentinel-line', 'nf-sentinel-yaml', 'nf-sentinel-file'];

  await openTool(page, 'base64-url-hex', 'Base64 / URL / Hex');
  await page.fill('#codec-input', 'nf-sentinel-text');
  await expect(page.locator('#codec-output')).toHaveValue('bmYtc2VudGluZWwtdGV4dA==');
  const [bin] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download bytes' }).click()]);
  expect(bin.suggestedFilename()).toBe('decoded.bin');

  await page.locator('a[data-tool="hash-hmac"]').click();
  await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
  await page.fill('#hash-key', 'nf-sentinel-key');
  await page.fill('#hash-text', 'nf-sentinel-text');
  await expect(page.locator('#hash-list [data-key="HMAC-SHA256-hex"] .hash-value')).toBeVisible();
  await page.getByRole('radio', { name: 'File', exact: true }).check();
  await page.setInputFiles('#hash-file', { name: 'nf-sentinel-file.txt', mimeType: 'text/plain', buffer: Buffer.from('nf-sentinel-text in a file') });
  await expect(page.locator('#hash-status')).toContainText('nf-sentinel-file.txt');

  await page.locator('a[data-tool="jwt-decoder"]').click();
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'nf-sentinel-subject', exp: 4102444800 })}.${'A'.repeat(43)}`;
  await page.fill('#jwt-input', token);
  await page.fill('#jwt-secret', 'nf-sentinel-secret-nf-sentinel-secret');
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Verification failed.');

  await page.locator('a[data-tool="regex-tester"]').click();
  await page.fill('#regex-text', 'find nf-sentinel-text here');
  await page.fill('#regex-pattern', 'nf-sentinel-pattern|nf-sentinel-text');
  await expect(page.locator('#regex-status')).toContainText('1 match');

  await page.locator('a[data-tool="text-tools"]').click();
  await page.fill('#text-input', 'nf-sentinel-line\nb');
  await page.selectOption('#text-sort', 'text');
  await expect(page.locator('#text-output')).toHaveValue('b\nnf-sentinel-line');

  await page.locator('a[data-tool="uuid-tokens"]').click();
  await page.locator('#token-generate').click();
  const uuid = await page.locator('#token-output').inputValue();
  expect(uuid).toHaveLength(36);

  await page.locator('a[data-tool="yaml-xml-tools"]').click();
  await page.fill('#data-input', 'secret: nf-sentinel-yaml\n');
  await expect(page.locator('#data-output')).toHaveValue('secret: nf-sentinel-yaml\n');
  await page.selectOption('#data-operation', 'xml-json');
  await page.fill('#data-input', '<s>nf-sentinel-yaml</s>');
  await expect(page.locator('#data-output')).toHaveValue(/nf-sentinel-yaml/);
  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  expect(json.suggestedFilename()).toBe('converted.json');

  expect(log.blockedExternal).toEqual([]);
  expect(log.all.filter(r => r.method !== 'GET')).toEqual([]);
  for (const r of log.all) {
    const url = new URL(r.url);
    expect(url.origin).toBe(origin);
    // App files only, workers included; no query string could carry data.
    expect(url.pathname).toMatch(/^\/(index\.html|theme-boot\.js|favicon\.svg|assets\/[A-Za-z0-9_.-]+\.(js|css))?$/);
    expect(url.search).toBe('');
    for (const s of [...secrets, uuid, token.split('.')[1]]) expect(decodeURIComponent(r.url)).not.toContain(s);
  }
  expect(page.url()).toBe(`${origin}/#/yaml-xml-tools`);
  const state = await page.evaluate(async () => ({
    stored: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie,
    keys: Object.keys(localStorage).sort(),
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
  for (const s of [...secrets, uuid]) expect(state.stored).not.toContain(s);
  expect(state.keys).toEqual(['netforge.lastTool']);
  expect([state.databases, state.caches]).toEqual([0, 0]);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'YAML/XML Tools' })).toBeVisible();
  await expect(page.locator('#data-input')).toHaveValue('');
  for (const [tool, field] of [['base64-url-hex', '#codec-input'], ['hash-hmac', '#hash-text'], ['hash-hmac', '#hash-key'], ['jwt-decoder', '#jwt-input'], ['jwt-decoder', '#jwt-secret'],
    ['regex-tester', '#regex-pattern'], ['regex-tester', '#regex-text'], ['text-tools', '#text-input'], ['uuid-tokens', '#token-output']]) {
    await page.goto(`./#/${tool}`);
    await expect(page.locator(field)).toHaveValue('');
  }
});

test('a worker can only be started from the app\'s own files, and cannot connect out', async ({ page, context, baseURL }) => {
  const log = await recordRequests(context, new URL(baseURL!).origin);
  await page.goto('./#/regex-tester');
  const outcome = await page.evaluate(async () => {
    const results: string[] = [];
    // worker-src 'self': a worker cannot be made from generated code.
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
      await new Promise<void>(resolve => {
        w.onerror = () => { results.push('blob worker blocked'); resolve(); };
        w.onmessage = () => { results.push('blob worker ran'); resolve(); };
        setTimeout(resolve, 1000);
      });
    } catch {
      results.push('blob worker blocked');
    }
    return results;
  });
  expect(outcome).toEqual(['blob worker blocked']);
  expect(log.blockedExternal).toEqual([]);
});
