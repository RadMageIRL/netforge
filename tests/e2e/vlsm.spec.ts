import { expect, test, type Page } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await openTool(page, 'vlsm-allocator', 'VLSM Allocator');
});

const cell = (page: Page, column: string, n: number, noun = 'request') => page.getByLabel(`${column}, ${noun} ${n}`, { exact: true });
const tableColumn = (page: Page, index: number) => page.locator(`#vlsm-table tbody tr td:nth-child(${index})`);

test('allocates the brief example largest first at aligned addresses', async ({ page }) => {
  const errors = watchErrors(page);
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#vlsm-result .notice-ok')).toHaveText('All 6 requests were placed in 10.40.0.0/16.');
  await expect(tableColumn(page, 1)).toHaveText(['Clients', 'Servers', 'Voice', 'Cameras', 'Printers', 'Management']);
  await expect(tableColumn(page, 3)).toHaveText(['10.40.0.0/22', '10.40.4.0/23', '10.40.6.0/23', '10.40.8.0/25', '10.40.8.128/25', '10.40.9.0/27']);
  await expect(tableColumn(page, 5).first()).toHaveText('10.40.0.1 - 10.40.3.254');
  await expect(page.locator('#vlsm-free tbody tr td:first-child').first()).toHaveText('10.40.9.32/27');
  await expect(page.locator('#vlsm-result .summary-table')).toContainText('Requested hosts / capacity1,980 of 2,324 (85.2%)');
  expect(errors).toEqual([]);
});

test('point-to-point sizing turns 2-host requests into /31s', async ({ page }) => {
  await page.fill('#vlsm-parent', '10.0.0.0/29');
  await cell(page, 'Name', 1).fill('link-a');
  await cell(page, 'Hosts', 1).fill('2');
  await cell(page, 'Name', 2).fill('link-b');
  await cell(page, 'Hosts', 2).fill('2');
  await expect(tableColumn(page, 3)).toHaveText(['10.0.0.0/30', '10.0.0.4/30']);
  await page.getByLabel('Use /31 for 2-host and /32 for 1-host requests (RFC 3021 point-to-point)').check();
  await expect(tableColumn(page, 3)).toHaveText(['10.0.0.0/31', '10.0.0.2/31']);
  await expect(tableColumn(page, 7)).toHaveText(['2', '2']);
});

test('marks bad rows and lists every problem before allocating', async ({ page }) => {
  await page.fill('#vlsm-parent', '10.0.0.0/24');
  await cell(page, 'Name', 1).fill('Servers');
  await cell(page, 'Hosts', 1).fill('50');
  await cell(page, 'Name', 3).fill('servers');
  await cell(page, 'Hosts', 3).fill('ten');
  await expect(cell(page, 'Hosts', 3)).toHaveAttribute('aria-invalid', 'true');
  await expect(cell(page, 'Hosts', 1)).not.toHaveAttribute('aria-invalid', 'true');
  const problems = page.locator('#vlsm-result .problem-list li');
  await expect(problems).toHaveText([
    'Request 3: the name "servers" is already used by request 1.',
    'Request 3: enter a whole number of hosts of at least 1, such as 400.',
  ]);
  await expect(page.locator('#vlsm-table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV' })).toBeDisabled();
});

test('explains the parent error for IPv6', async ({ page }) => {
  await page.fill('#vlsm-parent', '2001:db8::/48');
  await cell(page, 'Name', 1).fill('A');
  await cell(page, 'Hosts', 1).fill('10');
  await expect(page.locator('#vlsm-parent-error')).toContainText('applies to IPv4 only');
});

test('works around fixed and reserved space and reports what does not fit', async ({ page }) => {
  await page.fill('#vlsm-parent', '10.0.0.0/24');
  await cell(page, 'Name', 1).fill('A');
  await cell(page, 'Hosts', 1).fill('60');
  await cell(page, 'Name', 2).fill('B');
  await cell(page, 'Hosts', 2).fill('100');
  await cell(page, 'Name', 1, 'fixed allocation').fill('DMZ');
  await cell(page, 'Network', 1, 'fixed allocation').fill('10.0.0.64/26');
  await cell(page, 'Label', 1, 'reserved range').fill('Infrastructure');
  await cell(page, 'Range', 1, 'reserved range').fill('10.0.0.0 - 10.0.0.9');
  await expect(tableColumn(page, 1)).toHaveText(['Infrastructure', 'DMZ', 'B']);
  await expect(page.locator('#vlsm-result .notice-error')).toContainText('A needs a /26 (64 addresses for 60 hosts) but does not fit.');
  await cell(page, 'Network', 1, 'fixed allocation').fill('10.0.0.0/28');
  await expect(page.locator('#vlsm-result .problem-list')).toContainText('overlaps reservation "Infrastructure" (10.0.0.0 - 10.0.0.9)');
});

test('adds rows with Enter and removes them by keyboard', async ({ page }) => {
  await cell(page, 'Hosts', 3).click();
  await page.keyboard.press('Enter');
  await expect(cell(page, 'Name', 4)).toBeFocused();
  await page.getByRole('button', { name: 'Remove request 2' }).click();
  await expect(cell(page, 'Name', 2)).toBeFocused();
  await expect(page.locator('#vlsm-requests tbody input')).toHaveCount(6);
  await page.getByRole('button', { name: 'Add request' }).click();
  await expect(cell(page, 'Name', 4)).toBeFocused();
});

test.describe('export', () => {
  test.beforeEach(async ({ page }) => page.getByRole('button', { name: 'Example' }).click());

  test('downloads the plan as CSV and JSON', async ({ page }) => {
    const csv = await download(page, () => page.getByRole('button', { name: 'CSV' }).click());
    expect(csv.name).toBe('vlsm-10.40.0.0-16.csv');
    const rows = csv.text.split('\r\n');
    expect(rows[0]).toBe('Name,Type,Network,Subnet mask,First usable,Last usable,Requested hosts,Host capacity,Addresses');
    expect(rows[1]).toBe('Clients,Request,10.40.0.0/22,255.255.252.0,10.40.0.1,10.40.3.254,1000,1022,1024');
    expect(rows[7]).toBe(',Free,10.40.9.32/27,255.255.255.224,,,,,32');
    const json = await download(page, () => page.getByRole('button', { name: 'JSON' }).click());
    const plan = JSON.parse(json.text) as { allocations: { name: string; network: string }[]; summary: { freeAddresses: number } };
    expect(plan.allocations.map(a => `${a.name} ${a.network}`)).toEqual(['Clients 10.40.0.0/22', 'Servers 10.40.4.0/23', 'Voice 10.40.6.0/23', 'Cameras 10.40.8.0/25', 'Printers 10.40.8.128/25', 'Management 10.40.9.0/27']);
    expect(plan.summary.freeAddresses).toBe(63200);
  });

  test('copies the table as tab-separated text for spreadsheets', async ({ page, context }) => {
    await grantClipboard(context);
    await page.getByRole('button', { name: 'Copy table' }).click();
    const lines = (await readClipboard(page)).split('\n');
    expect(lines[0].split('\t')).toEqual(['Name', 'Type', 'Network', 'Subnet mask', 'Usable range', 'Requested hosts', 'Host capacity']);
    expect(lines[1].split('\t')).toEqual(['Clients', 'Request', '10.40.0.0/22', '255.255.252.0', '10.40.0.1 - 10.40.3.254', '1000', '1022']);
    expect(lines).toHaveLength(7);
  });
});
