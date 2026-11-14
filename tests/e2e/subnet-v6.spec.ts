import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, resultValue, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await openTool(page, 'subnet-calculator', 'Subnet Calculator');
});

test('IPv4 is the default family', async ({ page }) => {
  await expect(page.getByRole('radio', { name: 'IPv4' })).toBeChecked();
  await expect(page.getByLabel('IPv4 address and prefix')).toBeVisible();
});

test('shows an IPv6 prefix in canonical and expanded form, with no broadcast or usable-host rows', async ({ page }) => {
  const errors = watchErrors(page);
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await page.getByLabel('IPv6 address and prefix').fill('2001:0DB8:ABCD:0012:0000:0000:0000:0001/64');
  const expected: Record<string, string> = {
    'cidr': '2001:db8:abcd:12::/64',
    'address': '2001:db8:abcd:12::1',
    'address-expanded': '2001:0db8:abcd:0012:0000:0000:0000:0001',
    'network': '2001:db8:abcd:12::',
    'last': '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
    'prefix': '/64',
    'mask': 'ffff:ffff:ffff:ffff::',
    'total': '18,446,744,073,709,551,616',
    'subnets64': '1',
  };
  for (const [key, value] of Object.entries(expected)) await expect(resultValue(page, key)).toHaveText(value);
  await expect(page.locator('tr[data-key="address"] .value-note')).toHaveText('Written in the RFC 5952 canonical form.');
  await expect(page.locator('tr[data-key="broadcast"], tr[data-key="usable"], tr[data-key="range"]')).toHaveCount(0);
  await expect(page.locator('#subnet-result .notice')).toContainText('IPv6 has no broadcast address');
  expect(errors).toEqual([]);
});

test('handles /0, /127 and /128', async ({ page }) => {
  await page.getByRole('radio', { name: 'IPv6' }).check();
  const input = page.locator('#subnet-input');
  await input.fill('::/0');
  await expect(resultValue(page, 'total')).toHaveText('340,282,366,920,938,463,463,374,607,431,768,211,456');
  await expect(resultValue(page, 'last')).toHaveText('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  await input.fill('2001:db8::a/127');
  await expect(resultValue(page, 'cidr')).toHaveText('2001:db8::a/127');
  await expect(page.locator('#subnet-result .notice')).toContainText('RFC 6164');
  await input.fill('::1/128');
  await expect(resultValue(page, 'total')).toHaveText('1');
  await expect(page.locator('#subnet-result .notice')).toContainText('single address');
});

test('rejects invalid IPv6 with a clear message', async ({ page }) => {
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await page.fill('#subnet-input', '2001:db8::1::/64');
  await expect(page.locator('#subnet-input-error')).toContainText("'::' may appear only once");
  await page.fill('#subnet-input', '2001:db8::/129');
  await expect(page.locator('#subnet-input-error')).toContainText('0 to 128');
  await page.fill('#subnet-input', 'fe80::1%eth0/64');
  await expect(page.locator('#subnet-input-error')).toContainText('Zone indexes');
});

test('offers to switch family when the input belongs to the other one, carrying the text', async ({ page }) => {
  await page.fill('#subnet-input', '2001:db8::/48');
  await expect(page.locator('#subnet-input-error')).toContainText('IPv6 address');
  await page.getByRole('button', { name: 'Switch to IPv6' }).click();
  await expect(page.getByRole('radio', { name: 'IPv6' })).toBeChecked();
  await expect(resultValue(page, 'cidr')).toHaveText('2001:db8::/48');
  await page.fill('#subnet-input', '10.0.0.0/8');
  await page.getByRole('button', { name: 'Switch to IPv4' }).click();
  await expect(resultValue(page, 'broadcast')).toHaveText('10.255.255.255');
});

test('keeps a separate input for each family', async ({ page }) => {
  await page.fill('#subnet-input', '10.1.0.0/16');
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await expect(page.locator('#subnet-input')).toHaveValue('');
  await page.fill('#subnet-input', 'fd00::/8');
  await page.getByRole('radio', { name: 'IPv4' }).check();
  await expect(page.locator('#subnet-input')).toHaveValue('10.1.0.0/16');
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await expect(page.locator('#subnet-input')).toHaveValue('fd00::/8');
});

test.describe('classification', () => {
  test('shows every matching registry block and lets the most specific decide reachability', async ({ page }) => {
    await page.fill('#subnet-input', '192.0.0.9/32');
    const panel = page.locator('#class-result');
    await expect(panel.locator('.chip-static')).toHaveText(['IETF protocol assignment', 'Anycast']);
    await expect(panel.locator('.summary-table')).toContainText('Globally reachable (registry)Yes');
    await expect(panel.locator('#class-matches tbody tr')).toHaveCount(2);
    await expect(panel.locator('#class-matches tbody tr').first()).toContainText('192.0.0.9/32');
    await expect(panel).toContainText('Registry note: Not useable unless by virtue of a more specific reservation.');
    await expect(panel.locator('.source-note')).toContainText('updated 2025-10-09, bundled with NetForge on 2026-11-14');
  });

  test('explains that ordinary addresses are not listed and routing cannot be checked offline', async ({ page }) => {
    await page.fill('#subnet-input', '8.8.8.8/32');
    await expect(page.locator('#class-result')).toContainText('No special-purpose properties.');
    await expect(page.locator('#class-result .reach-note')).toContainText('cannot check offline');
  });

  test('lists special-purpose blocks inside a larger prefix', async ({ page }) => {
    await page.fill('#subnet-input', '192.0.0.0/23');
    await expect(page.locator('#class-result')).toContainText('Special-purpose blocks inside 192.0.0.0/23');
  });

  test('shows the IPv6 address space, multicast scope and embedded IPv4', async ({ page }) => {
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', 'ff02::1/128');
    await expect(page.locator('#class-result .summary-table')).toContainText('Link-local scope (2)');
    await page.fill('#subnet-input', '::ffff:10.1.2.3/128');
    await expect(page.locator('#class-result .summary-table')).toContainText('10.1.2.3: Private / local use');
    await page.fill('#subnet-input', '2001:db8::/32');
    await expect(page.locator('#class-result .summary-table')).toContainText('Global Unicast (2000::/3)');
  });
});

test.describe('splitting and supernets', () => {
  test('splits an IPv4 /24 into /26s', async ({ page }) => {
    await page.fill('#subnet-input', '10.0.0.0/24');
    await page.locator('#split-panel summary').click();
    await page.locator('#split-length').selectOption('26');
    await expect(page.locator('#split-result .status-line')).toHaveText('10.0.0.0/24 splits into 4 subnets of /26.');
    await expect(page.locator('#split-table tbody tr td:first-child')).toHaveText(['10.0.0.0/26', '10.0.0.64/26', '10.0.0.128/26', '10.0.0.192/26']);
  });

  test('splits an IPv6 /48 into /64s by default and pages the list', async ({ page }) => {
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8:1234::/48');
    await page.locator('#split-panel summary').click();
    await expect(page.locator('#split-length')).toHaveValue('64');
    await expect(page.locator('#split-result .status-line')).toHaveText('2001:db8:1234::/48 splits into 65,536 subnets of /64.');
    await expect(page.locator('#split-result .notice')).toContainText('Showing the first 256 of 65,536');
    await expect(page.locator('#split-table tbody tr')).toHaveCount(256);
    await expect(page.locator('#split-table tbody tr').nth(1).locator('td').first()).toHaveText('2001:db8:1234:1::/64');
  });

  test('exports every subnet of a split up to the export limit', async ({ page }) => {
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8:1234::/48');
    await page.locator('#split-panel summary').click();
    const file = await download(page, () => page.locator('#split-panel').getByRole('button', { name: 'CSV' }).click());
    expect(file.name).toBe('subnet-2001-db8-1234---48-split-64.csv');
    const rows = file.text.trimEnd().split('\r\n');
    expect(rows).toHaveLength(65_537);
    expect(rows[1]).toBe('2001:db8:1234::/64,2001:db8:1234::,2001:db8:1234:0:ffff:ffff:ffff:ffff,18446744073709551616');
    expect(rows[65_536]).toBe('2001:db8:1234:ffff::/64,2001:db8:1234:ffff::,2001:db8:1234:ffff:ffff:ffff:ffff:ffff,18446744073709551616');
  });

  test('cannot split a single address', async ({ page }) => {
    await page.fill('#subnet-input', '10.0.0.1/32');
    await page.locator('#split-panel summary').click();
    await expect(page.locator('#split-result')).toContainText('cannot be split');
    await expect(page.locator('#split-length')).toBeDisabled();
  });

  test('finds a supernet and copies it', async ({ page, context }) => {
    await grantClipboard(context);
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8:abcd:12::/64');
    await page.locator('#supernet-panel summary').click();
    await page.locator('#supernet-length').selectOption('48');
    await expect(page.locator('#supernet-result')).toContainText('Supernet2001:db8:abcd::/48');
    await expect(page.locator('#supernet-result')).toContainText('65,536 networks the size of /64');
    await page.getByRole('button', { name: 'Copy supernet' }).click();
    expect(await readClipboard(page)).toBe('2001:db8:abcd::/48');
  });
});

test.describe('IPv6 copy and export', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context));

  test('copies all IPv6 results', async ({ page }) => {
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8::/126');
    await page.locator('.result-panel').getByRole('button', { name: 'Copy all' }).click();
    expect(await readClipboard(page)).toBe([
      'Network (CIDR): 2001:db8::/126', 'Address: 2001:db8::', 'Address (expanded): 2001:0db8:0000:0000:0000:0000:0000:0000',
      'Network address: 2001:db8::', 'Network address (expanded): 2001:0db8:0000:0000:0000:0000:0000:0000',
      'Last address: 2001:db8::3', 'Last address (expanded): 2001:0db8:0000:0000:0000:0000:0000:0003', 'Prefix length: /126',
      'Prefix mask: ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffc', 'Total addresses: 4',
    ].join('\n'));
  });

  test('downloads IPv6 details as JSON with exact counts', async ({ page }) => {
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8::/32');
    const file = await download(page, () => page.locator('.result-panel').getByRole('button', { name: 'JSON' }).click());
    expect(file.name).toBe('subnet-2001-db8---32.json');
    expect(JSON.parse(file.text)).toMatchObject({ family: 'IPv6', cidr: '2001:db8::/32', totalAddresses: '79228162514264337593543950336', subnets64: '4294967296' });
  });
});
