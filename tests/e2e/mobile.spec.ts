import { expect, test, type Page } from '@playwright/test';
import { resultValue, watchErrors } from './helpers';

// Runs in the "mobile" project (Pixel 7, 412 px wide).

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test('no page scrolls sideways at phone width', async ({ page }) => {
  const errors = watchErrors(page);
  for (const route of ['', '#/subnet-calculator', '#/json-formatter', '#/timestamp-converter', '#/about', '#/cron-explainer']) {
    await page.goto(`./${route}`);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expectNoHorizontalScroll(page);
  }
  // With long content too.
  await page.goto('./#/subnet-calculator');
  await page.fill('#subnet-input', '0.0.0.0/0');
  await expectNoHorizontalScroll(page);
  await page.goto('./#/timestamp-converter');
  await page.fill('#timestamp-input', '2026-11-01 01:30');
  await expectNoHorizontalScroll(page);
  await page.goto('./#/json-formatter');
  await page.fill('#json-input', JSON.stringify({ long: 'x'.repeat(400), list: Array.from({ length: 50 }, (_, i) => i) }));
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('Phase 1 tools do not scroll sideways at phone width, even with wide results', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/subnet-calculator');
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await page.fill('#subnet-input', '2001:db8:1234::/48');
  await page.locator('#split-panel summary').click();
  await page.locator('#supernet-panel summary').click();
  await expectNoHorizontalScroll(page);
  await page.getByRole('radio', { name: 'IPv4' }).check();
  await page.fill('#subnet-input', '0.0.0.0/0');
  await expectNoHorizontalScroll(page);
  for (const tool of ['vlsm-allocator', 'ip-range-analyzer', 'route-summarization']) {
    await page.goto(`./#/${tool}`);
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expectNoHorizontalScroll(page);
  }
  expect(errors).toEqual([]);
});

test('the VLAN planner does not scroll sideways at phone width, on any tab', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/network-planner');
  await page.locator('#plan-example').click();
  await expectNoHorizontalScroll(page);
  await page.locator('#vlan-table tr[data-vlan="v1"] button').click();
  await expectNoHorizontalScroll(page);
  const box = await page.locator('#vlan-edit-ipv4').boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  for (const name of ['Sites, VRFs and namespaces', 'Allocate', 'Address map', 'Issues']) {
    await page.getByRole('tab', { name }).click();
    await expectNoHorizontalScroll(page);
  }
  await page.getByRole('tab', { name: 'Allocate' }).click();
  await page.locator('#alloc-preview').click();
  await expectNoHorizontalScroll(page);
  await page.getByRole('tab', { name: 'Address map' }).click();
  const grid = await page.locator('#map-grid').boundingBox();
  expect(grid!.width).toBeLessThanOrEqual(412);
  const cell = await page.locator('#map-grid button').first().boundingBox();
  expect(cell!.width).toBeGreaterThan(16);
  await page.locator('#map-grid button').nth(10).tap();
  await expect(page.locator('#map-details-title')).toHaveText('VLAN 10 Users at Headquarters');
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('the ScheduleForge tools do not scroll sideways at phone width, even with wide results', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/cron-explainer');
  await page.fill('#cron-from', '2026-03-08 00:00');
  await page.fill('#cron-input', '*/20 2 * * *');
  await expect(page.locator('#cron-runs tr[data-status="nonexistent"]')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // The runs table scrolls inside its own region instead of widening the page.
  const region = await page.locator('#cron-runs').evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(region.scroll).toBeGreaterThan(region.client);
  await page.getByRole('radio', { name: 'systemd calendar', exact: true }).check();
  await page.fill('#cron-input', 'Mon,Wed,Fri *-01,02,03,04,05,06,07,08,09,10,11,12-01..07 00/2:00,15,30,45:00 America/Argentina/Buenos_Aires');
  await expect(page.locator('#cron-normalized')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.fill('#cron-input', '*:*/15');
  await expect(page.locator('#cron-result .caret-block')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto('./#/schedule-builder');
  await page.selectOption('#builder-frequency', 'minutes');
  await page.fill('#builder-every-minutes', '7');
  await page.locator('#builder-details summary').click();
  await page.fill('#builder-name', 'A rather long task name for a phone screen');
  await page.fill('#builder-program', 'C:\\Program Files\\Some Vendor\\Some Product\\bin\\a-long-program-name.exe');
  await page.locator('#builder-timer-unit summary').click();
  for (const t of ['powershell', 'schtasks']) await page.locator(`[data-target="${t}"] details[data-key="runs-${t}"] summary`).click();
  await expect(page.locator('#builder-runs-schtasks')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // No card spills sideways: long identifiers wrap and code scrolls inside its own box.
  const spilling = await page.locator('#builder-outputs article').evaluateAll(list => list.filter(a => a.scrollWidth > a.clientWidth + 1).map(a => a.getAttribute('data-target')));
  expect(spilling).toEqual([]);
  const field = await page.locator('#builder-program').boundingBox();
  expect(field!.width).toBeGreaterThan(200);
  const code = await page.locator('#builder-text-powershell').evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(code.scroll).toBeGreaterThan(code.client);
  expect(errors).toEqual([]);
});

test('the VLSM request editor is usable at phone width', async ({ page }) => {
  await page.goto('./#/vlsm-allocator');
  await page.fill('#vlsm-parent', '192.168.0.0/24');
  await page.getByLabel('Name, request 1', { exact: true }).fill('Office');
  await page.getByLabel('Hosts, request 1', { exact: true }).fill('100');
  await expect(page.locator('#vlsm-table tbody tr td:nth-child(3)')).toHaveText(['192.168.0.0/25']);
  const box = await page.getByLabel('Hosts, request 1', { exact: true }).boundingBox();
  expect(box!.width).toBeGreaterThan(80);
});

test('the tool list is a drawer: hidden until opened, closed by Escape', async ({ page }) => {
  await page.goto('./');
  const toggle = page.locator('#nav-toggle');
  const sidebar = page.locator('#sidebar');
  await expect(toggle).toBeVisible();
  await expect(sidebar).toBeHidden();
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName('Close tool navigation');
  await expect(page.locator('#tool-search')).toBeFocused();
  expect(await page.locator('#main').evaluate(el => (el as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  expect(await page.locator('#main').evaluate(el => (el as HTMLElement).inert)).toBe(false);
});

test('choosing a tool in the drawer closes it and opens the tool', async ({ page }) => {
  await page.goto('./');
  await page.locator('#nav-toggle').click();
  await page.locator('#tool-search').fill('subnet');
  await page.locator('a[data-tool="subnet-calculator"]').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Subnet Calculator' })).toBeVisible();
  await page.fill('#subnet-input', '10.40.0.0/16');
  await expect(resultValue(page, 'usable')).toHaveText('65,534');
});

test('tapping outside the drawer closes it', async ({ page }) => {
  await page.goto('./');
  await page.locator('#nav-toggle').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#scrim').click({ position: { x: 395, y: 400 } });
  await expect(page.locator('#sidebar')).toBeHidden();
});

test('the JSON panes stack vertically', async ({ page }) => {
  await page.goto('./#/json-formatter');
  const input = await page.locator('#json-input').boundingBox();
  const output = await page.locator('#json-output').boundingBox();
  expect(input && output && output.y > input.y + input.height).toBe(true);
});

test('the Phase 4 utilities do not scroll sideways at phone width, even with long values', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/base64-url-hex');
  await page.fill('#codec-input', 'x'.repeat(600));
  await expect(page.locator('#codec-output')).not.toHaveValue('');
  await expectNoHorizontalScroll(page);
  await page.selectOption('#codec-from', 'hex');
  await page.fill('#codec-input', 'zz');
  await expect(page.locator('#codec-error')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto('./#/hash-hmac');
  await page.fill('#hash-text', 'abc');
  await expect(page.locator('#hash-list [data-key="SHA-512-hex"] .hash-value')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Every copy button is on screen, not pushed off to the side.
  const copy = await page.getByRole('button', { name: 'Copy SHA-512 Hex' }).boundingBox();
  expect(copy!.x + copy!.width).toBeLessThanOrEqual(412);
  await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
  await page.fill('#hash-key', 'k');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/jwt-decoder');
  await page.getByRole('button', { name: 'Example' }).click();
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('radio', { name: 'Public key', exact: true }).check();
  await page.fill('#jwt-public', `-----BEGIN PUBLIC KEY-----\n${'A'.repeat(64)}\n-----END PUBLIC KEY-----`);
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toBeVisible();
  await expectNoHorizontalScroll(page);
  const tokenBox = await page.locator('#jwt-input').boundingBox();
  expect(tokenBox!.width).toBeGreaterThan(300);

  await page.goto('./#/regex-tester');
  await page.getByRole('button', { name: 'Example' }).click();
  await page.locator('#regex-replace-on').check();
  await expect(page.locator('#regex-replaced')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.fill('#regex-text', 'y'.repeat(900));
  await page.fill('#regex-pattern', 'y{300}');
  await expect(page.locator('#regex-status')).toContainText('3 matches');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/uuid-tokens');
  await page.selectOption('#token-kind', 'hex');
  await page.fill('#token-bytes', '256');
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-output')).not.toHaveValue('');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/text-tools');
  await page.getByRole('button', { name: 'Example' }).click();
  await page.locator('#text-number').check();
  await expectNoHorizontalScroll(page);
  await page.getByRole('tab', { name: 'Compare lists' }).click();
  await page.fill('#compare-a', 'a\nb');
  await page.fill('#compare-b', 'b\nc');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/yaml-xml-tools');
  for (const op of ['yaml-json', 'json-yaml', 'xml-json']) {
    await page.selectOption('#data-operation', op);
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('#data-notes')).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await page.fill('#data-input', '<a><b></a>');
  await expect(page.locator('#data-errors')).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('the regex time limit works on a phone too', async ({ page }) => {
  await page.goto('./#/regex-tester');
  await page.fill('#regex-text', `${'a'.repeat(40)}!`);
  await page.fill('#regex-pattern', '(a+)+$');
  await expect(page.locator('#regex-error')).toHaveAttribute('data-outcome', 'timeout', { timeout: 10_000 });
  await page.fill('#regex-pattern', 'a+');
  await expect(page.locator('#regex-status')).toContainText('1 match');
});

test('the Phase 5 export tools and utilities fit a phone, with code scrolling inside its own box', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/powershell-generator');
  await page.locator('#ps-example').click();
  await page.fill('#ps-reservations', '10.10.10.5 00-11-22-33-44-55 a-rather-long-reservation-name-for-a-phone-screen');
  await expect(page.locator('#ps-code-0')).toContainText('Add-DhcpServerv4Reservation');
  await expectNoHorizontalScroll(page);
  const ps = await page.locator('#ps-code-0').evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(ps.scroll).toBeGreaterThan(ps.client);
  await page.getByRole('radio', { name: 'Scheduled task', exact: true }).check();
  await expect(page.locator('#ps-code-0')).toContainText('Register-ScheduledTask');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/terraform-export');
  await page.locator('#tf-example').click();
  await page.getByRole('radio', { name: 'AWS VPC and subnets', exact: true }).check();
  await expect(page.locator('#tf-items .export-approximate').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const badge = await page.locator('#tf-items .export-item .badge').first().boundingBox();
  const body = await page.locator('#tf-items .export-item-body').first().boundingBox();
  expect(body!.y).toBeGreaterThan(badge!.y);
  expect(body!.width).toBeGreaterThan(250);

  await page.goto('./#/network-config-export');
  await page.locator('#nc-example').click();
  await page.selectOption('#nc-site', { label: 'Headquarters' });
  await page.selectOption('#nc-global-vrf', { label: 'Global' });
  await page.fill('#nc-vrf-name-r2', 'GUEST');
  await page.check('#nc-dhcp');
  await expect(page.locator('#nc-code-0')).toContainText('ip dhcp pool VLAN200');
  await expectNoHorizontalScroll(page);
  await page.getByRole('radio', { name: 'Juniper Junos', exact: true }).check();
  await expect(page.locator('#nc-code-0')).toContainText('set vlans');
  await expectNoHorizontalScroll(page);

  await page.goto('./#/number-bases');
  await page.selectOption('#num-width', 'none');
  await page.fill('#num-input', '9'.repeat(300));
  await expectNoHorizontalScroll(page);
  await page.goto('./#/chmod-calculator');
  await page.fill('#chmod-octal', '4755');
  await page.fill('#chmod-path', '/a/very/long/path/that/keeps/going/and/going/on/a/phone/screen/file name.sh');
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('the Share dialog and the RadMage Labs link fit a phone', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/schedule-builder');
  const share = page.locator('#share-schedule-builder');
  await expect(share).toBeVisible();
  await expectNoHorizontalScroll(page);
  await share.click();
  const dialog = page.locator('#share-dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await expect(page.locator('#share-settings-link-copy')).toBeVisible();
  await expect(page.locator('#share-tool-link-copy')).toBeInViewport();
  await page.locator('#share-close').click();
  await expect(dialog).toBeHidden();
  await page.locator('#nav-toggle').click();
  const labs = page.locator('#sidebar-labs-link');
  await labs.scrollIntoViewIfNeeded();
  await expect(labs).toBeVisible();
  await expect(labs).toHaveAttribute('target', '_blank');
  expect(errors).toEqual([]);
});
