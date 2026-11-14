import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await openTool(page, 'json-formatter', 'JSON Formatter');
});

test('pretty-prints as you type, keeping numbers exactly as written', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#json-input', '{"id":12345678901234567890,"ratio":1.0,"tags":["a"],"none":{}}');
  await expect(page.locator('#json-output')).toHaveValue('{\n  "id": 12345678901234567890,\n  "ratio": 1.0,\n  "tags": [\n    "a"\n  ],\n  "none": {}\n}');
  await expect(page.locator('.status-ok')).toContainText('Valid JSON');
  await expect(page.locator('.status-ok')).toContainText('object, 6 values, depth 2');
  await expect(page.locator('#json-status .notice-warning')).toContainText('12345678901234567890 is larger than 9007199254740991');
  expect(errors).toEqual([]);
});

test('minifies, and switches indentation', async ({ page }) => {
  await page.fill('#json-input', '{ "a" : [ 1 , 2 ] }');
  await page.getByRole('radio', { name: 'Minified' }).check();
  await expect(page.locator('#json-output')).toHaveValue('{"a":[1,2]}');
  await expect(page.getByRole('radio', { name: '4 spaces' })).toBeHidden();
  await page.getByRole('radio', { name: 'Pretty' }).check();
  await page.getByRole('radio', { name: '4 spaces' }).check();
  await expect(page.locator('#json-output')).toHaveValue('{\n    "a": [\n        1,\n        2\n    ]\n}');
  await page.getByRole('radio', { name: 'Tab' }).check();
  await expect(page.locator('#json-output')).toHaveValue('{\n\t"a": [\n\t\t1,\n\t\t2\n\t]\n}');
});

test('remembers the indentation choice but never the input', async ({ page }) => {
  await page.getByRole('radio', { name: '4 spaces' }).check();
  await page.fill('#json-input', '{"secret":"value"}');
  await page.reload();
  await expect(page.locator('#json-input')).toHaveValue('');
  await expect(page.locator('input[value="4"]')).toBeChecked();
});

test('reports errors with line and column, and jumps to them', async ({ page }) => {
  await page.fill('#json-input', '{\n  "a": 1,\n  "b": [1, 2,],\n}');
  await expect(page.locator('.status-error')).toContainText('Invalid JSON');
  await expect(page.locator('#json-status .notice-error')).toContainText("Line 3, column 13: Trailing comma: JSON does not allow a comma before ']'.");
  await expect(page.locator('#json-output')).toHaveValue('');
  await expect(page.locator('#json-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Copy' })).toBeDisabled();
  await page.getByRole('button', { name: 'Go to error' }).click();
  await expect(page.locator('#json-input')).toBeFocused();
  expect(await page.locator('#json-input').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([24, 25]);
});

test('warns about duplicate names and keeps them', async ({ page }) => {
  await page.fill('#json-input', '{"a":1,"a":2}');
  await expect(page.locator('#json-status .notice-warning')).toContainText('Duplicate property name "a" in $');
  await expect(page.locator('#json-output')).toHaveValue('{\n  "a": 1,\n  "a": 2\n}');
});

test('Clear empties both panes and Example loads valid JSON', async ({ page }) => {
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('.status-ok')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#json-input')).toHaveValue('');
  await expect(page.locator('#json-output')).toHaveValue('');
  await expect(page.locator('#json-status')).toBeEmpty();
});

test('copies and downloads exactly the output', async ({ page, context }) => {
  await grantClipboard(context);
  await page.fill('#json-input', '[1.50,"x"]');
  await page.getByRole('button', { name: 'Copy' }).click();
  expect(await readClipboard(page)).toBe('[\n  1.50,\n  "x"\n]');
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file).toEqual({ name: 'formatted.json', text: '[\n  1.50,\n  "x"\n]' });
  await page.getByRole('radio', { name: 'Minified' }).check();
  const minified = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(minified).toEqual({ name: 'minified.json', text: '[1.50,"x"]' });
});
