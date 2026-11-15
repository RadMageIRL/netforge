import { expect, test } from '@playwright/test';
import { BACKSLASH } from '../helpers';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

const B = BACKSLASH;

test.beforeEach(async ({ page }) => {
  await openTool(page, 'regex-tester', 'Regex Tester');
});

test('says plainly that this is the JavaScript engine', async ({ page }) => {
  await expect(page.locator('#regex-engine-note')).toContainText('JavaScript regular expressions.');
  await expect(page.locator('#regex-engine-note')).toContainText('This is not PCRE, .NET, Python, Java or RE2');
  await expect(page.locator('#regex-limits-note')).toContainText('stopped after 2 seconds');
});

test('highlights matches and lists numbered and named groups', async ({ page }) => {
  const errors = watchErrors(page);
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#regex-status')).toContainText('4 matches');
  await expect(page.locator('#regex-status')).toContainText('3 capture groups (named: year, month, day)');
  await expect(page.locator('#regex-highlight mark')).toHaveText(['2026-11-14', '2026-11-15', '2027-01-08', '2025-12-01']);
  const first = page.locator('#regex-matches tbody tr').first();
  await expect(first.locator('td').nth(1)).toHaveText('15');
  await expect(first.locator('td').nth(2)).toHaveText('25');
  await expect(first.locator('td').nth(3)).toHaveText('2026-11-14');
  await expect(first.locator('.group-list li')).toHaveText(['1 year2026', '2 month11', '3 day14']);
  expect(errors).toEqual([]);
});

test('flags change the result; without g only the first match is found', async ({ page }) => {
  await page.fill('#regex-text', 'Cat cat CAT');
  await page.fill('#regex-pattern', 'cat');
  await expect(page.locator('#regex-status')).toContainText('1 match');
  await page.locator('#regex-flag-i').check();
  await expect(page.locator('#regex-status')).toContainText('3 matches');
  await page.locator('#regex-flag-g').uncheck();
  await expect(page.locator('#regex-status')).toContainText('1 match');
  await expect(page.locator('#regex-global-note')).toHaveText('Without the g flag a pattern stops at its first match.');
  await expect(page.locator('#regex-highlight mark')).toHaveText(['Cat']);
  await page.locator('#regex-flag-g').check();
  await page.locator('#regex-flag-u').check();
  await page.locator('#regex-flag-v').check();
  await expect(page.locator('#regex-pattern-error')).toContainText('"u" and "v" cannot be used together');
});

test('reports syntax errors from the engine', async ({ page }) => {
  await page.fill('#regex-text', 'abc');
  await page.fill('#regex-pattern', '(a');
  await expect(page.locator('#regex-pattern-error')).toContainText('not a valid JavaScript regular expression');
  await expect(page.locator('#regex-pattern')).toHaveAttribute('aria-invalid', 'true');
  // Possessive quantifiers are PCRE syntax, not JavaScript.
  await page.fill('#regex-pattern', 'a++');
  await expect(page.locator('#regex-pattern-error')).toContainText('not a valid JavaScript regular expression');
  await page.fill('#regex-pattern', 'a+');
  await expect(page.locator('#regex-status')).toContainText('1 match');
});

test('handles zero-length matches without looping or skipping', async ({ page }) => {
  await page.fill('#regex-text', 'one two');
  await page.fill('#regex-pattern', `${B}b`);
  await expect(page.locator('#regex-status')).toContainText('4 matches');
  await expect(page.locator('#regex-status')).toContainText('4 zero-length matches');
  await expect(page.locator('#regex-matches tbody tr td:nth-child(2)')).toHaveText(['0', '3', '4', '7']);
  await expect(page.locator('#regex-highlight mark.match-empty')).toHaveCount(4);
  await expect(page.locator('#regex-highlight')).toHaveText('one two');
  // An empty alternative matches at every position, between characters and at both ends.
  await page.fill('#regex-text', 'ab');
  await page.fill('#regex-pattern', 'x*');
  await expect(page.locator('#regex-status')).toContainText('3 matches');
  // With u, a position inside a surrogate pair is not a match position.
  await page.fill('#regex-text', `a${String.fromCodePoint(0x1f680)}`);
  await expect(page.locator('#regex-status')).toContainText('4 matches');
  await page.locator('#regex-flag-u').check();
  await expect(page.locator('#regex-status')).toContainText('3 matches');
});

test('shows groups that did not take part', async ({ page }) => {
  await page.fill('#regex-text', 'ab');
  await page.fill('#regex-pattern', '(a)|(b)');
  await expect(page.locator('#regex-matches tbody tr').first().locator('.group-list li')).toHaveText(['1a', '2did not take part']);
  await expect(page.locator('#regex-matches tbody tr').nth(1).locator('.group-list li')).toHaveText(['1did not take part', '2b']);
});

test('previews a replacement with group references', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#regex-replaced')).toHaveCount(0);
  await page.locator('#regex-replace-on').check();
  await expect(page.locator('#regex-replaced')).toHaveText('Backups ran on 14/11/2026 and 15/11/2026.\nThe next audit is 08/01/2027; the last was 01/12/2025.');
  await page.fill('#regex-replacement', '[$&|$1|$$]');
  await expect(page.locator('#regex-replaced')).toContainText('Backups ran on [2026-11-14|2026|$] and');
  await page.getByRole('button', { name: 'Copy result' }).click();
  expect(await readClipboard(page)).toContain('[2025-12-01|2025|$].');
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file.name).toBe('replaced.txt');
  expect(file.text).toContain('[2027-01-08|2027|$]');
  // An empty replacement deletes the matches.
  await page.fill('#regex-replacement', '');
  await expect(page.locator('#regex-replaced')).toHaveText('Backups ran on  and .\nThe next audit is ; the last was .');
});

test('copies matches as lines and as JSON', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('button', { name: 'Example' }).click();
  await page.getByRole('button', { name: 'Copy matches' }).click();
  expect(await readClipboard(page)).toBe('2026-11-14\n2026-11-15\n2027-01-08\n2025-12-01');
  await page.getByRole('button', { name: 'Copy as JSON' }).click();
  const json = JSON.parse(await readClipboard(page));
  expect(json.total).toBe(4);
  expect(json.flags).toBe('g');
  expect(json.matches[2]).toMatchObject({ start: 60, end: 70, value: { text: '2027-01-08', length: 10 } });
  expect(json.matches[2].groups[1]).toMatchObject({ number: 2, name: 'month', value: { text: '01', length: 2 } });
});

test('a catastrophic pattern is stopped by terminating its worker, and the page never freezes', async ({ page, browserName }) => {
  // JavaScriptCore answers this pattern at once (no runaway backtracking), so there is nothing to stop.
  test.skip(browserName === 'webkit', 'this pattern does not run away in WebKit');
  const errors = watchErrors(page);
  // Count timer ticks on the page thread while the pattern runs: a blocked page would stop ticking.
  await page.evaluate(() => {
    const w = window as unknown as { nfTicks: number[] };
    w.nfTicks = [];
    setInterval(() => w.nfTicks.push(performance.now()), 50);
  });
  await page.fill('#regex-text', `${'a'.repeat(40)}!`);
  const started = Date.now();
  await page.fill('#regex-pattern', '(a+)+$');
  await expect(page.locator('#regex-error')).toHaveAttribute('data-outcome', 'timeout', { timeout: 10_000 });
  const elapsed = Date.now() - started;
  await expect(page.locator('#regex-error')).toContainText('Stopped after 2 seconds');
  await expect(page.locator('#regex-error')).toContainText('terminated and replaced');
  // A real limit: about two seconds (plus the typing delay), not whenever the pattern finishes.
  expect(elapsed).toBeGreaterThan(1900);
  expect(elapsed).toBeLessThan(6000);
  const ticks = await page.evaluate(() => (window as unknown as { nfTicks: number[] }).nfTicks);
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
  expect(ticks.length).toBeGreaterThan(20);
  expect(Math.max(...gaps)).toBeLessThan(700);

  // The replacement worker is ready: a normal pattern runs at once.
  await page.fill('#regex-pattern', 'a{3}');
  await expect(page.locator('#regex-status')).toContainText('13 matches');
  await expect(page.locator('#regex-error')).toHaveCount(0);
  // And a second runaway pattern is stopped again.
  await page.fill('#regex-pattern', '(a|a)*$');
  await page.fill('#regex-text', `${'a'.repeat(60)}!`);
  await expect(page.locator('#regex-error')).toHaveAttribute('data-outcome', 'timeout', { timeout: 10_000 });
  await page.fill('#regex-pattern', '!');
  await expect(page.locator('#regex-status')).toContainText('1 match');
  expect(errors).toEqual([]);
});

test('typing a new pattern cancels a run that is still going', async ({ page }) => {
  await page.fill('#regex-text', `${'a'.repeat(40)}!`);
  await page.fill('#regex-pattern', '(a+)+$');
  await page.waitForTimeout(600);
  const started = Date.now();
  await page.fill('#regex-pattern', 'a+');
  await expect(page.locator('#regex-status')).toContainText('1 match');
  expect(Date.now() - started).toBeLessThan(1500);
  await expect(page.locator('#regex-error')).toHaveCount(0);
});

test('bounds the output: every match is counted, details and highlighting are limited and say so', async ({ page }) => {
  await page.locator('#regex-text').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'ab '.repeat(100_000);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.fill('#regex-pattern', '(a)(b)');
  await expect(page.locator('#regex-status')).toContainText('100,000 matches', { timeout: 15_000 });
  await expect(page.locator('#regex-limits')).toContainText('Details are listed for the first 2,000 matches.');
  await expect(page.locator('#regex-limits')).toContainText('The table shows the first 500 matches.');
  await expect(page.locator('#regex-limits')).toContainText('Highlighting covers the first 200,000 characters');
  await expect(page.locator('#regex-matches tbody tr')).toHaveCount(500);
  expect(await page.locator('#regex-highlight mark').count()).toBeLessThanOrEqual(5000);
  expect(await page.locator('#regex-highlight').evaluate(el => el.textContent!.length)).toBe(200_000);
});

test('refuses text over the limit', async ({ page }) => {
  await page.locator('#regex-text').evaluate((el: HTMLTextAreaElement) => {
    el.value = 'a'.repeat(1_000_001);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.fill('#regex-pattern', 'a');
  await expect(page.locator('#regex-error')).toContainText('the limit is 1,000,000', { timeout: 15_000 });
});
