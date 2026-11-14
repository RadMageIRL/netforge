import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

test.describe('IP Range Analyzer', () => {
  test.beforeEach(async ({ page }) => openTool(page, 'ip-range-analyzer', 'IP Range Analyzer'));

  test('finds duplicates, containment, overlaps and gaps in the example', async ({ page }) => {
    const errors = watchErrors(page);
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('#ranges-findings tbody tr td:first-child')).toHaveText(['Contains', 'Contains', 'Overlap', 'Duplicate', 'Overlap', 'Contains']);
    await expect(page.locator('#ranges-overview tbody tr').first()).toHaveText(/IPv4\s*7\s*66,048\s*1\s*2\s*2/);
    await expect(page.locator('#ranges-gaps tbody tr td:first-child')).toHaveText(['10.21.1.0/24', '10.21.2.0/23', '10.21.4.0/22', '10.21.8.0/21', '10.21.16.0/20', '10.21.32.0/19', '10.21.64.0/18', '10.21.128.0/17']);
    await expect(page.locator('#ranges-result')).toContainText('Not entirely inside the parent: line 7 (192.168.10.0/25)');
    await expect(page.locator('#ranges-summary tbody tr td:nth-child(2)')).toHaveText(['10.20.0.0/16', '10.21.0.0/24', '192.168.10.0/24', '2001:db8:20::/48']);
    expect(errors).toEqual([]);
  });

  test('names each bad line and still analyzes the rest', async ({ page }) => {
    await page.fill('#ranges-input', '10.0.0.0/24\n10.0.0.300\n10.0.0.9 - 10.0.0.1\n10.0.0.0/25');
    await expect(page.locator('#ranges-result .problem-list li')).toHaveText([
      'Line 2: 300 is out of range: each part must be 0 to 255. (10.0.0.300)',
      'Line 3: The range ends before it starts. Put the lower address first. (10.0.0.9 - 10.0.0.1)',
    ]);
    await expect(page.locator('#ranges-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#ranges-findings tbody tr')).toHaveText([/Contains\s*1\s*10\.0\.0\.0\/24\s*4\s*10\.0\.0\.0\/25/]);
  });

  test('exports CSV and JSON and copies the summary', async ({ page, context }) => {
    await grantClipboard(context);
    await page.fill('#ranges-input', '10.0.0.0/25\n10.0.0.128/25\n2001:db8::/64');
    const csv = await download(page, () => page.getByRole('button', { name: 'CSV' }).click());
    expect(csv).toEqual({ name: 'ip-range-analysis.csv', text: [
      'Line,Input,Family,Normalized,First address,Last address,Addresses,Findings',
      '1,10.0.0.0/25,IPv4,10.0.0.0/25,10.0.0.0,10.0.0.127,128,',
      '2,10.0.0.128/25,IPv4,10.0.0.128/25,10.0.0.128,10.0.0.255,128,',
      '3,2001:db8::/64,IPv6,2001:db8::/64,2001:db8::,2001:db8::ffff:ffff:ffff:ffff,18446744073709551616,',
      '',
    ].join('\r\n') });
    const json = await download(page, () => page.getByRole('button', { name: 'JSON' }).click());
    expect(JSON.parse(json.text).families.map((f: { summary: string[] }) => f.summary)).toEqual([['10.0.0.0/24'], ['2001:db8::/64']]);
    await page.getByRole('button', { name: 'Copy summary' }).click();
    expect(await readClipboard(page)).toBe('10.0.0.0/24\n2001:db8::/64');
  });
});

test.describe('Route Summarization', () => {
  test.beforeEach(async ({ page }) => openTool(page, 'route-summarization', 'Route Summarization'));

  test('gives exact routes per family and keeps the broader supernet separate', async ({ page }) => {
    const errors = watchErrors(page);
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('#routes-v4-table tbody tr td:first-child')).toHaveText(['172.16.0.0/22', '172.16.5.0/24']);
    await expect(page.locator('#routes-v4 .status-line')).toHaveText('7 entries become 2 routes, covering exactly the same 1,280 addresses. Removed: 1 duplicate and 1 contained in another entry.');
    await expect(page.locator('#routes-v4 .notice-warning')).toContainText('Broader supernet (not exact): 172.16.0.0/21');
    await expect(page.locator('#routes-v4 .notice-warning')).toContainText('768 addresses that are not in your list');
    await expect(page.locator('#routes-v6-table tbody tr td:first-child')).toHaveText(['2001:db8:100::/47']);
    await expect(page.locator('#routes-v6 .notice-warning')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('never widens adjacent but unaligned networks', async ({ page }) => {
    await page.fill('#routes-input', '10.0.1.0/24\n10.0.2.0/24');
    await expect(page.locator('#routes-v4-table tbody tr td:first-child')).toHaveText(['10.0.1.0/24', '10.0.2.0/24']);
  });

  test('copies and exports only the exact routes', async ({ page, context }) => {
    await grantClipboard(context);
    await page.getByRole('button', { name: 'Example' }).click();
    await page.getByRole('button', { name: 'Copy routes', exact: true }).click();
    expect(await readClipboard(page)).toBe('172.16.0.0/22\n172.16.5.0/24\n2001:db8:100::/47');
    await page.getByRole('button', { name: 'Copy IPv4 routes' }).click();
    expect(await readClipboard(page)).toBe('172.16.0.0/22\n172.16.5.0/24');
    const csv = await download(page, () => page.getByRole('button', { name: 'CSV' }).click());
    expect(csv.text.split('\r\n').slice(1, 4)).toEqual(['IPv4,172.16.0.0/22,172.16.0.0,172.16.3.255,1024', 'IPv4,172.16.5.0/24,172.16.5.0,172.16.5.255,256', 'IPv6,2001:db8:100::/47,2001:db8:100::,2001:db8:101:ffff:ffff:ffff:ffff:ffff,2417851639229258349412352']);
    const json = JSON.parse((await download(page, () => page.getByRole('button', { name: 'JSON' }).click())).text);
    expect(json.ipv4.broaderSupernet).toEqual({ network: '172.16.0.0/21', extraAddresses: '768', exact: false });
  });

  test('reports bad lines by number', async ({ page }) => {
    await page.fill('#routes-input', '10.0.0.0/24\nnot-a-network');
    await expect(page.locator('#routes-result .problem-list li')).toHaveText([/^Line 2: /]);
  });
});
