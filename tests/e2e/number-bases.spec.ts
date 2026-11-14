import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { grantClipboard, openTool, readClipboard, resultValue, watchErrors } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.target.join(' ')).join(', ')})`);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test.beforeEach(async ({ page }) => {
  await openTool(page, 'number-bases', 'Number Bases & Bytes');
});

test('converts a decimal number to every base at 32 bits', async ({ page }) => {
  const errors = watchErrors(page);
  await expect(page.locator('#num-result')).toContainText('Enter a number');
  await page.fill('#num-input', '305419896');
  await expect(resultValue(page, 'hex')).toHaveText('0x12345678');
  await expect(resultValue(page, 'binary')).toHaveText('0001 0010 0011 0100 0101 0110 0111 1000');
  await expect(resultValue(page, 'octal')).toHaveText('0o02215053170');
  await expect(resultValue(page, 'decimal')).toHaveText('305419896');
  await expect(resultValue(page, 'bytes-be')).toHaveText('12 34 56 78');
  await expect(resultValue(page, 'bytes-le')).toHaveText('78 56 34 12');
  await expect(resultValue(page, 'bits-needed')).toHaveText('29');
  await expect(page.locator('#num-status')).toContainText('32-bit unsigned: 0 to 4,294,967,295');
  await page.getByRole('radio', { name: '8', exact: true }).check();
  await expect(resultValue(page, 'binary')).toHaveText('00010010 00110100 01010110 01111000');
  expect(errors).toEqual([]);
});

test('shows two\'s complement for signed values and reads hex as a bit pattern', async ({ page }) => {
  await page.getByRole('button', { name: 'Example', exact: true }).click();
  await expect(page.locator('#num-input')).toHaveValue('-2');
  await expect(resultValue(page, 'hex')).toHaveText('0xfffe');
  await expect(resultValue(page, 'unsigned')).toHaveText('65534');
  await expect(resultValue(page, 'signed')).toHaveText('-2');
  await expect(resultValue(page, 'bytes-le')).toHaveText('fe ff');

  await page.selectOption('#num-base', '16');
  await page.selectOption('#num-width', '8');
  await page.fill('#num-input', 'ff');
  await expect(resultValue(page, 'decimal')).toHaveText('-1');
  await expect(page.locator('#num-notes')).toContainText('bit pattern');
  await page.getByRole('radio', { name: 'Unsigned' }).check();
  await expect(resultValue(page, 'decimal')).toHaveText('255');
  await expect(page.locator('#num-notes')).toHaveCount(0);
});

test('reports overflow, bad digits and prefix mismatches at the field', async ({ page }) => {
  await page.selectOption('#num-width', '8');
  await page.fill('#num-input', '256');
  await expect(page.locator('#num-input-error')).toContainText('does not fit in 8 bits unsigned. The range is 0 to 255');
  await expect(page.locator('#num-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#num-result .result-table')).toHaveCount(0);
  await page.fill('#num-input', '-1');
  await expect(page.locator('#num-input-error')).toContainText('cannot be stored as unsigned');
  await page.fill('#num-input', '12z');
  await expect(page.locator('#num-input-error')).toContainText('"z" is not a decimal digit');
  await expect(page.locator('#num-status')).toContainText('position 3');
  await page.fill('#num-input', '0xff');
  await expect(page.locator('#num-input-error')).toContainText('marks hexadecimal, but the input base is decimal');
  await page.selectOption('#num-base', '16');
  await expect(page.locator('#num-input-error')).toBeHidden();
  await expect(resultValue(page, 'decimal')).toHaveText('255');
});

test('handles custom widths, no width and values far beyond 64 bits exactly', async ({ page }) => {
  await page.selectOption('#num-width', 'custom');
  await expect(page.locator('#num-custom-width')).toBeVisible();
  await page.fill('#num-custom-width', '12');
  await page.fill('#num-input', '4095');
  await expect(resultValue(page, 'hex')).toHaveText('0xfff');
  await expect(page.locator('#num-bytes-note')).toContainText('12 bits is not a whole number of bytes');
  await expect(page.locator('tr[data-key="bytes-be"]')).toHaveCount(0);
  await page.fill('#num-custom-width', '5000');
  await expect(page.locator('#num-custom-width-error')).toContainText('1 to 4096');
  await page.fill('#num-custom-width', '12');
  await expect(resultValue(page, 'hex')).toHaveText('0xfff');

  await page.selectOption('#num-width', 'none');
  await expect(page.locator('#num-custom-width')).toBeHidden();
  const big = (2n ** 200n + 1n).toString();
  await page.fill('#num-input', big);
  await expect(resultValue(page, 'hex')).toHaveText(`0x1${'0'.repeat(49)}1`);
  await expect(resultValue(page, 'decimal')).toHaveText(big);
  await page.getByRole('radio', { name: 'Signed', exact: true }).check();
  await page.fill('#num-input', '-255');
  await expect(resultValue(page, 'hex')).toHaveText('-0xff');
  await expect(page.locator('#num-bytes-note')).toContainText('negative value has no byte representation');
});

test('copies the plain digits of a row', async ({ page, context }) => {
  await grantClipboard(context);
  await page.selectOption('#num-width', '16');
  await page.fill('#num-input', '1000');
  await page.locator('tr[data-key="binary"] button').click();
  expect(await readClipboard(page)).toBe('0000001111101000');
  await page.locator('tr[data-key="hex"] button').click();
  expect(await readClipboard(page)).toBe('03e8');
});

test('converts storage units exactly', async ({ page }) => {
  await page.fill('#unit-amount', '1.5');
  await expect(page.locator('#unit-status')).toContainText('exactly 1,610,612,736 bytes');
  await expect(resultValue(page, 'unit-MiB')).toHaveText('1536');
  await expect(resultValue(page, 'unit-GB')).toHaveText('1.610612736');
  await expect(resultValue(page, 'unit-bit')).toHaveText('12884901888');
  await page.selectOption('#unit-from', 'GB');
  await page.fill('#unit-amount', '500');
  await expect(resultValue(page, 'unit-GiB')).toHaveText('465.6612873077392578125');
  await expect(page.locator('tr[data-key="unit-GiB"] .value-note')).toContainText('about 465.661287308 rounded to 12 significant digits');
  await page.selectOption('#unit-from', 'bit');
  await page.fill('#unit-amount', '12');
  await expect(page.locator('#unit-status')).toContainText('12 bits, which is not a whole number of bytes');
  await page.fill('#unit-amount', '1e3');
  await expect(page.locator('#unit-amount-error')).toContainText('plain decimal amount');
  await expect(page.locator('#unit-result .result-table')).toHaveCount(0);
});

test('is accessible and fits a phone-width screen with long values', async ({ page }) => {
  await page.selectOption('#num-width', 'none');
  await page.fill('#num-input', (2n ** 600n).toString());
  await page.fill('#unit-amount', '1');
  await page.selectOption('#unit-from', 'bit');
  expect(await axe(page)).toEqual([]);
  await page.fill('#num-input', '0x1');
  expect(await axe(page)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.fill('#num-input', (2n ** 600n).toString());
  await noSidewaysScroll(page);
  expect(await axe(page)).toEqual([]);
});

test('stores nothing', async ({ page }) => {
  await page.fill('#num-input', '123456789');
  await page.fill('#unit-amount', '42');
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
  expect(stored).not.toContain('123456789');
  expect(stored).not.toContain('"42"');
  await page.reload();
  await expect(page.locator('#num-input')).toHaveValue('');
  await expect(page.locator('#unit-amount')).toHaveValue('');
});
