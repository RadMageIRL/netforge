import { expect, test } from '@playwright/test';
import { openTool, watchErrors } from './helpers';

test.describe('navigation', () => {
  test('home lists every category and tool, with planned tools labeled', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('./');
    await expect(page).toHaveTitle('NetForge | Local-first IT and network engineering toolbox');
    await expect(page.getByRole('heading', { level: 1, name: 'NetForge' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Tools' });
    await expect(nav.locator('.nav-heading')).toHaveText(['Network', 'Scheduling', 'Data', 'Encoding', 'Text', 'Generators', 'Automation / DevOps']);
    await expect(nav.locator('a[data-tool]')).toHaveCount(19);
    await expect(nav.locator('a[data-tool].planned')).toHaveCount(16);
    await expect(nav.locator('a[data-tool]:not(.planned)')).toHaveText(['Subnet Calculator', 'Timestamp Converter', 'JSON Formatter']);
    await expect(page.locator('.tool-card')).toHaveCount(3);
    await expect(page.locator('#brand-version')).toHaveText('v0.1.0-dev');
    expect(errors).toEqual([]);
  });

  test('opening a tool updates the address, title, heading and current link', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('navigation', { name: 'Tools' }).getByRole('link', { name: 'JSON Formatter' }).click();
    await expect(page).toHaveURL(/#\/json-formatter$/);
    await expect(page).toHaveTitle('JSON Formatter | NetForge');
    await expect(page.getByRole('heading', { level: 1, name: 'JSON Formatter' })).toBeFocused();
    await expect(page.locator('a[data-tool="json-formatter"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('a[data-tool="subnet-calculator"]')).not.toHaveAttribute('aria-current', 'page');
  });

  test('a planned tool says it is not built and offers no controls', async ({ page }) => {
    await page.goto('./#/jwt-decoder');
    await expect(page.getByRole('heading', { level: 1, name: 'JWT Decoder' })).toBeVisible();
    await expect(page.locator('.planned-page')).toContainText('This tool is not built yet.');
    await expect(page.locator('.planned-page').locator('input, textarea, select')).toHaveCount(0);
    await expect(page).toHaveTitle('JWT Decoder (planned) | NetForge');
  });

  test('an unknown route shows a not-found page', async ({ page }) => {
    await page.goto('./#/no-such-tool');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.locator('.view')).toContainText('no-such-tool');
  });

  test('switching tools keeps work in memory but a reload starts clean', async ({ page }) => {
    await openTool(page, 'subnet-calculator', 'Subnet Calculator');
    await page.fill('#subnet-input', '10.1.2.3/16');
    await page.locator('a[data-tool="json-formatter"]').click();
    await page.fill('#json-input', '{"keep":true}');
    await page.locator('a[data-tool="subnet-calculator"]').click();
    await expect(page.locator('#subnet-input')).toHaveValue('10.1.2.3/16');
    await page.locator('a[data-tool="json-formatter"]').click();
    await expect(page.locator('#json-input')).toHaveValue('{"keep":true}');
    await page.reload();
    await expect(page.locator('#json-input')).toHaveValue('');
  });

  test('reopens the last tool used when the address has no route', async ({ page }) => {
    await openTool(page, 'timestamp-converter', 'Timestamp Converter');
    await page.goto('./');
    await expect(page).toHaveURL(/#\/timestamp-converter$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Timestamp Converter' })).toBeVisible();
    await page.goto('./#/');
    await expect(page.getByRole('heading', { level: 1, name: 'NetForge' })).toBeVisible();
  });
});

test.describe('search', () => {
  test('filters the tool list and opens the best match with Enter', async ({ page }) => {
    await page.goto('./');
    const search = page.getByRole('searchbox', { name: 'Search tools' });
    await search.fill('netmask');
    const visible = page.locator('#tool-nav a[data-tool]:visible');
    await expect(visible).toHaveText(['Subnet Calculator']);
    await expect(page.locator('#search-status')).toHaveText('1 tool found');
    await expect(page.locator('.nav-heading:visible')).toHaveText(['Network']);
    // "cidr" also matches the planned IP Range Analyzer; the built Subnet Calculator ranks first.
    await search.fill('cidr');
    await expect(page.locator('#search-status')).toHaveText('2 tools found');
    await search.press('Enter');
    await expect(page).toHaveURL(/#\/subnet-calculator$/);
  });

  test('says when nothing matches and Escape clears the search', async ({ page }) => {
    await page.goto('./');
    const search = page.getByRole('searchbox', { name: 'Search tools' });
    await search.fill('zzzz');
    await expect(page.locator('.nav-empty')).toHaveText('No tools match "zzzz".');
    await expect(page.locator('#tool-nav a[data-tool]:visible')).toHaveCount(0);
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('#tool-nav a[data-tool]:visible')).toHaveCount(19);
  });

  test('finds tools by keyword, including planned ones', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('epoch');
    await expect(page.locator('#tool-nav a[data-tool]:visible')).toHaveText(['Timestamp Converter']);
    await page.getByRole('searchbox', { name: 'Search tools' }).fill('vlan');
    await expect(page.locator('#tool-nav a[data-tool]:visible').first()).toContainText('NetForge Subnet & VLAN Planner');
  });
});

test.describe('keyboard', () => {
  test('slash focuses search, but not while typing in a field', async ({ page }) => {
    await openTool(page, 'subnet-calculator', 'Subnet Calculator');
    await page.locator('body').press('/');
    await expect(page.locator('#tool-search')).toBeFocused();
    await page.locator('#subnet-input').fill('10.0.0.0');
    await page.locator('#subnet-input').press('/');
    await expect(page.locator('#subnet-input')).toBeFocused();
    await expect(page.locator('#subnet-input')).toHaveValue('10.0.0.0/');
  });

  test('Ctrl+K focuses search from inside a text area', async ({ page }) => {
    await openTool(page, 'json-formatter', 'JSON Formatter');
    await page.locator('#json-input').click();
    await page.keyboard.press('Control+k');
    await expect(page.locator('#tool-search')).toBeFocused();
  });

  test('arrow keys move through the list and Enter opens a tool', async ({ page }) => {
    await page.goto('./');
    await page.locator('#tool-search').fill('json');
    await page.locator('#tool-search').press('ArrowDown');
    await expect(page.locator('#tool-nav a:visible').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/json-formatter$/);
    await page.locator('#tool-search').fill('');
    await page.locator('#tool-search').press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('a[data-tool="subnet-calculator"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#tool-search')).toBeFocused();
  });

  test('the skip link is the first stop and moves focus to the page heading', async ({ page }) => {
    await openTool(page, 'subnet-calculator', 'Subnet Calculator');
    await page.locator('body').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Subnet Calculator' })).toBeFocused();
    await expect(page).toHaveURL(/#\/subnet-calculator$/);
  });
});

test.describe('preferences', () => {
  test('the theme toggle switches themes and the choice survives a reload', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(245, 247, 249)');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
  });

  test('About lists what is stored and clearing restores the defaults', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await page.goto('./#/about');
    await expect(page.locator('#stored-prefs')).toContainText('Color theme');
    await expect(page.locator('#stored-prefs')).toContainText('light');
    await page.getByRole('button', { name: 'Clear preferences' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.about-page')).toContainText('Nothing is stored on this device.');
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });

  test('About explains privacy and shows the version', async ({ page }) => {
    await page.goto('./#/about');
    await expect(page.locator('.privacy-list li')).toHaveCount(4);
    await expect(page.locator('.about-page')).toContainText('never sent to a server');
    await expect(page.locator('.about-page')).toContainText('NetForge v0.1.0-dev');
  });
});
