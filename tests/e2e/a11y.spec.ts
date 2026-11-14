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
  ['planned tool', async page => { await page.goto('./#/number-bases'); }],
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
  // Phase 4
  ['encoding result', async page => { await page.goto('./#/base64-url-hex'); await page.getByRole('button', { name: 'Example' }).click(); }],
  ['encoding error', async page => {
    await page.goto('./#/base64-url-hex');
    await page.selectOption('#codec-from', 'hex');
    await page.selectOption('#codec-to', 'text');
    await page.fill('#codec-input', '48656c6c6fff');
    await expect(page.locator('#codec-error')).toBeVisible();
  }],
  ['hash results with a comparison', async page => {
    await page.goto('./#/hash-hmac');
    await page.fill('#hash-text', 'abc');
    await page.fill('#hash-expected', '900150983cd24fb0d6963f7d28e17f72');
    await expect(page.locator('#hash-compare .notice')).toBeVisible();
  }],
  ['HMAC with a key error', async page => {
    await page.goto('./#/hash-hmac');
    await page.getByRole('radio', { name: 'HMAC', exact: true }).check();
    await page.getByRole('radio', { name: 'Hex', exact: true }).check();
    await page.fill('#hash-key', 'xyz');
    await expect(page.locator('#hash-key-error')).toBeVisible();
  }],
  ['hash file input', async page => { await page.goto('./#/hash-hmac'); await page.getByRole('radio', { name: 'File', exact: true }).check(); }],
  ['JWT verified', async page => {
    await page.goto('./#/jwt-decoder');
    await page.getByRole('button', { name: 'Example' }).click();
    await page.locator('#jwt-verify').click();
    await expect(page.locator('#jwt-verify-message')).toBeVisible();
  }],
  ['JWT failed with claim problems and a public key field', async page => {
    await page.goto('./#/jwt-decoder');
    await page.fill('#jwt-input', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjEwMDAsIm5iZiI6IngiLCJhdWQiOjV9.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await page.fill('#jwt-secret', 'wrong');
    await page.locator('#jwt-verify').click();
    await expect(page.locator('#jwt-verify-message')).toBeVisible();
    await page.getByRole('radio', { name: 'Public key', exact: true }).check();
  }],
  ['JWT malformed', async page => { await page.goto('./#/jwt-decoder'); await page.fill('#jwt-input', 'abc.def'); await expect(page.locator('#jwt-input-error')).toBeVisible(); }],
  ['regex matches with a replacement', async page => {
    await page.goto('./#/regex-tester');
    await page.getByRole('button', { name: 'Example' }).click();
    await page.locator('#regex-replace-on').check();
    await expect(page.locator('#regex-replaced')).toBeVisible();
  }],
  ['regex pattern error', async page => { await page.goto('./#/regex-tester'); await page.fill('#regex-text', 'abc'); await page.fill('#regex-pattern', '(a'); await expect(page.locator('#regex-pattern-error')).toBeVisible(); }],
  ['regex zero-length matches', async page => { await page.goto('./#/regex-tester'); await page.fill('#regex-text', 'ab'); await page.fill('#regex-pattern', 'x*'); await expect(page.locator('#regex-matches')).toBeVisible(); }],
  ['UUIDs generated', async page => { await page.goto('./#/uuid-tokens'); await page.selectOption('#token-kind', 'uuid-v7'); await page.fill('#token-count', '5'); await page.locator('#token-generate').click(); }],
  ['token count error', async page => { await page.goto('./#/uuid-tokens'); await page.selectOption('#token-kind', 'hex'); await page.fill('#token-count', '0'); await page.locator('#token-generate').click(); }],
  ['text tools with every operation', async page => {
    await page.goto('./#/text-tools');
    await page.getByRole('button', { name: 'Example' }).click();
    await page.locator('#text-dedupe').check();
    await page.locator('#text-number').check();
    await page.selectOption('#text-sort', 'natural');
  }],
  ['text tools list comparison', async page => {
    await page.goto('./#/text-tools');
    await page.getByRole('tab', { name: 'Compare lists' }).click();
    await page.fill('#compare-a', 'a\nb\nb');
    await page.fill('#compare-b', 'b\nc');
    await expect(page.locator('#compare-repeats')).toBeVisible();
  }],
  ['YAML to JSON with notes', async page => {
    await page.goto('./#/yaml-xml-tools');
    await page.selectOption('#data-operation', 'yaml-json');
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('#data-notes')).toBeVisible();
  }],
  ['YAML error', async page => { await page.goto('./#/yaml-xml-tools'); await page.fill('#data-input', 'a: [1'); await expect(page.locator('#data-errors')).toBeVisible(); }],
  ['XML to JSON with the whitespace option', async page => {
    await page.goto('./#/yaml-xml-tools');
    await page.selectOption('#data-operation', 'xml-json');
    await page.getByRole('button', { name: 'Example' }).click();
    await expect(page.locator('#data-notes')).toBeVisible();
  }],
  ['XML entity refusal', async page => {
    await page.goto('./#/yaml-xml-tools');
    await page.selectOption('#data-operation', 'xml-format');
    await page.fill('#data-input', '<a>&nbsp;</a>');
    await expect(page.locator('#data-errors')).toBeVisible();
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
