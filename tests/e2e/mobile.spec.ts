import { expect, test, type Page } from '@playwright/test';
import { resultValue, watchErrors } from './helpers';

// Runs in the "mobile" project (Pixel 7, 412 px wide).

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test('no page scrolls sideways at phone width', async ({ page }) => {
  const errors = watchErrors(page);
  for (const route of ['', '#/subnet-calculator', '#/json-formatter', '#/timestamp-converter', '#/about', '#/cron-explainer']) {
    await page.goto(`./${route}`);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expectNoHorizontalScroll(page);
  }
  // With long content too.
  await page.goto('./#/subnet-calculator');
  await page.fill('#subnet-input', '0.0.0.0/0');
  await expectNoHorizontalScroll(page);
  await page.goto('./#/timestamp-converter');
  await page.fill('#timestamp-input', '2026-11-01 01:30');
  await expectNoHorizontalScroll(page);
  await page.goto('./#/json-formatter');
  await page.fill('#json-input', JSON.stringify({ long: 'x'.repeat(400), list: Array.from({ length: 50 }, (_, i) => i) }));
  await expectNoHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('the tool list is a drawer: hidden until opened, closed by Escape', async ({ page }) => {
  await page.goto('./');
  const toggle = page.locator('#nav-toggle');
  const sidebar = page.locator('#sidebar');
  await expect(toggle).toBeVisible();
  await expect(sidebar).toBeHidden();
  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAccessibleName('Close tool navigation');
  await expect(page.locator('#tool-search')).toBeFocused();
  expect(await page.locator('#main').evaluate(el => (el as HTMLElement).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  expect(await page.locator('#main').evaluate(el => (el as HTMLElement).inert)).toBe(false);
});

test('choosing a tool in the drawer closes it and opens the tool', async ({ page }) => {
  await page.goto('./');
  await page.locator('#nav-toggle').click();
  await page.locator('#tool-search').fill('subnet');
  await page.locator('a[data-tool="subnet-calculator"]').click();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Subnet Calculator' })).toBeVisible();
  await page.fill('#subnet-input', '10.40.0.0/16');
  await expect(resultValue(page, 'usable')).toHaveText('65,534');
});

test('tapping outside the drawer closes it', async ({ page }) => {
  await page.goto('./');
  await page.locator('#nav-toggle').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#scrim').click({ position: { x: 395, y: 400 } });
  await expect(page.locator('#sidebar')).toBeHidden();
});

test('the JSON panes stack vertically', async ({ page }) => {
  await page.goto('./#/json-formatter');
  const input = await page.locator('#json-input').boundingBox();
  const output = await page.locator('#json-output').boundingBox();
  expect(input && output && output.y > input.y + input.height).toBe(true);
});
