import { expect, test, type Page } from '@playwright/test';
import { planToJson } from '../../src/core/plan/file';
import { syntheticPlan } from '../plan-helpers';
import { openTool } from './helpers';

// Timings are taken inside the page around synchronous work (the planner updates synchronously on
// a select change or click), so they measure the app, not the test runner's polling.

interface Action { kind: 'click' | 'change'; selector: string; value?: string }

async function timed(page: Page, action: Action): Promise<number> {
  return page.evaluate(a => {
    const start = performance.now();
    const target = document.querySelector<HTMLElement>(a.selector)!;
    if (a.kind === 'click') target.click();
    else {
      (target as HTMLSelectElement).value = a.value!;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return performance.now() - start;
  }, action);
}

for (const n of [100, 500, 1000]) {
  test(`stays responsive with ${n} VLANs`, async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'network-planner', 'NetForge Subnet & VLAN Planner');
    const text = planToJson(syntheticPlan(n));

    // Open: from choosing the file to every row in the table.
    await page.evaluate(count => {
      (window as unknown as { loaded: Promise<number> }).loaded = new Promise(resolve => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll('#vlan-table tbody tr').length === count) {
            observer.disconnect();
            resolve(performance.now() - start);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }, n);
    await page.setInputFiles('#plan-file', { name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    const openMs = await page.evaluate(() => (window as unknown as { loaded: Promise<number> }).loaded);
    await expect(page.locator('#vlan-table tbody tr')).toHaveCount(n);
    await expect(page.locator('#plan-summary')).toContainText(`${n.toLocaleString('en-US')} VLANs. 0 errors, 0 warnings`);

    // Keyed rows: an edit rebuilds only the rows whose content changed.
    await page.evaluate(() => document.querySelectorAll('#vlan-table tbody tr').forEach(tr => tr.setAttribute('data-mark', '1')));
    await page.locator('#vlan-table tr[data-vlan="v2"] button').click();
    const editMs = await timed(page, { kind: 'change', selector: '#vlan-edit-vrf', value: 'g1' });
    await expect(page.locator('#vlan-table tr[data-vlan="v2"] td:nth-child(6)')).toHaveText('Guest 1');
    const rebuilt = await page.evaluate(() => document.querySelectorAll('#vlan-table tbody tr:not([data-mark])').length);
    // VLAN 2 itself; a VLAN whose findings changed because of it may be rebuilt too.
    expect(rebuilt).toBeLessThanOrEqual(3);

    const sortMs = await timed(page, { kind: 'click', selector: '#vlan-table thead th:nth-child(7) button' });
    const filterMs = await timed(page, { kind: 'change', selector: '#vlan-filter-status', value: 'info' });
    await timed(page, { kind: 'change', selector: '#vlan-filter-status', value: 'all' });
    const mapMs = await timed(page, { kind: 'click', selector: '#planner-tabs-tab-map' });
    await expect(page.locator('#map-grid button')).toHaveCount(256);
    const issuesMs = await timed(page, { kind: 'click', selector: '#planner-tabs-tab-issues' });
    const validateMs = Number((await page.locator('#issue-timing').textContent())!.match(/in ([0-9.]+) ms/)![1]);

    const line = `${n} VLANs: open ${openMs.toFixed(0)} ms, edit (validate + update) ${editMs.toFixed(1)} ms, validation alone ${validateMs.toFixed(1)} ms, sort ${sortMs.toFixed(1)} ms, filter ${filterMs.toFixed(1)} ms, address map ${mapMs.toFixed(1)} ms, issues ${issuesMs.toFixed(1)} ms, rows rebuilt by an edit ${rebuilt}`;
    console.log(line);
    // Budgets are generous: a slow CI machine must not fail, but a regression to quadratic work would.
    expect(openMs).toBeLessThan(n * 5);
    expect(editMs).toBeLessThan(Math.max(250, n * 0.5));
    expect(sortMs).toBeLessThan(Math.max(250, n * 0.5));
    expect(mapMs).toBeLessThan(1000);
  });
}
