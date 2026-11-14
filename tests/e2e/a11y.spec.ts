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
  // Phase 2
  ['planner example', async page => { await page.goto('./#/network-planner'); await page.locator('#plan-example').click(); }],
  ['planner editor with errors and warnings', async page => {
    await page.goto('./#/network-planner');
    await page.locator('#plan-example').click();
    await page.locator('#vlan-table tr[data-vlan="v2"] button').click();
    await page.fill('#vlan-edit-vlanid', '10');
    await page.fill('#vlan-edit-gateway4', '10.10.20.255');
    await page.fill('#vlan-edit-ipv6', '2001:db8:10:20::/80');
    await expect(page.locator('#vlan-edit-ipv6-warning')).toBeVisible();
  }],
  ['planner sites, VRFs and namespaces with editors open', async page => {
    await page.goto('./#/network-planner');
    await page.locator('#plan-example').click();
    await page.getByRole('tab', { name: 'Sites, VRFs and namespaces' }).click();
    await page.locator('#site-table').getByRole('button', { name: 'Headquarters' }).click();
    await page.locator('#vrf-table').getByRole('button', { name: 'Guest HQ' }).click();
  }],
  ['planner allocation preview needing confirmation', async page => {
    await page.goto('./#/network-planner');
    await page.locator('#plan-example').click();
    await page.getByRole('tab', { name: 'Allocate' }).click();
    await page.locator('#alloc-reallocate').check();
    await page.locator('#alloc-preview').click();
    await expect(page.locator('#alloc-changes')).toBeVisible();
  }],
  ['planner address map with a selection', async page => {
    await page.goto('./#/network-planner');
    await page.locator('#plan-example').click();
    await page.getByRole('tab', { name: 'Address map' }).click();
    await page.locator('#map-grid button').nth(10).click();
    await expect(page.locator('#map-details-title')).toBeVisible();
  }],
  ['planner issues', async page => {
    await page.goto('./#/network-planner');
    await page.locator('#plan-example').click();
    await page.getByRole('tab', { name: 'Issues' }).click();
  }],
  // Phase 3
  ['cron explainer result', async page => {
    await page.goto('./#/cron-explainer');
    await page.fill('#cron-from', '2026-11-14 12:00');
    await page.fill('#cron-input', '0 0 1-7 * 1');
    await expect(page.locator('#cron-warnings')).toBeVisible();
  }],
  ['cron explainer skipped and repeated times', async page => {
    await page.goto('./#/cron-explainer');
    await page.fill('#cron-from', '2026-10-31 12:00');
    await page.fill('#cron-input', '*/20 1-2 * * *');
    await expect(page.locator('#cron-runs tr[data-status="uncertain"]').first()).toBeVisible();
  }],
  ['cron explainer systemd with skipped repeats', async page => {
    await page.goto('./#/cron-explainer');
    await page.getByRole('radio', { name: 'systemd calendar', exact: true }).check();
    await page.fill('#cron-from', '2026-10-31 12:00');
    await page.fill('#cron-input', '*-*-* 01:30:00');
    await expect(page.locator('#cron-runs tr[data-status="skipped"]')).toBeVisible();
  }],
  ['cron explainer error with a dialect switch', async page => {
    await page.goto('./#/cron-explainer');
    await page.fill('#cron-input', '0 0 12 * * ?');
    await expect(page.locator('#cron-switch')).toBeVisible();
  }],
  ['schedule builder default', async page => { await page.goto('./#/schedule-builder'); await expect(page.locator('#builder-outputs article')).toHaveCount(5); }],
  ['schedule builder approximate with everything open', async page => {
    await page.goto('./#/schedule-builder');
    await page.selectOption('#builder-frequency', 'minutes');
    await page.fill('#builder-every-minutes', '7');
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'Backup & Sync');
    await expect(page.locator('[data-target="schtasks"] .fidelity')).toHaveText('Approximate');
    await page.locator('#builder-timer-unit summary').click();
    for (const t of ['cron', 'powershell', 'schtasks']) await page.locator(`[data-target="${t}"] details[data-key="runs-${t}"] summary`).click();
    await expect(page.locator('#builder-runs-schtasks')).toBeVisible();
  }],
  ['schedule builder unsupported outputs', async page => {
    await page.goto('./#/schedule-builder');
    await page.selectOption('#builder-frequency', 'monthly');
    await page.getByRole('radio', { name: 'Weekday of the month', exact: true }).check();
    await page.selectOption('#builder-nth', 'last');
    await expect(page.locator('[data-target="cron"] .fidelity')).toHaveText('Unsupported');
  }],
  ['schedule builder validation errors', async page => {
    await page.goto('./#/schedule-builder');
    await page.selectOption('#builder-frequency', 'days');
    for (const d of [1, 3, 5]) await page.locator(`#builder-day-${d}`).uncheck();
    await expect(page.locator('#builder-days-error')).toBeVisible();
  }],
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
