import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, resultValue, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await openTool(page, 'subnet-calculator', 'Subnet Calculator');
});

test('shows every property of a /26', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#subnet-input', '192.168.1.130/26');
  const expected: Record<string, string> = {
    cidr: '192.168.1.128/26', address: '192.168.1.130', network: '192.168.1.128', broadcast: '192.168.1.191',
    mask: '255.255.255.192', wildcard: '0.0.0.63', prefix: '/26', total: '64', range: '192.168.1.129 - 192.168.1.190', usable: '62',
  };
  for (const [key, value] of Object.entries(expected)) await expect(resultValue(page, key)).toHaveText(value);
  expect(errors).toEqual([]);
});

test('/0 groups large counts for display', async ({ page }) => {
  await page.fill('#subnet-input', '0.0.0.0/0');
  await expect(resultValue(page, 'total')).toHaveText('4,294,967,296');
  await expect(resultValue(page, 'usable')).toHaveText('4,294,967,294');
  await expect(resultValue(page, 'range')).toHaveText('0.0.0.1 - 255.255.255.254');
  await expect(page.locator('#subnet-result .notice')).toContainText('entire IPv4 address space');
});

test('/31 has no broadcast and two usable hosts', async ({ page }) => {
  await page.fill('#subnet-input', '203.0.113.9/31');
  await expect(resultValue(page, 'broadcast')).toHaveText('None');
  await expect(page.locator('tr[data-key="broadcast"] button')).toHaveCount(0);
  await expect(resultValue(page, 'usable')).toHaveText('2');
  await expect(resultValue(page, 'range')).toHaveText('203.0.113.8 - 203.0.113.9');
  await expect(page.locator('#subnet-result .notice')).toContainText('RFC 3021');
});

test('/32 is a single host', async ({ page }) => {
  await page.fill('#subnet-input', '198.51.100.7 255.255.255.255');
  await expect(resultValue(page, 'prefix')).toHaveText('/32');
  await expect(resultValue(page, 'range')).toHaveText('198.51.100.7');
  await expect(resultValue(page, 'usable')).toHaveText('1');
  await expect(resultValue(page, 'broadcast')).toHaveText('None');
});

test('invalid input shows an error, clears the result and disables export', async ({ page }) => {
  await page.fill('#subnet-input', '192.168.1.300/24');
  await expect(page.locator('#subnet-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error')).toContainText('300 is out of range');
  await expect(page.locator('#subnet-result table')).toHaveCount(0);
  for (const name of ['Copy all', 'CSV', 'JSON']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.fill('#subnet-input', '10.0.0.1 0.0.0.255');
  await expect(page.locator('.field-error')).toContainText('wildcard');
  await page.fill('#subnet-input', '10.0.0.1/24');
  await expect(page.locator('#subnet-input')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error')).toBeHidden();
});

test('example buttons fill the input', async ({ page }) => {
  await page.getByRole('button', { name: '172.16.5.4 255.255.240.0' }).click();
  await expect(page.locator('#subnet-input')).toHaveValue('172.16.5.4 255.255.240.0');
  await expect(resultValue(page, 'cidr')).toHaveText('172.16.0.0/20');
});

test.describe('copy and export', () => {
  test.beforeEach(async ({ context }) => grantClipboard(context));

  test('copies a single value, raw digits for counts', async ({ page }) => {
    await page.fill('#subnet-input', '10.0.0.0/8');
    await page.getByRole('button', { name: 'Copy broadcast address' }).click();
    expect(await readClipboard(page)).toBe('10.255.255.255');
    await page.getByRole('button', { name: 'Copy total addresses' }).click();
    expect(await readClipboard(page)).toBe('16777216');
    await expect(page.locator('#live-region')).toHaveText('Copied total addresses to the clipboard.');
  });

  test('copies all results as labeled lines', async ({ page }) => {
    await page.fill('#subnet-input', '10.0.0.5/30');
    await page.getByRole('button', { name: 'Copy all' }).click();
    expect(await readClipboard(page)).toBe([
      'Network (CIDR): 10.0.0.4/30', 'Address: 10.0.0.5', 'Network address: 10.0.0.4', 'Broadcast address: 10.0.0.7',
      'Subnet mask: 255.255.255.252', 'Wildcard mask: 0.0.0.3', 'Prefix length: /30', 'Total addresses: 4',
      'Usable host range: 10.0.0.5 - 10.0.0.6', 'Usable hosts: 2',
    ].join('\n'));
  });

  test('falls back to the legacy copy command when the Clipboard API is unavailable', async ({ page }) => {
    await page.fill('#subnet-input', '10.0.0.0/8');
    await page.evaluate(() => {
      const read = navigator.clipboard.readText.bind(navigator.clipboard);
      (window as unknown as { readClip: () => Promise<string> }).readClip = read;
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    await page.getByRole('button', { name: 'Copy subnet mask' }).click();
    expect(await page.evaluate(() => (window as unknown as { readClip: () => Promise<string> }).readClip())).toBe('255.0.0.0');
    await expect(page.locator('#subnet-input')).not.toBeFocused();
    await expect(page.locator('.toast-ok')).toContainText('Copied subnet mask');
  });

  test('downloads CSV with exact values', async ({ page }) => {
    await page.fill('#subnet-input', '192.168.1.130/26');
    const file = await download(page, () => page.getByRole('button', { name: 'CSV' }).click());
    expect(file.name).toBe('subnet-192.168.1.128-26.csv');
    expect(file.text).toBe([
      'Field,Value', 'Network (CIDR),192.168.1.128/26', 'Address,192.168.1.130', 'Network address,192.168.1.128',
      'Broadcast address,192.168.1.191', 'Subnet mask,255.255.255.192', 'Wildcard mask,0.0.0.63', 'Prefix length,/26',
      'Total addresses,64', 'Usable host range,192.168.1.129 - 192.168.1.190', 'Usable hosts,62', '',
    ].join('\r\n'));
  });

  test('downloads JSON with typed fields', async ({ page }) => {
    await page.fill('#subnet-input', '203.0.113.9/31');
    const file = await download(page, () => page.getByRole('button', { name: 'JSON' }).click());
    expect(file.name).toBe('subnet-203.0.113.8-31.json');
    expect(JSON.parse(file.text)).toEqual({
      cidr: '203.0.113.8/31', address: '203.0.113.9', network: '203.0.113.8', broadcast: null, subnetMask: '255.255.255.254',
      wildcardMask: '0.0.0.1', prefixLength: 31, totalAddresses: 2, firstUsable: '203.0.113.8', lastUsable: '203.0.113.9',
      usableHosts: 2, kind: 'point-to-point',
    });
  });
});
