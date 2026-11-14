import { expect, test } from '@playwright/test';
import { openTool, resultValue, watchErrors } from './helpers';

// playwright.config.ts runs the browser in America/New_York.

test.beforeEach(async ({ page }) => {
  await openTool(page, 'timestamp-converter', 'Timestamp Converter');
});

test('detects the device time zone and selects it by default', async ({ page }) => {
  await expect(page.locator('#timestamp-zone option:checked')).toHaveText('This device (America/New_York)');
});

test('converts Unix seconds to UTC and the device zone', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#timestamp-input', '1700000000');
  await expect(page.locator('#timestamp-result .notice-info')).toContainText('Read as Unix seconds');
  await expect(resultValue(page, 'seconds')).toHaveText('1700000000');
  await expect(resultValue(page, 'milliseconds')).toHaveText('1700000000000');
  await expect(resultValue(page, 'iso-utc')).toHaveText('2023-11-14T22:13:20Z');
  await expect(resultValue(page, 'iso-zone')).toHaveText('2023-11-14T17:13:20-05:00');
  await expect(resultValue(page, 'offset')).toHaveText('-05:00');
  await expect(resultValue(page, 'readable-utc')).toHaveText(/^Tuesday, November 14, 2023 at 10:13:20.PM UTC$/);
  await expect(resultValue(page, 'readable-zone')).toHaveText(/^Tuesday, November 14, 2023 at 5:13:20.PM EST$/);
  expect(errors).toEqual([]);
});

test('an explicit unit overrides Auto', async ({ page }) => {
  await page.fill('#timestamp-input', '1700000000');
  await page.getByRole('radio', { name: 'Milliseconds' }).check();
  await expect(resultValue(page, 'iso-utc')).toHaveText('1970-01-20T16:13:20Z');
});

test('reports a time skipped by the spring-forward change', async ({ page }) => {
  await page.fill('#timestamp-input', '2026-03-08 02:30');
  const error = page.locator('#timestamp-result .notice-error');
  await expect(error).toContainText('2026-03-08 02:30:00 does not exist in America/New_York.');
  await expect(error).toContainText('Clocks jumped forward from 02:00 to 03:00 (UTC offset -05:00 to -04:00) at 2026-03-08T07:00:00Z.');
  await expect(page.locator('#timestamp-result table')).toHaveCount(0);
});

test('offers both occurrences of a time repeated by the fall-back change', async ({ page }) => {
  await page.fill('#timestamp-input', '2026-11-01 01:30');
  await expect(page.locator('#timestamp-result .notice-warning')).toContainText('2026-11-01 01:30:00 happens twice in America/New_York.');
  await expect(resultValue(page, 'iso-utc')).toHaveText('2026-11-01T05:30:00Z');
  await expect(resultValue(page, 'iso-zone')).toHaveText('2026-11-01T01:30:00-04:00');
  await page.getByRole('radio', { name: 'Later (-05:00)' }).check();
  await expect(resultValue(page, 'iso-utc')).toHaveText('2026-11-01T06:30:00Z');
  await expect(resultValue(page, 'iso-zone')).toHaveText('2026-11-01T01:30:00-05:00');
});

test('a chosen zone is used for wall times and remembered', async ({ page }) => {
  await page.locator('#timestamp-zone').selectOption('Asia/Kolkata');
  await page.fill('#timestamp-input', '2026-11-14T08:30');
  await expect(page.locator('#timestamp-result .notice-info')).toContainText('wall-clock time in Asia/Kolkata');
  await expect(resultValue(page, 'iso-utc')).toHaveText('2026-11-14T03:00:00Z');
  await expect(resultValue(page, 'iso-zone')).toHaveText('2026-11-14T08:30:00+05:30');
  await page.reload();
  await expect(page.locator('#timestamp-zone')).toHaveValue('Asia/Kolkata');
  await expect(page.locator('#timestamp-input')).toHaveValue('');
  await page.locator('#timestamp-zone').selectOption('');
  expect(await page.evaluate(() => localStorage.getItem('netforge.timeZone'))).toBeNull();
});

test('ISO input with an offset ignores the selected zone for the instant', async ({ page }) => {
  await page.locator('#timestamp-zone').selectOption('Asia/Tokyo');
  await page.fill('#timestamp-input', '2026-11-14T08:30:00-08:00');
  await expect(resultValue(page, 'iso-utc')).toHaveText('2026-11-14T16:30:00Z');
  await expect(resultValue(page, 'iso-zone')).toHaveText('2026-11-15T01:30:00+09:00');
});

test('invalid input explains the problem', async ({ page }) => {
  await page.fill('#timestamp-input', '2026-02-30');
  await expect(page.locator('#timestamp-input-error')).toContainText('2026-02 has no day 30.');
  await expect(page.locator('#timestamp-input')).toHaveAttribute('aria-invalid', 'true');
  await page.fill('#timestamp-input', '1700000000000000');
  await expect(page.locator('#timestamp-input-error')).toContainText('microseconds');
});

test('Now fills in the current time', async ({ page }) => {
  const before = Math.floor(Date.now() / 1000);
  await page.getByRole('button', { name: 'Now' }).click();
  const value = Number(await page.locator('#timestamp-input').inputValue());
  expect(value).toBeGreaterThanOrEqual(before - 1);
  expect(value).toBeLessThanOrEqual(before + 5);
  await expect(resultValue(page, 'relative')).toHaveText(/now|second/);
});

test.describe('in another device zone', () => {
  test.use({ timezoneId: 'Asia/Kathmandu' });

  test('uses that zone as the device default', async ({ page }) => {
    await expect(page.locator('#timestamp-zone option:checked')).toHaveText('This device (Asia/Kathmandu)');
    await page.fill('#timestamp-input', '1700000000');
    await expect(resultValue(page, 'iso-zone')).toHaveText('2023-11-15T03:58:20+05:45');
  });
});
