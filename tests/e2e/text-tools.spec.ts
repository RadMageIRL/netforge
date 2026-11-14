import { expect, test } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

test.beforeEach(async ({ page }) => {
  await openTool(page, 'text-tools', 'List / Text Tools');
});

test('with no operation selected the result is the input, untouched', async ({ page }) => {
  const errors = watchErrors(page);
  const text = '  b  \r\nA\n\nb\ta\n';
  await page.locator('#text-input').evaluate((el: HTMLTextAreaElement, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  // A textarea normalizes line breaks to LF on its own; the tool adds no change of its own.
  const shown = await page.locator('#text-input').inputValue();
  await expect(page.locator('#text-output')).toHaveValue(shown);
  await expect(page.locator('#text-status')).toContainText('No operation selected');
  await expect(page.locator('#text-status')).toContainText('The result is the input, unchanged.');
  await expect(page.locator('#text-input')).toHaveValue(shown);
  expect(errors).toEqual([]);
});

test('applies each operation, in the stated order, and lists what it did', async ({ page }) => {
  await page.getByRole('button', { name: 'Example' }).click();
  await page.selectOption('#text-trim', 'both');
  await expect(page.locator('#text-output')).toHaveValue('server10\nserver2\nServer2\n\nserver1\nserver10\ngateway\n');
  await page.locator('#text-remove-empty').check();
  await expect(page.locator('#text-output')).toHaveValue('server10\nserver2\nServer2\nserver1\nserver10\ngateway\n');
  await page.locator('#text-dedupe').check();
  await expect(page.locator('#text-output')).toHaveValue('server10\nserver2\nServer2\nserver1\ngateway\n');
  await page.locator('#text-ignore-case').check();
  await expect(page.locator('#text-output')).toHaveValue('server10\nserver2\nserver1\ngateway\n');
  await page.selectOption('#text-sort', 'text');
  await expect(page.locator('#text-output')).toHaveValue('gateway\nserver1\nserver10\nserver2\n');
  await page.selectOption('#text-sort', 'natural');
  await expect(page.locator('#text-output')).toHaveValue('gateway\nserver1\nserver2\nserver10\n');
  await page.locator('#text-descending').check();
  await expect(page.locator('#text-output')).toHaveValue('server10\nserver2\nserver1\ngateway\n');
  await page.locator('#text-descending').uncheck();
  await page.selectOption('#text-case', 'upper');
  await page.fill('#text-prefix', '- ');
  await page.fill('#text-suffix', ';');
  await expect(page.locator('#text-output')).toHaveValue('- GATEWAY;\n- SERVER1;\n- SERVER2;\n- SERVER10;\n');
  await page.locator('#text-number').check();
  await expect(page.locator('#text-output')).toHaveValue('1. - GATEWAY;\n2. - SERVER1;\n3. - SERVER2;\n4. - SERVER10;\n');
  await page.fill('#text-number-start', '8');
  await page.fill('#text-number-separator', ') ');
  await page.locator('#text-number-pad').check();
  await expect(page.locator('#text-output')).toHaveValue('08) - GATEWAY;\n09) - SERVER1;\n10) - SERVER2;\n11) - SERVER10;\n');
  await expect(page.locator('#text-steps li')).toHaveText([
    'Trimmed whitespace from both ends of each line', 'Removed 1 empty line', 'Changed to uppercase',
    'Removed 2 duplicate lines, ignoring case (the first of each is kept)', 'Sorted in natural order (numbers by value), ascending, ignoring case',
    'Added the prefix and suffix', 'Numbered the lines from 8',
  ]);
  await expect(page.locator('#text-status')).toContainText('7 lines in, 4 lines out');
  // The input itself was never changed.
  await expect(page.locator('#text-input')).toHaveValue('server10\nserver2\n  Server2\n\nserver1\nserver10\ngateway\n');
});

test('case-sensitive and case-insensitive comparison differ as described', async ({ page }) => {
  await page.fill('#text-input', 'b\nB\na\nA\nb');
  await page.locator('#text-dedupe').check();
  await expect(page.locator('#text-output')).toHaveValue('b\nB\na\nA');
  await page.selectOption('#text-sort', 'text');
  await expect(page.locator('#text-output')).toHaveValue('A\nB\na\nb');
  await page.locator('#text-ignore-case').check();
  await expect(page.locator('#text-output')).toHaveValue('a\nb');
});

test('shows statistics for the input, counting Unicode characters correctly', async ({ page }) => {
  await expect(page.locator('#text-stats-empty')).toBeVisible();
  await page.fill('#text-input', `one two\n\ncaf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f680)}\n`);
  const cell = (label: string) => page.locator('#text-stats tr', { hasText: label }).locator('td');
  await expect(cell('Lines')).toHaveText(['3', '1', '3']);
  await expect(cell('Words')).toHaveText('4');
  await expect(cell('Characters (code points)')).toHaveText('16');
  await expect(cell('UTF-8 bytes')).toHaveText('20');
  await expect(cell('UTF-16 units')).toHaveText('17');
  await expect(cell('Longest line')).toHaveText('7');
  await expect(page.locator('#text-stats-empty')).toBeHidden();
});

test('compares two lists: intersection, both differences and union', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('tab', { name: 'Compare lists' }).click();
  await page.fill('#compare-a', 'alpha\nbravo \ncharlie\nbravo\n\n');
  await page.fill('#compare-b', 'Bravo\ncharlie\ndelta');
  await expect(page.locator('#compare-output')).toHaveValue('charlie');
  await expect(page.locator('#compare-repeats')).toHaveText('1 repeated line counted once (1 in A, 0 in B).');
  await page.selectOption('#compare-view', 'onlyA');
  await expect(page.locator('#compare-output')).toHaveValue('alpha\nbravo');
  await page.selectOption('#compare-view', 'onlyB');
  await expect(page.locator('#compare-output')).toHaveValue('Bravo\ndelta');
  await page.locator('#compare-ignore-case').check();
  await expect(page.locator('#compare-output')).toHaveValue('delta');
  await page.selectOption('#compare-view', 'union');
  await expect(page.locator('#compare-output')).toHaveValue('alpha\nbravo\ncharlie\ndelta');
  await page.selectOption('#compare-view', 'both');
  await expect(page.locator('#compare-output')).toHaveValue('bravo\ncharlie');
  const cell = (label: string) => page.locator('#compare-status tr', { hasText: label }).locator('td');
  await expect(cell('Distinct items in A')).toHaveText('3');
  await expect(cell('Only in B')).toHaveText('1');
  // Without trimming, "bravo " and "bravo" are different items.
  await page.locator('#compare-trim').uncheck();
  await expect(cell('Distinct items in A')).toHaveText('4');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe('charlie\nbravo');
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file).toEqual({ name: 'in-both.txt', text: 'charlie\nbravo\n' });
});

test('copies and downloads the transformed text', async ({ page, context }) => {
  await grantClipboard(context);
  await page.fill('#text-input', 'b\na');
  await page.selectOption('#text-sort', 'text');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe('a\nb');
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file).toEqual({ name: 'lines.txt', text: 'a\nb' });
});

test('refuses text over the limits, and stays responsive near them', async ({ page }) => {
  const set = (value: string) => page.locator('#text-input').evaluate((el: HTMLTextAreaElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.locator('#text-dedupe').check();
  await page.selectOption('#text-sort', 'natural');
  const lines = Array.from({ length: 200_000 }, (_, i) => `host-${(i * 7919) % 150_000}`).join('\n');
  const started = Date.now();
  await set(lines);
  await expect(page.locator('#text-status')).toContainText('200,000 lines in, 150,000 lines out', { timeout: 20_000 });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect((await page.locator('#text-output').inputValue()).startsWith('host-0\nhost-1\nhost-2\n')).toBe(true);
  await set(`${lines}\nextra`);
  await expect(page.locator('#text-error')).toContainText('the limit is 200,000', { timeout: 20_000 });
  await expect(page.locator('#text-output')).toHaveValue('');
});
