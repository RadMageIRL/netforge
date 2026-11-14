import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function scan(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.target.join(' ')).join(', ')})`);
}

const STATES: [string, (page: Page) => Promise<void>][] = [
  ['home', async page => { await page.goto('./'); }],
  ['subnet result', async page => { await page.goto('./#/subnet-calculator'); await page.fill('#subnet-input', '203.0.113.9/31'); }],
  ['subnet error', async page => { await page.goto('./#/subnet-calculator'); await page.fill('#subnet-input', '10.0.0.1'); }],
  ['json result', async page => { await page.goto('./#/json-formatter'); await page.fill('#json-input', '{"a":1,"a":2}'); }],
  ['json error', async page => { await page.goto('./#/json-formatter'); await page.fill('#json-input', '{"a":}'); }],
  ['timestamp overlap', async page => { await page.goto('./#/timestamp-converter'); await page.fill('#timestamp-input', '2026-11-01 01:30'); }],
  ['timestamp gap', async page => { await page.goto('./#/timestamp-converter'); await page.fill('#timestamp-input', '2026-03-08 02:30'); }],
  ['about', async page => { await page.goto('./#/about'); }],
  ['planned tool', async page => { await page.goto('./#/regex-tester'); }],
  ['search with no match', async page => { await page.goto('./'); await page.fill('#tool-search', 'zzzz'); }],
  // Phase 1
  ['subnet IPv6 with split and supernet open', async page => {
    await page.goto('./#/subnet-calculator');
    await page.getByRole('radio', { name: 'IPv6' }).check();
    await page.fill('#subnet-input', '2001:db8::/48');
    await page.locator('#split-panel summary').click();
    await page.locator('#supernet-panel summary').click();
  }],
  ['subnet classification with registry tables', async page => { await page.goto('./#/subnet-calculator'); await page.fill('#subnet-input', '192.0.0.9/23'); }],
  ['subnet family error', async page => { await page.goto('./#/subnet-calculator'); await page.fill('#subnet-input', '2001:db8::/32'); }],
  ['VLSM example', async page => { await page.goto('./#/vlsm-allocator'); await page.getByRole('button', { name: 'Example' }).click(); }],
  ['VLSM row errors', async page => {
    await page.goto('./#/vlsm-allocator');
    await page.fill('#vlsm-parent', '10.0.0.0/24');
    await page.getByLabel('Name, request 1', { exact: true }).fill('A');
    await page.getByLabel('Hosts, request 1', { exact: true }).fill('x');
  }],
  ['VLSM failure', async page => {
    await page.goto('./#/vlsm-allocator');
    await page.fill('#vlsm-parent', '10.0.0.0/30');
    await page.getByLabel('Name, request 1', { exact: true }).fill('A');
    await page.getByLabel('Hosts, request 1', { exact: true }).fill('100');
  }],
  ['range analyzer example', async page => { await page.goto('./#/ip-range-analyzer'); await page.getByRole('button', { name: 'Example' }).click(); }],
  ['range analyzer line errors', async page => { await page.goto('./#/ip-range-analyzer'); await page.fill('#ranges-input', '10.0.0.0/8\nbad'); }],
  ['route summarization example', async page => { await page.goto('./#/route-summarization'); await page.getByRole('button', { name: 'Example' }).click(); }],
];

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(t => localStorage.setItem('netforge.theme', t), theme);
    });

    for (const [name, setup] of STATES) {
      test(`no accessibility violations: ${name}`, async ({ page }) => {
        await setup(page);
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await scan(page)).toEqual([]);
      });
    }
  });
}
