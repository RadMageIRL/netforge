import { expect, test, type Page } from '@playwright/test';
import { examplePlan } from '../../src/core/plan/example';
import { planToJson } from '../../src/core/plan/file';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

const code = (page: Page, prefix: string, index = 0) => page.locator(`#${prefix}-code-${index}`);
const target = (page: Page, name: string) => page.getByRole('radio', { name, exact: true }).check();

async function text(page: Page, prefix: string, index = 0): Promise<string> {
  return (await code(page, prefix, index).textContent()) ?? '';
}

async function openPlanFile(page: Page, prefix: string, name: string, body: string): Promise<void> {
  await page.setInputFiles(`#${prefix}-plan-file`, { name, mimeType: 'application/json', buffer: Buffer.from(body, 'utf8') });
}

test.describe('PowerShell Generator', () => {
  test('writes DHCP scopes for the example plan, inactive by default, with the privilege notice', async ({ page }) => {
    const errors = watchErrors(page);
    await openTool(page, 'powershell-generator', 'PowerShell Generator');
    await expect(page.locator('#ps-files')).toContainText('Choose a plan above');
    await page.locator('#ps-example').click();
    await page.selectOption('#ps-site', { label: 'Headquarters' });
    await expect(page.locator('#ps-status')).toContainText('Preview ready: Windows DHCP scopes');
    await expect(page.locator('#ps-status')).toContainText('1 exact, 2 approximate, 0 unsupported');
    await expect(page.locator('#ps-privileges')).toContainText('Administrator rights are required');
    const script = await text(page, 'ps');
    expect(script).toContain('#Requires -RunAsAdministrator');
    expect(script).toContain("Add-DhcpServerv4Scope -Name 'Users' -StartRange 10.10.10.1 -EndRange 10.10.10.254 -SubnetMask 255.255.255.0 -State InActive");
    expect(script).toContain('Add-DhcpServerv4ExclusionRange -ScopeId 10.10.10.0 -StartRange 10.10.10.1 -EndRange 10.10.10.99');
    expect(script).toContain('Add-DhcpServerv4ExclusionRange -ScopeId 10.10.10.0 -StartRange 10.10.10.251 -EndRange 10.10.10.254');
    expect(script).toContain('Set-DhcpServerv4OptionValue -ScopeId 10.10.10.0 -Router 10.10.10.1\n');
    expect(script).not.toContain('-DnsServer');
    expect(script).not.toContain('Add-DhcpServerv4Reservation');
    await expect(page.locator('#ps-skipped')).toContainText('VLAN 30 Servers: it has no DHCP pool');
    await expect(page.locator('#ps-items')).toContainText('No DHCPv6 scope is written');
    await expect(page.locator('#ps-not-covered')).toContainText('DHCPv6 scopes');

    await page.fill('#ps-dns', '10.10.30.10, 10.10.30.11');
    await page.fill('#ps-domain', 'corp.example');
    await page.fill('#ps-computer', 'dhcp01.corp.example');
    await page.fill('#ps-reservations', '10.10.10.5 00:11:22:33:44:55 front desk printer');
    await page.check('#ps-activate');
    await expect(code(page, 'ps')).toContainText('-State Active');
    const full = await text(page, 'ps');
    expect(full).toContain("Set-DhcpServerv4OptionValue -ComputerName 'dhcp01.corp.example' -ScopeId 10.10.10.0 -Router 10.10.10.1 -DnsServer 10.10.30.10, 10.10.30.11 -DnsDomain 'corp.example'");
    expect(full).toContain("Add-DhcpServerv4Reservation -ComputerName 'dhcp01.corp.example' -ScopeId 10.10.10.0 -IPAddress 10.10.10.5 -ClientId '00-11-22-33-44-55' -Name 'front desk printer'");
    expect(full).not.toContain('#Requires -RunAsAdministrator');
    expect(full).toContain('Scopes are created ACTIVE');
    expect(errors).toEqual([]);
  });

  test('refuses instead of guessing: bad options, reservations outside every scope, overlapping scopes', async ({ page }) => {
    await openTool(page, 'powershell-generator', 'PowerShell Generator');
    await page.locator('#ps-example').click();
    // All sites: the two guest VLANs reuse 192.168.100.0/24 in independent VRFs.
    await expect(page.locator('#ps-items .export-unsupported')).toHaveCount(2);
    await expect(page.locator('#ps-items .export-unsupported').first()).toContainText('One DHCP server cannot hold overlapping scopes');
    expect(await text(page, 'ps')).not.toContain('192.168.100.');

    await page.fill('#ps-reservations', '10.99.0.5 00-11-22-33-44-55');
    await expect(page.locator('#ps-refusals')).toContainText('the address is not in any scope of this export');
    await expect(code(page, 'ps')).toHaveCount(0);
    await page.fill('#ps-reservations', '10.10.10.5 00-11-22-33-44');
    await expect(page.locator('#ps-refusals')).toContainText('is not a MAC address');
    await page.fill('#ps-reservations', '');
    await page.fill('#ps-dns', '10.10.30.999');
    await expect(page.locator('#ps-refusals')).toContainText('DNS servers:');
    await page.fill('#ps-dns', '');
    await page.fill('#ps-computer', "srv'; Remove-Item C:\\ -Recurse #");
    await expect(page.locator('#ps-refusals')).toContainText('DHCP server name:');
    await page.fill('#ps-computer', '');
    await expect(code(page, 'ps')).toBeVisible();
  });

  test('a plan with errors is not exported, and a damaged file is not opened', async ({ page }) => {
    await openTool(page, 'powershell-generator', 'PowerShell Generator');
    const plan = examplePlan();
    plan.vlans[1]!.vlanId = '10';
    await openPlanFile(page, 'ps', 'broken.netforge-plan.json', planToJson(plan));
    await expect(page.locator('#ps-plan-summary')).toContainText('broken.netforge-plan.json');
    await expect(page.locator('#ps-refusals')).toContainText('Fix them in the planner first');
    await expect(page.locator('#ps-refusals li')).not.toHaveCount(0);
    await expect(code(page, 'ps')).toHaveCount(0);
    await openPlanFile(page, 'ps', 'notes.json', '{"hello": 1}');
    await expect(page.locator('#ps-plan-messages')).toContainText('notes.json was not opened.');
  });

  test('names with quotes and command text stay inside string literals', async ({ page }) => {
    await openTool(page, 'powershell-generator', 'PowerShell Generator');
    const plan = examplePlan();
    plan.vlans[0]!.name = "Users'; Remove-DhcpServerv4Scope -ScopeId 10.10.10.0 -Force; '";
    plan.vlans[0]!.description = '$(Stop-Computer) `whoami`';
    await openPlanFile(page, 'ps', 'quotes.netforge-plan.json', planToJson(plan));
    await page.selectOption('#ps-site', { label: 'Headquarters' });
    const script = await text(page, 'ps');
    expect(script).toContain("-Name 'Users''; Remove-DhcpServerv4Scope -ScopeId 10.10.10.0 -Force; '''");
    expect(script).toContain("-Description '$(Stop-Computer) `whoami`'");
    const commands = script.split('\n').filter(l => l !== '' && !l.startsWith('#') && !l.startsWith('$ErrorActionPreference')).map(l => l.split(' ')[0]);
    expect(new Set(commands)).toEqual(new Set(['Add-DhcpServerv4Scope', 'Add-DhcpServerv4ExclusionRange', 'Set-DhcpServerv4OptionValue']));
  });

  test('plan report and scheduled task; copy and download', async ({ page, context }) => {
    await grantClipboard(context);
    await openTool(page, 'powershell-generator', 'PowerShell Generator');
    await page.locator('#ps-example').click();
    await target(page, 'Plan report');
    await expect(page.locator('#ps-status')).toContainText('Preview ready: Plan report script');
    await expect(page.locator('#ps-privileges')).toHaveCount(0);
    expect(await text(page, 'ps')).toContain("[pscustomobject]@{ Site = 'Headquarters'; Vrf = 'Global'; VlanId = 10; Name = 'Users'; IPv4Network = '10.10.10.0/24'");
    const file = await download(page, () => page.locator('#ps-download-0').click());
    expect(file.name).toBe('netforge-plan-report.ps1');
    expect(file.text).toBe(await text(page, 'ps'));
    await page.locator('#ps-files').getByRole('button', { name: 'Copy' }).click();
    expect(await readClipboard(page)).toBe(file.text);
    await page.getByRole('button', { name: 'Copy notes' }).click();
    expect(await readClipboard(page)).toContain('Items: 10 exact, 0 approximate, 0 unsupported');

    await target(page, 'Scheduled task');
    await expect(page.locator('#ps-plan-summary')).toBeHidden();
    await expect(code(page, 'ps')).toContainText("Register-ScheduledTask -TaskName '<TASK NAME>'");
    await expect(page.locator('#ps-manual')).toContainText('Replace every value in angle brackets');
    await page.selectOption('#ps-frequency', 'weekly');
    await page.selectOption('#ps-weekday', '3');
    await page.fill('#ps-time', '02:30');
    await page.fill('#ps-start', '2026-11-18');
    await page.fill('#ps-task-name', "Bob's report");
    await page.fill('#ps-program', 'powershell.exe');
    await page.fill('#ps-arguments', '-NoProfile -File C:\\Scripts\\report.ps1');
    await expect(code(page, 'ps')).toContainText("Register-ScheduledTask -TaskName 'Bob''s report'");
    const task = await text(page, 'ps');
    expect(task).toContain("New-ScheduledTaskTrigger -Weekly -DaysOfWeek Wednesday -At '2026-11-18T02:30:00'");
    expect(task).toContain("New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -File C:\\Scripts\\report.ps1'");
    await page.fill('#ps-time', '25:00');
    await expect(page.locator('#ps-refusals')).toContainText('Time:');
  });
});

test.describe('handing over the planner\'s plan', () => {
  test('takes a copy of the plan that is open in the planner, in memory only', async ({ page }) => {
    await openTool(page, 'terraform-export', 'Terraform Export');
    await page.locator('#tf-from-planner').click();
    await expect(page.locator('#tf-plan-messages')).toContainText('has not been opened in this page yet');
    await page.locator('a[data-tool="network-planner"]').click();
    await page.locator('#plan-example').click();
    await page.fill('#plan-name', 'Handed over');
    await page.locator('a[data-tool="terraform-export"]').click();
    await page.locator('#tf-from-planner').click();
    await expect(page.locator('#tf-plan-summary')).toContainText('From the planner: Handed over, 2 sites, 3 VRFs, 10 VLANs.');
    expect(JSON.parse(await text(page, 'tf')).plan.name).toBe('Handed over');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('Handed over');
  });
});

test.describe('Terraform Export', () => {
  test('provider-neutral JSON and Terraform variables', async ({ page }) => {
    const errors = watchErrors(page);
    await openTool(page, 'terraform-export', 'Terraform Export');
    await page.locator('#tf-example').click();
    await expect(page.locator('#tf-status')).toContainText('Preview ready: provider-neutral JSON');
    const doc = JSON.parse(await text(page, 'tf'));
    expect(doc.format).toBe('netforge-network-export');
    expect(Object.keys(doc.vlans)).toHaveLength(10);
    expect(doc.vlans.v1).toMatchObject({ vlan_id: 10, ipv4_network: '10.10.10.0/24', ipv4_gateway: '10.10.10.1', ipv4_dhcp_pools: [{ first: '10.10.10.100', last: '10.10.10.250' }] });
    await page.selectOption('#tf-site', { label: 'Branch office' });
    await expect(code(page, 'tf')).not.toContainText('"v1"');
    expect(Object.keys(JSON.parse(await text(page, 'tf')).sites)).toEqual(['s2']);

    await target(page, 'Terraform variables');
    await expect(code(page, 'tf', 0)).toContainText('variable "netforge_vlans" {');
    await expect(code(page, 'tf', 1)).toContainText('netforge_vlans = {');
    const file = await download(page, () => page.locator('#tf-download-1').click());
    expect(file.name).toBe('netforge.auto.tfvars');
    await page.selectOption('#tf-format', 'json');
    const values = JSON.parse(await text(page, 'tf', 1));
    expect(Object.keys(values)).toEqual(['netforge_sites', 'netforge_vrfs', 'netforge_vlan_namespaces', 'netforge_vlans']);
    expect(values.netforge_vlans.v7.ipv4_network).toBe('10.20.10.0/24');
    expect(errors).toEqual([]);
  });

  test('AWS: a VPC and subnets with every incompatibility listed and nothing invented', async ({ page }) => {
    await openTool(page, 'terraform-export', 'Terraform Export');
    await page.locator('#tf-example').click();
    await target(page, 'AWS VPC and subnets');
    await expect(page.locator('#tf-aws-note')).toContainText('An AWS VPC is not an on-premises VLAN, VRF or site');
    await expect(page.locator('#tf-status')).toContainText('Preview ready: AWS VPC and subnets');
    const tf = await text(page, 'tf');
    expect(tf).toContain('source  = "hashicorp/aws"');
    expect(tf).toContain('resource "aws_vpc" "netforge_headquarters_global" {\n  cidr_block = "10.10.0.0/16"');
    expect(tf).toContain('availability_zone = var.netforge_availability_zones["vlan_10_users"]');
    expect((tf.match(/resource "aws_subnet"/g) ?? []).length).toBe(4);
    expect(tf).not.toMatch(/ipv6|aws_route|aws_internet_gateway|aws_nat_gateway|provider "aws"|availability_zone\s*=\s*"/);
    await expect(page.locator('#tf-items .export-exact')).toHaveCount(0);
    await expect(page.locator('#tf-items')).toContainText('VLAN 10 has no meaning in a VPC');
    await expect(page.locator('#tf-items')).toContainText('AWS assigns addresses itself');
    await expect(page.locator('#tf-items')).toContainText('IPv6 is off for this export');
    await expect(page.locator('#tf-skipped')).toContainText('VLAN 40 Cameras');
    await expect(page.locator('#tf-manual')).toContainText('Give every subnet an Availability Zone');
    await expect(page.locator('#tf-not-covered')).toContainText('Route tables');

    await page.selectOption('#tf-ipv6', 'byoip');
    await expect(code(page, 'tf')).toContainText('resource "aws_vpc_ipv6_cidr_block_association"');
    const v6 = await text(page, 'tf');
    expect(v6).toContain('ipv6_cidr_block = "2001:db8:10::/48"');
    expect(v6).toContain('ipv6_cidr_block   = "2001:db8:10:10::/64"');
    expect(v6).toContain('variable "netforge_ipv6_pool"');

    // The guest VRF has a /24 parent block: a valid VPC with one subnet, and the tag switch.
    await page.selectOption('#tf-aws-vrf', { label: 'Guest HQ' });
    await expect(page.locator('#tf-refusals')).toContainText('Choose the IPv6 parent block');
    await page.selectOption('#tf-ipv6', 'none');
    await expect(code(page, 'tf')).toContainText('cidr_block = "192.168.100.0/24"');
    await expect(code(page, 'tf')).toContainText('"netforge:vlan-id"');
    await page.uncheck('#tf-tags');
    await expect(code(page, 'tf')).not.toContainText('netforge:');
    const file = await download(page, () => page.locator('#tf-download-0').click());
    expect(file.name).toBe('netforge_aws.tf');
  });

  test('AWS refuses when the plan has no block to use as the VPC range', async ({ page }) => {
    await openTool(page, 'terraform-export', 'Terraform Export');
    const plan = examplePlan();
    plan.sites[0]!.blocks = plan.sites[0]!.blocks.filter(b => b.vrfId !== 'r1' || b.network.includes(':'));
    await openPlanFile(page, 'tf', 'noblock.netforge-plan.json', planToJson(plan));
    await target(page, 'AWS VPC and subnets');
    await expect(page.locator('#tf-refusals')).toContainText('NetForge does not invent a VPC range');
    await expect(code(page, 'tf')).toHaveCount(0);
  });

  test('template sequences in plan text are escaped in HCL', async ({ page }) => {
    await openTool(page, 'terraform-export', 'Terraform Export');
    const plan = examplePlan();
    plan.vlans[0]!.description = 'a "quoted" ${file("/etc/passwd")} %{ if true }x%{ endif } back\\slash';
    await openPlanFile(page, 'tf', 'hcl.netforge-plan.json', planToJson(plan));
    await target(page, 'Terraform variables');
    await expect(code(page, 'tf', 1)).toContainText('description     = "a \\"quoted\\" $${file(\\"/etc/passwd\\")} %%{ if true }x%%{ endif } back\\\\slash"');
  });
});

test.describe('Cisco / Juniper Export', () => {
  test('IOS: asks for the device context before writing gateway interfaces', async ({ page }) => {
    const errors = watchErrors(page);
    await openTool(page, 'network-config-export', 'Cisco / Juniper Export');
    await page.locator('#nc-example').click();
    await page.selectOption('#nc-site', { label: 'Headquarters' });
    await expect(page.locator('#nc-status')).toContainText('Preview ready: Cisco IOS / IOS-XE snippet');
    let config = await text(page, 'nc');
    expect(config).toContain('vlan 10\n name Users\n!');
    expect(config).not.toContain('interface Vlan');
    await expect(page.locator('#nc-items')).toContainText('Say which VRF of the plan is this device\'s global routing table');

    await page.selectOption('#nc-global-vrf', { label: 'Global' });
    await expect(code(page, 'nc')).toContainText('interface Vlan10');
    config = await text(page, 'nc');
    expect(config).toContain('interface Vlan30\n description Static addressing only.\n ip address 10.10.30.1 255.255.255.128\n ipv6 address 2001:db8:10:30::1/64\n!');
    expect(config).toContain('interface Vlan10\n ip address 10.10.10.1 255.255.255.0\n ipv6 address fe80::1 link-local\n!');
    // The guest VRF's plan name has a space, so its device name must be typed.
    expect(config).not.toContain('interface Vlan200');
    await expect(page.locator('#nc-vrf-name-r1')).toHaveCount(0);
    await expect(page.locator('#nc-vrf-name-r2')).toHaveValue('');
    await page.fill('#nc-vrf-name-r2', 'GUEST');
    await expect(code(page, 'nc')).toContainText('interface Vlan200\n vrf forwarding GUEST\n ip address 192.168.100.1 255.255.255.0');

    await page.check('#nc-dhcp');
    await page.fill('#nc-dns', '10.10.30.10');
    await expect(code(page, 'nc')).toContainText('dns-server 10.10.30.10');
    config = await text(page, 'nc');
    expect(config).toContain('ip dhcp excluded-address 10.10.10.1 10.10.10.99\nip dhcp excluded-address 10.10.10.251 10.10.10.254\nip dhcp pool VLAN10\n network 10.10.10.0 255.255.255.0\n default-router 10.10.10.1\n dns-server 10.10.30.10\n!');
    expect(config).toContain('ip dhcp excluded-address vrf GUEST 192.168.100.1 192.168.100.9');
    expect(config).not.toMatch(/^\s*(no |shutdown|end$|write|copy |switchport|vrf definition)/m);
    await page.fill('#nc-vrf-name-r2', 'bad name');
    await expect(page.locator('#nc-items')).toContainText('is not a valid IOS VRF name');
    await expect(code(page, 'nc')).not.toContainText('Vlan200');
    await expect(page.locator('#nc-manual')).toContainText('Assign the VLANs to trunks and access ports');
    expect(errors).toEqual([]);
  });

  test('Junos: set commands only, with the DHCP pools reported as unsupported', async ({ page }) => {
    await openTool(page, 'network-config-export', 'Cisco / Juniper Export');
    await page.locator('#nc-example').click();
    await target(page, 'Juniper Junos');
    await expect(page.locator('#nc-dhcp')).toBeHidden();
    await page.selectOption('#nc-site', { label: 'Headquarters' });
    await page.selectOption('#nc-global-vrf', { label: 'Global' });
    await page.fill('#nc-vrf-name-r2', 'GUEST');
    await expect(code(page, 'nc')).toContainText('set routing-instances GUEST interface irb.200');
    const lines = (await text(page, 'nc')).trimEnd().split('\n');
    expect(lines.every(l => l.startsWith('set vlans ') || l.startsWith('set interfaces irb unit ') || l.startsWith('set routing-instances '))).toBe(true);
    expect(lines).toContain('set vlans Servers description "Static addressing only."');
    expect(lines).toContain('set vlans Users l3-interface irb.10');
    expect(lines).toContain('set interfaces irb unit 30 family inet6 address 2001:db8:10:30::1/64');
    await expect(page.locator('#nc-items')).toContainText('this export has no Junos DHCP configuration');
    await page.uncheck('#nc-l3');
    await expect(code(page, 'nc')).not.toContainText('irb');
    const file = await download(page, () => page.locator('#nc-download-0').click());
    expect(file.name).toBe('netforge-junos.txt');
  });

  test('duplicate VLAN IDs across namespaces and hostile names never produce stray lines', async ({ page }) => {
    await openTool(page, 'network-config-export', 'Cisco / Juniper Export');
    // All sites: VLANs 10, 20 and 200 exist at both sites, in two namespaces.
    await page.locator('#nc-example').click();
    await expect(page.locator('#nc-items .export-unsupported')).toHaveCount(6);
    await expect(page.locator('#nc-items')).toContainText('export one VLAN namespace at a time');

    const plan = examplePlan();
    plan.vlans[0]!.name = 'Users\n no ip address';
    plan.vlans[1]!.name = 'Voice ?';
    plan.vlans[2]!.description = 'x\ninterface Vlan1\n shutdown';
    await openPlanFile(page, 'nc', 'hostile.netforge-plan.json', planToJson(plan));
    await page.selectOption('#nc-site', { label: 'Headquarters' });
    await page.selectOption('#nc-global-vrf', { label: 'Global' });
    await expect(code(page, 'nc')).toContainText('interface Vlan30');
    const config = await text(page, 'nc');
    expect(config).not.toMatch(/no ip address|shutdown|Vlan1\b|\?/);
    expect(config).toContain('vlan 10\n!\nvlan 20\n!\nvlan 30\n name Servers\n!');
    await expect(page.locator('#nc-items')).toContainText('is not written as the VLAN name');
    await target(page, 'Juniper Junos');
    await expect(code(page, 'nc')).toContainText('set vlans VLAN10 vlan-id 10');
    expect(await text(page, 'nc')).not.toMatch(/no ip address|shutdown|description/);
  });
});
