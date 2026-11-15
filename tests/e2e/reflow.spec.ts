import { expect, test, type Page } from '@playwright/test';
import { watchErrors } from './helpers';

/**
 * Zoom. A 1280 px wide window zoomed to 200% lays out like a 640 px one, and at 400% like a 320 px
 * one, which is the width WCAG 1.4.10 (Reflow) names: content must stay usable without scrolling
 * in two directions. Wide data (tables, code, maps) may scroll inside its own box; the page may not.
 */
type Fill = (page: Page) => Promise<void>;

const example = async (page: Page) => { await page.getByRole('button', { name: 'Example', exact: true }).first().click(); };

const TOOLS: readonly [route: string, fill: Fill][] = [
  ['', async () => {}],
  ['#/about', async () => {}],
  ['#/subnet-calculator', async page => { await page.getByRole('radio', { name: 'IPv6' }).check(); await page.fill('#subnet-input', '2001:0db8:85a3:0000:0000:8a2e:0370:7334/127'); }],
  ['#/vlsm-allocator', async page => { await example(page); }],
  ['#/network-planner', async page => { await page.locator('#plan-example').click(); await expect(page.locator('#vlan-table tbody tr').first()).toBeVisible(); }],
  ['#/ip-range-analyzer', async page => { await example(page); }],
  ['#/route-summarization', async page => { await example(page); }],
  ['#/cron-explainer', async page => { await page.fill('#cron-input', '*/15 9-17 1,15 * 1-5'); await expect(page.locator('#cron-runs')).toBeVisible(); }],
  ['#/schedule-builder', async page => { await page.selectOption('#builder-frequency', 'minutes'); await expect(page.locator('#builder-text-powershell')).toBeVisible(); }],
  ['#/timestamp-converter', async page => { await page.fill('#timestamp-input', '2026-11-01 01:30'); }],
  ['#/json-formatter', async page => { await page.fill('#json-input', JSON.stringify({ key: 'v'.repeat(300), list: [1, 2, 3] })); }],
  ['#/yaml-xml-tools', async page => { await example(page); await expect(page.locator('#data-notes')).toBeVisible(); }],
  ['#/number-bases', async page => { await page.selectOption('#num-width', 'none'); await page.fill('#num-input', '9'.repeat(200)); await page.fill('#unit-amount', '1.5'); }],
  ['#/base64-url-hex', async page => { await page.fill('#codec-input', 'x'.repeat(500)); }],
  ['#/hash-hmac', async page => { await page.fill('#hash-text', 'abc'); await expect(page.locator('#hash-list')).toBeVisible(); }],
  ['#/jwt-decoder', async page => { await example(page); await page.locator('#jwt-verify').click(); await expect(page.locator('#jwt-verify-message')).toBeVisible(); }],
  ['#/regex-tester', async page => { await example(page); await expect(page.locator('#regex-matches')).toBeVisible(); }],
  ['#/text-tools', async page => { await example(page); }],
  ['#/uuid-tokens', async page => { await page.selectOption('#token-kind', 'hex'); await page.fill('#token-bytes', '64'); await page.locator('#token-generate').click(); }],
  ['#/chmod-calculator', async page => { await page.fill('#chmod-octal', '4755'); await page.fill('#chmod-path', '/a/long/path/with spaces/and/more/segments/to/wrap/file.sh'); }],
  ['#/powershell-generator', async page => { await page.locator('#ps-example').click(); await expect(page.locator('#ps-code-0')).toBeVisible(); }],
  ['#/terraform-export', async page => { await page.locator('#tf-example').click(); await page.getByRole('radio', { name: 'AWS VPC and subnets', exact: true }).check(); await expect(page.locator('#tf-code-0')).toBeVisible(); }],
  ['#/network-config-export', async page => { await page.locator('#nc-example').click(); await page.selectOption('#nc-site', { label: 'Headquarters' }); await page.selectOption('#nc-global-vrf', { label: 'Global' }); await expect(page.locator('#nc-code-0')).toContainText('interface Vlan10'); }],
];

async function check(page: Page, width: number): Promise<string[]> {
  const problems: string[] = [];
  for (const [route, fill] of TOOLS) {
    await page.goto(`./${route}`);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await fill(page);
    const state = await page.evaluate(() => {
      const root = document.documentElement;
      // Controls and text that end up wider than the window without a scroll box of their own.
      const wide: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('main input, main select, main textarea, main button, main h1, main h2, main p, main label')) {
        if (el.closest('[hidden]') || el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.width > root.clientWidth + 1 || r.right > root.clientWidth + 1 || r.left < -1) {
          let scroller: HTMLElement | null = el.parentElement;
          let inside = false;
          while (scroller && scroller !== document.body) {
            const o = getComputedStyle(scroller).overflowX;
            if ((o === 'auto' || o === 'scroll') && scroller.scrollWidth > scroller.clientWidth) { inside = true; break; }
            scroller = scroller.parentElement;
          }
          if (!inside) wide.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);
        }
      }
      return { scroll: root.scrollWidth, client: root.clientWidth, wide: wide.slice(0, 5) };
    });
    if (state.scroll > state.client) problems.push(`${route || 'home'} at ${width}px: page is ${state.scroll}px wide in a ${state.client}px window`);
    if (state.wide.length > 0) problems.push(`${route || 'home'} at ${width}px: clipped ${state.wide.join(', ')}`);
  }
  return problems;
}

test.describe('200% zoom (640 px layout)', () => {
  test.use({ viewport: { width: 640, height: 720 } });
  test('every page reflows without sideways scrolling', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    expect(await check(page, 640)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('400% zoom (320 px layout)', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test('every page reflows without sideways scrolling', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    expect(await check(page, 320)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the tool list still opens, and a tool can be chosen and used', async ({ page }) => {
    await page.goto('./');
    await page.locator('#nav-toggle').click();
    await page.locator('a[data-tool="chmod-calculator"]').click();
    await expect(page.getByRole('heading', { level: 1, name: 'chmod Calculator' })).toBeVisible();
    await page.fill('#chmod-octal', '640');
    await expect(page.locator('#chmod-ls')).toHaveValue('rw-r-----');
  });
});
