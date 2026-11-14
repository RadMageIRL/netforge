import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

const EURO = String.fromCodePoint(0x20ac);
const ROCKET = String.fromCodePoint(0x1f680);
const REPLACEMENT = String.fromCodePoint(0xfffd);

test.beforeEach(async ({ page }) => {
  await openTool(page, 'base64-url-hex', 'Base64 / URL / Hex');
});

test('encodes Unicode text to Base64 and reports sizes', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#codec-input', `price: 5${EURO} ${ROCKET}`);
  await expect(page.locator('#codec-output')).toHaveValue(Buffer.from(`price: 5${EURO} ${ROCKET}`, 'utf8').toString('base64'));
  await expect(page.locator('#codec-status')).toContainText('Converted');
  await expect(page.locator('#codec-status')).toContainText('12 characters in, 16 bytes of data, 24 characters out');
  expect(errors).toEqual([]);
});

test('converts between every representation through the bytes', async ({ page }) => {
  await page.fill('#codec-input', 'a?b c/~');
  await page.selectOption('#codec-to', 'base64url');
  await expect(page.locator('#codec-output')).toHaveValue('YT9iIGMvfg');
  await page.selectOption('#codec-to', 'hex');
  await expect(page.locator('#codec-output')).toHaveValue('613f6220632f7e');
  await page.locator('#codec-upper').check();
  await expect(page.locator('#codec-output')).toHaveValue('613F6220632F7E');
  await page.selectOption('#codec-to', 'url');
  await expect(page.locator('#codec-output')).toHaveValue('a%3Fb%20c%2F~');
  await page.locator('#codec-plus').check();
  await expect(page.locator('#codec-output')).toHaveValue('a%3Fb+c%2F~');
  // Swap makes the output the input and converts back.
  await page.locator('#codec-swap').click();
  await expect(page.locator('#codec-from')).toHaveValue('url');
  await expect(page.locator('#codec-to')).toHaveValue('text');
  await expect(page.locator('#codec-output')).toHaveValue('a?b c/~');
});

test('shows only the options that apply', async ({ page }) => {
  await expect(page.locator('#codec-lenient')).toBeHidden();
  await expect(page.locator('#codec-upper')).toBeHidden();
  await expect(page.locator('#codec-replace')).toBeVisible();
  await page.selectOption('#codec-from', 'hex');
  await page.selectOption('#codec-to', 'base64');
  await expect(page.locator('#codec-lenient')).toBeVisible();
  await expect(page.locator('#codec-replace')).toBeHidden();
  await expect(page.locator('#codec-plus')).toBeHidden();
});

test('malformed Base64 is an error with its position, never a guess', async ({ page }) => {
  await page.selectOption('#codec-from', 'base64');
  await page.selectOption('#codec-to', 'text');
  await page.fill('#codec-input', 'SGVsbG8*d29ybGQ=');
  await expect(page.locator('#codec-status')).toContainText('The input could not be read');
  await expect(page.locator('#codec-error')).toContainText("'*' at position 8 is not a Base64 character");
  await expect(page.locator('#codec-output')).toHaveValue('');
  await expect(page.locator('#codec-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await page.locator('#codec-goto').click();
  expect(await page.locator('#codec-input').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([7, 8]);

  await page.fill('#codec-input', 'SGVsbG8');
  await expect(page.locator('#codec-error')).toContainText('Padding is missing');
  await page.fill('#codec-input', 'SGVs\nbG8=');
  await expect(page.locator('#codec-error')).toContainText('is not a Base64 character');
  await page.locator('#codec-lenient').check();
  await expect(page.locator('#codec-output')).toHaveValue('Hello');
  await page.fill('#codec-input', 'SGVsbG8-');
  await expect(page.locator('#codec-error')).toContainText('belongs to the Base64URL alphabet');
});

test('malformed hex and URL encoding are refused', async ({ page }) => {
  await page.selectOption('#codec-from', 'hex');
  await page.fill('#codec-input', '48656c6c6');
  await expect(page.locator('#codec-error')).toContainText('odd number of digits');
  await page.fill('#codec-input', '48 65 zz');
  await expect(page.locator('#codec-error')).toContainText('is not a hexadecimal digit');
  await page.locator('#codec-lenient').check();
  await page.fill('#codec-input', '0x48 65:6c-6c 6F');
  await page.selectOption('#codec-to', 'text');
  await expect(page.locator('#codec-output')).toHaveValue('Hello');
  await page.selectOption('#codec-from', 'url');
  await page.fill('#codec-input', '100%');
  await expect(page.locator('#codec-error')).toContainText('must be followed by two hexadecimal digits');
  await page.fill('#codec-input', 'a%zzb');
  await expect(page.locator('#codec-error')).toContainText('not "zz"');
});

test('invalid UTF-8 is not silently replaced: it stops unless replacement is chosen', async ({ page, context }) => {
  await grantClipboard(context);
  await page.selectOption('#codec-from', 'hex');
  await page.selectOption('#codec-to', 'text');
  await page.fill('#codec-input', '48656c6c6fff21');
  await expect(page.locator('#codec-status')).toContainText('The data cannot be written as text');
  await expect(page.locator('#codec-error')).toContainText('byte 6 (0xFF)');
  await expect(page.locator('#codec-output')).toHaveValue('');
  // The decoded bytes are still available as a binary download.
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download bytes' }).click()]);
  expect(file.suggestedFilename()).toBe('decoded.bin');
  const { readFile } = await import('node:fs/promises');
  expect([...(await readFile(await file.path()))]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0x21]);

  await page.locator('#codec-replace').check();
  await expect(page.locator('#codec-output')).toHaveValue(`Hello${REPLACEMENT}!`);
  await expect(page.locator('#codec-status .notice-warning')).toContainText('1 invalid sequence replaced with U+FFFD');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe(`Hello${REPLACEMENT}!`);
});

test('copies and downloads exactly the output; Example and Clear work', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('button', { name: 'Example' }).click();
  const value = await page.locator('#codec-output').inputValue();
  expect(Buffer.from(value, 'base64').toString('utf8')).toBe(await page.locator('#codec-input').inputValue());
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe(value);
  const file = await download(page, () => page.getByRole('button', { name: 'Download', exact: true }).click());
  expect(file).toEqual({ name: 'converted.base64.txt', text: value });
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#codec-input')).toHaveValue('');
  await expect(page.locator('#codec-output')).toHaveValue('');
  await expect(page.locator('#codec-status')).toBeEmpty();
});

test('oversized input is refused outright, not cut', async ({ page }) => {
  await page.locator('#codec-input').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'a'.repeat(8_000_001);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#codec-error')).toContainText('the limit is 8,000,000', { timeout: 15_000 });
  await expect(page.locator('#codec-output')).toHaveValue('');
});

test('a large conversion completes and round-trips', async ({ page }) => {
  const ms = await page.locator('#codec-input').evaluate(async (el: HTMLTextAreaElement) => {
    const started = performance.now();
    el.value = 'NetForge '.repeat(400_000);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 400));
    while ((document.getElementById('codec-output') as HTMLTextAreaElement).value === '') await new Promise(resolve => setTimeout(resolve, 20));
    return performance.now() - started;
  });
  expect(await page.locator('#codec-output').evaluate((el: HTMLTextAreaElement) => el.value.length)).toBe(4_800_000);
  expect(ms).toBeLessThan(10_000);
});
