import { createHash, createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

const value = (page: Page, key: string) => page.locator(`#hash-list [data-key="${key}"] .hash-value`);

test.beforeEach(async ({ page }) => {
  await openTool(page, 'hash-hmac', 'Hash / HMAC');
});

test('hashes text with every algorithm, in hex and Base64', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#hash-text', 'abc');
  await expect(value(page, 'SHA-256-hex')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await expect(value(page, 'SHA-256-base64')).toHaveText('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  await expect(value(page, 'SHA-384-hex')).toHaveText('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
  await expect(value(page, 'SHA-512-hex')).toHaveText('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  await expect(value(page, 'SHA-1-hex')).toHaveText('a9993e364706816aba3e25717850c26c9cd0d89d');
  await expect(value(page, 'MD5-hex')).toHaveText('900150983cd24fb0d6963f7d28e17f72');
  await expect(value(page, 'MD5-base64')).toHaveText('kAFQmDzST7DWlj99KOF/cg==');
  await expect(page.locator('#hash-status')).toContainText('Hashed');
  await expect(page.locator('#hash-status')).toContainText('3 bytes');
  expect(errors).toEqual([]);
});

test('labels SHA-1 and MD5 as legacy and says what MD5 is not for', async ({ page }) => {
  await page.fill('#hash-text', 'x');
  await expect(page.locator('#hash-list [data-key="SHA-1"] .hash-legacy')).toHaveText('Legacy');
  await expect(page.locator('#hash-list [data-key="MD5"] .hash-legacy')).toHaveText('Legacy');
  await expect(page.locator('#hash-list [data-key="SHA-256"] .hash-legacy')).toHaveCount(0);
  await expect(page.locator('#hash-cautions')).toContainText('MD5: Legacy and broken. Not suitable for anything security-sensitive');
  await expect(page.locator('#hash-cautions')).toContainText('SHA-1: Legacy.');
});

test('hashes Unicode text as UTF-8 and keeps a trailing line break', async ({ page }) => {
  const text = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f680)}\n`;
  await page.fill('#hash-text', text);
  await expect(value(page, 'SHA-256-hex')).toHaveText(createHash('sha256').update(text, 'utf8').digest('hex'));
  await expect(value(page, 'MD5-hex')).toHaveText(createHash('md5').update(text, 'utf8').digest('hex'));
  await expect(page.locator('#hash-status')).toContainText('11 bytes');
});

test('computes HMAC with text, hex and Base64 keys', async ({ page }) => {
  await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
  await expect(page.locator('#hash-key-row')).toBeVisible();
  await page.fill('#hash-key', 'key');
  await page.fill('#hash-text', 'The quick brown fox jumps over the lazy dog');
  await expect(value(page, 'HMAC-SHA256-hex')).toHaveText('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  await expect(value(page, 'HMAC-SHA384-hex')).toHaveText(createHmac('sha384', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'));
  await expect(value(page, 'HMAC-SHA512-base64')).toHaveText(createHmac('sha512', 'key').update('The quick brown fox jumps over the lazy dog').digest('base64'));
  await expect(page.locator('#hash-list [data-key="MD5"]')).toHaveCount(0);

  await page.getByRole('radio', { name: 'Hex', exact: true }).check();
  await page.fill('#hash-key', '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
  await page.fill('#hash-text', 'Hi There');
  // RFC 4231 test case 1.
  await expect(value(page, 'HMAC-SHA256-hex')).toHaveText('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  await page.fill('#hash-key', '0b0b0');
  await expect(page.locator('#hash-key-error')).toContainText('not valid hexadecimal');
  await expect(page.locator('#hash-list')).toHaveCount(0);
  await page.getByRole('radio', { name: 'Base64', exact: true }).check();
  await page.fill('#hash-key', 'CwsLCwsLCwsLCwsLCwsLCwsLCws=');
  await expect(value(page, 'HMAC-SHA256-hex')).toHaveText('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});

test('hashes a file on the device and matches an independent implementation', async ({ page }) => {
  const data = Buffer.alloc(20 * 1024 * 1024 + 7);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
  await page.getByRole('radio', { name: 'File', exact: true }).check();
  await page.setInputFiles('#hash-file', { name: 'sample.bin', mimeType: 'application/octet-stream', buffer: data });
  await expect(value(page, 'SHA-256-hex')).toHaveText(createHash('sha256').update(data).digest('hex'), { timeout: 30_000 });
  await expect(value(page, 'MD5-hex')).toHaveText(createHash('md5').update(data).digest('hex'));
  await expect(value(page, 'SHA-512-hex')).toHaveText(createHash('sha512').update(data).digest('hex'));
  await expect(value(page, 'SHA-1-hex')).toHaveText(createHash('sha1').update(data).digest('hex'));
  await expect(page.locator('#hash-status')).toContainText('sample.bin, 20,971,527 bytes');
  // An empty file is a valid input.
  await page.setInputFiles('#hash-file', { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(value(page, 'MD5-hex')).toHaveText('d41d8cd98f00b204e9800998ecf8427e');
  await expect(value(page, 'SHA-256-hex')).toHaveText('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('refuses a file over the limit instead of freezing', async ({ page }) => {
  await page.getByRole('radio', { name: 'File', exact: true }).check();
  // A file object that reports a huge size without holding the bytes.
  await page.evaluate(() => {
    const input = document.getElementById('hash-file') as HTMLInputElement;
    const big = new File(['x'], 'huge.iso');
    Object.defineProperty(big, 'size', { value: 600 * 1024 * 1024 });
    Object.defineProperty(input, 'files', { value: [big], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#hash-error')).toContainText('huge.iso is 629,145,600 bytes');
  await expect(page.locator('#hash-error')).toContainText('Nothing was hashed');
  await expect(page.locator('#hash-list')).toHaveCount(0);
});

test('compares with a published checksum', async ({ page }) => {
  await page.fill('#hash-text', 'abc');
  await expect(value(page, 'MD5-hex')).toBeVisible();
  await page.fill('#hash-expected', '  BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD ');
  await expect(page.locator('#hash-compare .notice-ok')).toContainText('equals the SHA-256 digest (hex)');
  await page.fill('#hash-expected', '900150983cd24fb0d6963f7d28e17f72');
  await expect(page.locator('#hash-compare .notice-ok')).toContainText('MD5 is a legacy algorithm');
  await page.fill('#hash-expected', '900150983cd24fb0d6963f7d28e17f73');
  await expect(page.locator('#hash-compare .notice-error')).toContainText('No match');
});

test('copies a digest, and Clear removes text and key', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
  await page.fill('#hash-key', 'nf-secret-key');
  await page.fill('#hash-text', 'abc');
  await page.getByRole('button', { name: 'Copy HMAC-SHA256 Hex' }).click();
  expect(await readClipboard(page)).toBe(createHmac('sha256', 'nf-secret-key').update('abc').digest('hex'));
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#hash-key')).toHaveValue('');
  await expect(page.locator('#hash-text')).toHaveValue('');
  await expect(page.locator('#hash-list')).toHaveCount(0);
});

test('the key and text are gone after a reload', async ({ page }) => {
  await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
  await page.fill('#hash-key', 'nf-secret-key');
  await page.fill('#hash-text', 'nf-secret-text');
  await expect(value(page, 'HMAC-SHA256-hex')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Hash / HMAC' })).toBeVisible();
  await expect(page.locator('#hash-text')).toHaveValue('');
  await expect(page.locator('#hash-key')).toHaveValue('');
  await expect(page.getByRole('radio', { name: 'Hash', exact: true })).toBeChecked();
});
