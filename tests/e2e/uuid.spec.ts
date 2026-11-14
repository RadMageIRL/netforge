import { expect, test, type Page } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

async function lines(page: Page): Promise<string[]> {
  return (await page.locator('#token-output').inputValue()).split('\n');
}

test.beforeEach(async ({ page }) => {
  await openTool(page, 'uuid-tokens', 'UUID / Random Tokens');
});

test('generates version 4 UUIDs with the right version and variant bits', async ({ page }) => {
  const errors = watchErrors(page);
  await expect(page.locator('#token-output')).toHaveValue('');
  await page.fill('#token-count', '200');
  await page.locator('#token-generate').click();
  const values = await lines(page);
  expect(values).toHaveLength(200);
  for (const v of values) expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(new Set(values).size).toBe(200);
  await expect(page.locator('#token-status')).toContainText('Generated 200 values');
  await expect(page.locator('#token-status')).toContainText('36 characters each, 122 random bits each');
  await expect(page.locator('#token-note-list')).toContainText('A UUID is an identifier. If you need a secret');
  await expect(page.locator('#token-bytes')).toBeHidden();
  expect(errors).toEqual([]);
});

test('generates version 7 UUIDs that carry the current time and sort in creation order', async ({ page }) => {
  await page.selectOption('#token-kind', 'uuid-v7');
  await page.fill('#token-count', '1000');
  const before = Date.now();
  await page.locator('#token-generate').click();
  const values = await lines(page);
  const after = Date.now();
  expect(values).toHaveLength(1000);
  for (const v of values) expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect([...values].sort()).toEqual(values);
  expect(new Set(values).size).toBe(1000);
  const stamp = (v: string) => parseInt(v.replace(/-/g, '').slice(0, 12), 16);
  expect(stamp(values[0])).toBeGreaterThanOrEqual(before - 5);
  expect(stamp(values[999])).toBeLessThanOrEqual(after + 5);
  await expect(page.locator('#token-status')).toContainText('at least 62 random bits each');
  await expect(page.locator('#token-note-list')).toContainText('anyone who sees it can read that time');
  await expect(page.locator('#token-note-list')).toContainText('Do not use a version 7 UUID as a secret.');
});

test('generates hex and Base64URL tokens of the requested byte length', async ({ page }) => {
  await page.selectOption('#token-kind', 'hex');
  await expect(page.locator('#token-bytes')).toBeVisible();
  await page.fill('#token-bytes', '24');
  await page.fill('#token-count', '50');
  await page.locator('#token-generate').click();
  let values = await lines(page);
  expect(values).toHaveLength(50);
  for (const v of values) expect(v).toMatch(/^[0-9a-f]{48}$/);
  expect(new Set(values).size).toBe(50);
  await expect(page.locator('#token-status')).toContainText('48 characters each, 192 random bits each');

  await page.selectOption('#token-kind', 'base64url');
  await expect(page.locator('#token-output')).toHaveValue('');
  for (const [bytes, chars] of [[16, 22], [32, 43], [33, 44], [1, 2]] as const) {
    await page.fill('#token-bytes', String(bytes));
    await page.locator('#token-generate').click();
    values = await lines(page);
    for (const v of values) expect(v).toMatch(new RegExp(`^[A-Za-z0-9_-]{${chars}}$`));
    await expect(page.locator('#token-status')).toContainText(`${bytes * 8} random bits each`);
  }
  await expect(page.locator('#token-note-list')).toContainText('Fewer than 16 bytes (128 bits) is short for a secret');
  await expect(page.locator('#token-note-list')).toContainText('not how safe it is in use');
});

test('uses the secure generator and nothing else', async ({ page }) => {
  // Make Math.random useless and count calls to the secure generator.
  await page.evaluate(() => {
    const w = window as unknown as { nfSecureCalls: number; nfWeakCalls: number };
    w.nfSecureCalls = 0;
    w.nfWeakCalls = 0;
    const real = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = ((array: Uint8Array<ArrayBuffer>) => { w.nfSecureCalls++; return real(array); }) as typeof crypto.getRandomValues;
    Math.random = () => { w.nfWeakCalls++; return 0.5; };
  });
  for (const kind of ['uuid-v4', 'uuid-v7', 'hex', 'base64url']) {
    await page.selectOption('#token-kind', kind);
    await page.fill('#token-count', '10');
    await page.locator('#token-generate').click();
    expect(new Set(await lines(page)).size).toBe(10);
  }
  const calls = await page.evaluate(() => { const w = window as unknown as { nfSecureCalls: number; nfWeakCalls: number }; return [w.nfSecureCalls, w.nfWeakCalls]; });
  expect(calls[0]).toBe(40);
  expect(calls[1]).toBe(0);
});

test('validates the count and byte length, and generates in bulk within limits', async ({ page }) => {
  await page.fill('#token-count', '1001');
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-count-error')).toContainText('from 1 to 1,000');
  await expect(page.locator('#token-output')).toHaveValue('');
  await page.fill('#token-count', '0');
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-count-error')).toBeVisible();
  await page.fill('#token-count', 'ten');
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-count-error')).toBeVisible();
  await page.fill('#token-count', '1000');
  await page.selectOption('#token-kind', 'hex');
  await page.fill('#token-bytes', '1025');
  await page.locator('#token-generate').click();
  await expect(page.locator('#token-bytes-error')).toContainText('from 1 to 1,024');
  await page.fill('#token-bytes', '1024');
  await page.locator('#token-bytes').press('Enter');
  const values = await lines(page);
  expect(values).toHaveLength(1000);
  expect(values.every(v => v.length === 2048)).toBe(true);
});

test('copies and downloads the values; nothing survives a reload', async ({ page, context }) => {
  await grantClipboard(context);
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await page.fill('#token-count', '3');
  await page.locator('#token-generate').click();
  const text = await page.locator('#token-output').inputValue();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe(text);
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file).toEqual({ name: 'uuids.txt', text: `${text}\n` });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  for (const v of text.split('\n')) expect(stored).not.toContain(v);
  await page.reload();
  await expect(page.locator('#token-output')).toHaveValue('');
});
