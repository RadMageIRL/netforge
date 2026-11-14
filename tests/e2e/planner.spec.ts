import { expect, test, type Page } from '@playwright/test';
import { examplePlan } from '../../src/core/plan/example';
import { planToJson } from '../../src/core/plan/file';
import { download, openTool, watchErrors } from './helpers';

const rows = (page: Page) => page.locator('#vlan-table tbody tr');
const row = (page: Page, id: string) => page.locator(`#vlan-table tr[data-vlan="${id}"]`);
const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click();

async function loadExample(page: Page): Promise<void> {
  await page.locator('#plan-example').click();
  await expect(rows(page)).toHaveCount(10);
}

async function openFile(page: Page, name: string, text: string): Promise<void> {
  await page.setInputFiles('#plan-file', { name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
}

test.beforeEach(async ({ page }) => {
  await openTool(page, 'network-planner', 'NetForge Subnet & VLAN Planner');
});

test('starts empty, and loads the example with its notes', async ({ page }) => {
  const errors = watchErrors(page);
  await expect(page.locator('#vlan-empty')).toHaveText('No VLANs yet. Add one, open a plan file or load the example.');
  await expect(page.locator('#plan-summary')).toContainText('1 site, 1 VRF, 1 VLAN namespace, 0 VLANs.');
  await loadExample(page);
  await expect(page.locator('#plan-summary')).toHaveText('2 sites, 3 VRFs, 2 VLAN namespaces, 10 VLANs. 0 errors, 0 warnings, 4 notes.');
  await expect(page.locator('#plan-name')).toHaveValue('Example network');
  // Default order: site, then VLAN ID.
  await expect(rows(page).locator('td:nth-child(4)')).toHaveText(['10', '20', '50', '200', '10', '20', '30', '40', '99', '200']);
  await expect(row(page, 'v6').locator('.badge')).toHaveText('Note');
  await expect(row(page, 'v1').locator('.badge')).toHaveText('OK');
  expect(errors).toEqual([]);
});

test('adds a VLAN and shows each problem at its field and row', async ({ page }) => {
  await loadExample(page);
  await page.locator('#vlan-add').click();
  await expect(page.locator('#vlan-edit-vlanid')).toBeFocused();
  await expect(rows(page)).toHaveCount(11);
  await page.fill('#vlan-edit-vlanid', '4095');
  await expect(page.locator('#vlan-edit-vlanid-error')).toHaveText('VLAN 4095 is reserved by IEEE 802.1Q and cannot be assigned. Use 1 to 4094.');
  await expect(page.locator('#vlan-edit-vlanid')).toHaveAttribute('aria-invalid', 'true');
  await page.fill('#vlan-edit-vlanid', '15');
  await expect(page.locator('#vlan-edit-vlanid')).not.toHaveAttribute('aria-invalid', 'true');
  await page.fill('#vlan-edit-name', 'Lab');
  await page.fill('#vlan-edit-ipv4', '10.10.15.0/24');
  await page.fill('#vlan-edit-gateway4', '10.10.15.255');
  await expect(page.locator('#vlan-edit-gateway4-error')).toHaveText('10.10.15.255 is the broadcast address of 10.10.15.0/24; a gateway needs a host address.');
  await page.fill('#vlan-edit-gateway4', '10.10.15.1');
  await page.fill('#vlan-edit-dhcp', '10.10.15.1 - 10.10.15.99\n10.10.15.50 - 10.10.15.60');
  await expect(page.locator('#vlan-edit-dhcp-error')).toHaveText('DHCP pool 1 (10.10.15.1 - 10.10.15.99) includes the gateway 10.10.15.1, so a client could be leased the gateway\'s address. DHCP pool 2 (10.10.15.50 - 10.10.15.60) overlaps DHCP pool 1 (10.10.15.1 - 10.10.15.99).');
  await expect(row(page, 'v11').locator('.badge')).toHaveText('2 errors');
  await expect(row(page, 'v11')).toHaveClass(/row-error/);
  await page.fill('#vlan-edit-dhcp', '10.10.15.100 - 10.10.15.200');
  await page.fill('#vlan-edit-hosts', '300');
  await expect(page.locator('#vlan-edit-hosts-error')).toHaveText('Needs 300 usable addresses, but 10.10.15.0/24 has 254. The smallest network that fits is a /23.');
  await page.fill('#vlan-edit-hosts', '120');
  await page.fill('#vlan-edit-ipv6', '2001:db8:10:15::/80');
  await expect(page.locator('#vlan-edit-ipv6-warning')).toContainText('is a /80. A LAN segment is normally exactly a /64');
  await expect(page.locator('#vlan-edit-ipv6')).not.toHaveAttribute('aria-invalid', 'true');
  await page.fill('#vlan-edit-ipv6', '2001:db8:10:15::/64');
  await expect(row(page, 'v11').locator('.badge')).toHaveText('OK');
  await expect(page.locator('#plan-summary')).toContainText('0 errors, 0 warnings, 4 notes. Not saved to a file.');
  await page.locator('#vlan-done').click();
  await expect(page.locator('#vlan-editor')).toBeHidden();
  await expect(row(page, 'v11').getByRole('button', { name: 'Lab' })).toBeFocused();
});

test('VLAN IDs are unique per namespace: a copy clashes, another namespace does not', async ({ page }) => {
  await loadExample(page);
  await row(page, 'v8').getByRole('button').click(); // Branch Voice, VLAN 20
  await page.locator('#vlan-duplicate').click();
  await expect(page.locator('#vlan-editor-title')).toContainText('VLAN 20 Voice copy');
  await expect(page.locator('#vlan-edit-vlanid-error')).toContainText('VLAN 20 is also used in VLAN namespace "Branch switches" by VLAN 20 Voice at Branch office.');
  await expect(page.locator('#vlan-edit-ipv4-error')).toContainText('10.20.20.0/25 is also assigned to VLAN 20 Voice at Branch office, in VRF "Global".');
  await expect(row(page, 'v8').locator('.badge')).toHaveText('2 errors');
  // Moving the copy to Headquarters (its own namespace) clears the ID clash; HQ already has VLAN 20, though.
  await page.locator('#vlan-edit-site').selectOption({ label: 'Headquarters' });
  await expect(page.locator('#vlan-edit-namespace')).toHaveValue('n1');
  await expect(page.locator('#vlan-edit-vlanid-error')).toContainText('in VLAN namespace "HQ switches" by VLAN 20 Voice at Headquarters');
  await page.fill('#vlan-edit-vlanid', '21');
  await expect(page.locator('#vlan-edit-vlanid-error')).toBeHidden();
  await expect(row(page, 'v8').locator('.badge')).toHaveText('1 error');
  // Delete, undo, delete again.
  await page.locator('#vlan-delete').click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator('#vlan-undo')).toBeFocused();
  await page.locator('#vlan-undo').click();
  await expect(rows(page)).toHaveCount(11);
  await expect(page.locator('#vlan-edit-vlanid')).toHaveValue('21');
  await page.locator('#vlan-delete').click();
  await expect(rows(page)).toHaveCount(10);
  await expect(row(page, 'v8').locator('.badge')).toHaveText('OK');
});

test('reuse across independent VRFs is a note; once the VRFs exchange routes it is an error', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Issues');
  const reuse = page.locator('#issue-list li[data-code="reuse-independent"]');
  await expect(reuse).toHaveCount(2);
  await expect(reuse.first()).toContainText('Routing-domain scope: VRF "Guest HQ" and the independent VRF "Guest branch".');
  await tab(page, 'Sites, VRFs and namespaces');
  await page.locator('#vrf-table').getByRole('button', { name: 'Guest HQ' }).click();
  await page.getByLabel('Guest branch').check();
  await expect(page.locator('#vrf-table tr[data-id="r3"]')).toContainText('Guest HQ');
  await tab(page, 'Issues');
  // The guest networks now clash, and so do the guest parent blocks of the two sites.
  await expect(page.getByRole('tab', { name: 'Issues (4)' })).toBeVisible();
  const dup = page.locator('#issue-list li[data-code="duplicate-network"]');
  await expect(dup).toHaveCount(2);
  await expect(page.locator('#issue-list li[data-code="block-overlap"]')).toHaveCount(2);
  await expect(dup.first()).toContainText('Routing-domain scope: VRFs "Guest HQ" and "Guest branch", which exchange routes.');
  // The link goes to the field.
  await dup.first().getByRole('button').click();
  await expect(page.getByRole('tab', { name: 'VLANs' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#vlan-edit-ipv4')).toBeFocused();
  await expect(page.locator('#vlan-edit-ipv4-error')).toContainText('in VRFs "Guest HQ" and "Guest branch", which exchange routes.');
});

test('sorts and filters the VLAN table', async ({ page }) => {
  await loadExample(page);
  const vlanHeader = page.locator('#vlan-table th').filter({ hasText: 'VLAN' }).first();
  await vlanHeader.getByRole('button').click();
  await expect(vlanHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(rows(page).locator('td:nth-child(4)')).toHaveText(['10', '10', '20', '20', '30', '40', '50', '99', '200', '200']);
  await vlanHeader.getByRole('button').click();
  await expect(vlanHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(rows(page).locator('td:nth-child(4)').first()).toHaveText('200');
  const ipHeader = page.locator('#vlan-table th').filter({ hasText: 'IPv4 network' });
  await ipHeader.getByRole('button').click();
  // Numeric address order (10.10.99.0 after 10.10.30.0), empty networks last.
  await expect(rows(page).locator('td:nth-child(7)')).toHaveText(['10.10.10.0/24', '10.10.20.0/24', '10.10.30.0/25', '10.10.99.0/26', '10.20.10.0/24', '10.20.20.0/25', '192.168.100.0/24', '192.168.100.0/24', '', '']);
  await page.fill('#vlan-filter', 'guest');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#vlan-count')).toHaveText('Showing 2 of 10 VLANs');
  await page.fill('#vlan-filter', '');
  await page.locator('#vlan-filter-site').selectOption({ label: 'Branch office' });
  await expect(rows(page)).toHaveCount(4);
  await page.locator('#vlan-filter-status').selectOption('info');
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#vlan-filter-site').selectOption('');
  await page.locator('#vlan-filter-vrf').selectOption({ label: 'Global' });
  await expect(rows(page)).toHaveCount(2);
  await page.locator('#vlan-filter-status').selectOption('problems');
  await expect(page.locator('#vlan-empty')).toHaveText('No VLANs match the filters.');
});

test('manages sites, VRFs and namespaces, and refuses to delete what is in use', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Sites, VRFs and namespaces');
  await page.locator('#site-add').click();
  await expect(page.locator('#site-edit-name')).toBeFocused();
  await expect(page.locator('#site-table tbody tr')).toHaveCount(3);
  await expect(page.locator('#namespace-table')).toContainText('Site 3 switches');
  await page.fill('#site-edit-name', 'Data center');
  await expect(page.locator('#namespace-table')).toContainText('Data center switches');
  await page.locator('#site-add-block').click();
  await page.locator('#site-blocks input').first().fill('10.10.0.0/16');
  await expect(page.locator('#site-blocks .field-error').first()).toContainText('10.10.0.0/16 is the same block as 10.10.0.0/16 of site "Headquarters" in VRF "Global".');
  await page.locator('#site-blocks input').first().fill('10.30.0.0/16');
  await expect(page.locator('#site-blocks .field-error:visible')).toHaveCount(0);
  // A VRF in use cannot be deleted.
  await page.locator('#vrf-table').getByRole('button', { name: 'Global' }).click();
  await page.locator('#vrf-delete').click();
  await expect(page.locator('#vrf-editor').locator('xpath=..')).toContainText('VRF "Global" is still used by 13 VLANs and parent blocks. Move or delete them first.');
  await page.locator('#vrf-add').click();
  await page.fill('#vrf-edit-name', 'Lab');
  await expect(page.locator('#vrf-table')).toContainText('Lab');
  await page.locator('#vrf-delete').click();
  await expect(page.locator('#vrf-table')).not.toContainText('Lab');
  // The new site has no VLANs; its own namespace goes with it.
  await page.locator('#site-table').getByRole('button', { name: 'Data center' }).click();
  await page.locator('#site-delete').click();
  await expect(page.locator('#site-table tbody tr')).toHaveCount(2);
  await expect(page.locator('#namespace-table')).not.toContainText('Data center');
});

test('allocates IPv4 from host targets, and replaces existing networks only after confirmation', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Allocate');
  await expect(page.locator('#alloc-parents')).toHaveValue('10.10.0.0/16');
  await page.locator('#alloc-preview').click();
  const changes = page.locator('#alloc-changes tbody tr');
  await expect(changes).toHaveCount(1);
  await expect(changes.first()).toContainText('VLAN 40 Cameras at Headquarters');
  await expect(changes.first().locator('td:nth-child(4)')).toHaveText('10.10.0.0/25');
  await expect(changes.first().locator('td:nth-child(5)')).toHaveText('10.10.0.1');
  await page.locator('#alloc-apply').click();
  await expect(page.locator('#alloc-result .notice-ok')).toContainText('Applied: 1 VLAN updated.');
  await expect(page.locator('#plan-summary')).toContainText('3 notes');

  await page.getByLabel('Also reassign VLANs that already have networks (except those marked fixed)').check();
  await page.locator('#alloc-preview').click();
  await expect(changes).toHaveCount(4);
  await expect(page.locator('#alloc-apply')).toBeDisabled();
  await expect(page.locator('#alloc-result .notice-warning')).toContainText('4 VLANs already have networks that this replaces.');
  await page.getByLabel('Replace 4 existing networks as shown').check();
  await expect(page.locator('#alloc-apply')).toBeEnabled();
  await page.locator('#alloc-apply').click();
  await tab(page, 'VLANs');
  await expect(row(page, 'v3').locator('td:nth-child(7)')).toHaveText('10.10.30.0/25'); // fixed
  await expect(row(page, 'v1').locator('td:nth-child(7)')).toHaveText('10.10.0.0/24');
});

test('a preview made before the plan changed cannot be applied', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Allocate');
  await page.locator('#alloc-preview').click();
  await tab(page, 'VLANs');
  await row(page, 'v5').getByRole('button').click();
  await page.fill('#vlan-edit-ipv4', '10.10.200.0/25');
  await tab(page, 'Allocate');
  await expect(page.locator('#alloc-result .notice-warning')).toHaveText('The plan changed after this preview. Preview again before applying.');
  await expect(page.locator('#alloc-apply')).toBeDisabled();
});

test('allocates IPv6 /64s and reports exhaustion', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Allocate');
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await expect(page.locator('#alloc-parents')).toHaveValue('2001:db8:10::/48');
  await page.locator('#alloc-preview').click();
  await expect(page.locator('#alloc-changes tbody tr td:nth-child(4)')).toHaveText(['2001:db8:10::/64', '2001:db8:10:1::/64']);
  await expect(page.locator('#alloc-result .summary-table')).toContainText('Free /64 prefixes65,531 of 65,533 before');
  await page.fill('#alloc-parents', '2001:db8:10:10::/63');
  await page.locator('#alloc-preview').click();
  await expect(page.locator('#alloc-result .notice-error')).toContainText('VLAN 40 Cameras at Headquarters: Needs 1 /64 prefix, but the parent space is exhausted: no /64 is free.');
  await page.fill('#alloc-per-vlan', '300');
  await page.locator('#alloc-preview').click();
  await expect(page.locator('#alloc-result .notice-error')).toContainText('Prefixes per VLAN must be a whole number from 1 to 256.');
});

test('the address map zooms by cells, selects networks and works by keyboard', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Address map');
  const cells = page.locator('#map-grid button');
  await expect(cells).toHaveCount(256);
  await expect(page.locator('#map-summary')).toHaveText('10.10.0.0/16: 65,536 addresses in 256 cells of /24 (256 each). 960 used (1.46%).');
  await expect(cells.nth(10)).toHaveAttribute('aria-label', '10.10.10.0/24: Allocated, VLAN 10 Users at Headquarters');
  await expect(cells.nth(255)).toHaveClass(/cell-reserved/);
  await cells.nth(10).click();
  await expect(page.locator('#map-details-title')).toHaveText('VLAN 10 Users at Headquarters');
  await expect(page.locator('#map-details')).toContainText('Gateway10.10.10.1');
  // Keyboard: one tab stop, arrows move, Enter zooms into a partly used cell, Backspace zooms out.
  await cells.nth(10).focus();
  await page.keyboard.press('ArrowDown');
  await expect(cells.nth(26)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(cells.nth(30)).toBeFocused();
  await expect(cells.nth(30)).toHaveClass(/cell-partial/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#map-summary')).toContainText('10.10.30.0/24: 256 addresses in 256 cells of /32');
  await expect(page.locator('#map-grid button.cell-allocated')).toHaveCount(128);
  await expect(page.locator('.map-crumbs li')).toHaveText(['10.10.0.0/16', '10.10.30.0/24']);
  await page.keyboard.press('Backspace');
  await expect(page.locator('#map-summary')).toContainText('10.10.0.0/16:');
  // IPv6 /48: still 256 cells.
  await page.getByRole('radio', { name: 'IPv6' }).check();
  await expect(page.locator('#map-summary')).toHaveText(/^2001:db8:10::\/48: 1,208,925,819,614,629,174,706,176 addresses in 256 cells of \/56/);
  await expect(cells).toHaveCount(256);
  // A typed prefix, and conflicts drawn as such.
  await page.getByRole('radio', { name: 'IPv4' }).check();
  await tab(page, 'VLANs');
  await row(page, 'v4').getByRole('button').click();
  await page.fill('#vlan-edit-ipv4', '10.10.10.0/26');
  await tab(page, 'Address map');
  await expect(cells.nth(10)).toHaveClass(/cell-conflict/);
  await expect(page.locator('#map-summary')).toContainText('1 cell with conflicts.');
});

test('saves and opens plan files, keeping every field', async ({ page }) => {
  await loadExample(page);
  const saved = await download(page, () => page.locator('#plan-save').click());
  expect(saved.name).toBe('Example-network.netforge-plan.json');
  expect(saved.text).toBe(planToJson(examplePlan()));
  await expect(page.locator('#plan-summary')).not.toContainText('Not saved');
  // New (nothing unsaved, so no question), then open the file through the Open button.
  await page.locator('#plan-new').click();
  await expect(rows(page)).toHaveCount(0);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#plan-open').click()]);
  await chooser.setFiles({ name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from(saved.text) });
  await expect(page.locator('#plan-messages .notice-ok')).toHaveText('Opened mine.json: 10 VLANs at 2 sites.');
  await expect(rows(page)).toHaveCount(10);
  const again = await download(page, () => page.locator('#plan-save').click());
  expect(again.text).toBe(saved.text);
});

test('refuses damaged and unsupported files and keeps the current plan', async ({ page }) => {
  await loadExample(page);
  await page.locator('#plan-save').click();
  await openFile(page, 'broken.json', '{"format":"netforge-plan","version":1,"plan":{"vlans":[{"id":"v1","name":7}]}}');
  await expect(page.locator('#plan-messages .notice-error')).toHaveText('broken.json was not opened. The plan file is damaged or was edited incorrectly: plan.vlans[0].name must be text.The current plan is unchanged.');
  await expect(rows(page)).toHaveCount(10);
  await openFile(page, 'future.json', '{"format":"netforge-plan","version":7,"plan":{}}');
  await expect(page.locator('#plan-messages .notice-error')).toContainText('uses format version 7, which is newer than this version of NetForge reads (version 1)');
  await openFile(page, 'notes.txt', 'hello');
  await expect(page.locator('#plan-messages .notice-error')).toContainText('The file is not valid JSON');
  await openFile(page, 'extra.json', '{"format":"netforge-plan","version":1,"plan":{"color":"red","vlans":[]}}');
  await expect(page.locator('#plan-messages .notice-warning')).toContainText('plan.color is not part of the plan format and was left out.');
  await expect(rows(page)).toHaveCount(0);
});

test('asks before replacing a plan with unsaved changes', async ({ page }) => {
  await loadExample(page);
  await page.fill('#plan-name', 'Changed');
  await page.locator('#plan-new').click();
  await expect(page.locator('#plan-messages')).toContainText('The current plan has changes that are not saved to a file.');
  await expect(page.locator('#plan-confirm')).toBeFocused();
  await page.locator('#plan-cancel').click();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.locator('#plan-name')).toHaveValue('Changed');
  await page.locator('#plan-new').click();
  await page.locator('#plan-confirm').click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#plan-name')).toHaveValue('');
});

test('exports the VLANs shown as CSV, and the findings', async ({ page }) => {
  await loadExample(page);
  const all = await download(page, () => page.locator('#vlan-csv').click());
  expect(all.name).toBe('Example-network-vlans.csv');
  const lines = all.text.split('\r\n');
  expect(lines[0]).toBe('Site,VLAN namespace,VLAN ID,Name,VRF,IPv4 network,Subnet mask,IPv4 gateway,Usable IPv4 addresses,Host target,DHCP pools,Reserved,IPv4 fixed,IPv6 prefixes,IPv6 gateway,IPv6 fixed,Description,Notes,Errors,Warnings');
  expect(lines[1]).toBe('Branch office,Branch switches,10,Users,Global,10.20.10.0/24,255.255.255.0,10.20.10.1,254,150,10.20.10.100 - 10.20.10.250,,no,2001:db8:20:10::/64,fe80::1,no,,,0,0');
  expect(lines).toHaveLength(12);
  await page.fill('#vlan-filter', 'guest');
  await expect(rows(page)).toHaveCount(2);
  const some = await download(page, () => page.locator('#vlan-csv').click());
  expect(some.text.split('\r\n')).toHaveLength(4);
  await tab(page, 'Issues');
  const findings = await download(page, () => page.locator('#issue-csv').click());
  expect(findings.text.split('\r\n')[0]).toBe('Severity,Code,Where,Field,Entry,Message,Routing-domain scope');
  expect(findings.text.split('\r\n')).toHaveLength(6);
});

test('the tabs follow the keyboard pattern', async ({ page }) => {
  const vlansTab = page.getByRole('tab', { name: 'VLANs' });
  await vlansTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Sites, VRFs and namespaces' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Sites, VRFs and namespaces' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Sites, VRFs and namespaces' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Issues' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(vlansTab).toBeFocused();
});
