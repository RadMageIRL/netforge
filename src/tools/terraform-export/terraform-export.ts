/**
 * Terraform Export: a network plan as provider-neutral JSON, as Terraform variables, or as an AWS
 * VPC with subnets. Every target lists what it could not carry over. Nothing is planned or
 * applied, and nothing is stored.
 */
import type { ToolMeta, ToolServices } from '../../app/registry';
import type { ExportOutput } from '../../core/infra/model';
import { neutralJson } from '../../core/infra/neutral';
import { awsTerraform, terraformVariables, type Ipv6Mode, type ValuesFormat } from '../../core/infra/terraform';
import { parsePrefixText } from '../../core/net/address';
import { checkbox, panel, segmented, selectField, toolPage } from '../../ui/components';
import { h } from '../../ui/dom';
import { choiceField, outputView, planSource, PREVIEW_NOTE, scopeFields, setChoices } from '../export-shared/export-view';

type Target = 'json' | 'variables' | 'aws';

const TARGETS: readonly { value: Target; label: string }[] = [
  { value: 'json', label: 'JSON (provider-neutral)' },
  { value: 'variables', label: 'Terraform variables' },
  { value: 'aws', label: 'AWS VPC and subnets' },
];
const TITLE: Readonly<Record<Target, string>> = { json: 'provider-neutral JSON', variables: 'Terraform variables', aws: 'AWS VPC and subnets' };

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let target: Target = 'json';
  const view = outputView(services, 'tf');

  function fillBlocks(): void {
    const plan = source.plan();
    const site = plan?.sites.find(s => s.id === awsScope.site.control.value);
    const vrfId = awsScope.vrf.control.value;
    const blocks = (site?.blocks ?? []).filter(b => b.vrfId === vrfId).map(b => ({ b, p: parsePrefixText(b.network.trim()) })).filter(x => x.p.ok);
    const label = (x: (typeof blocks)[number]) => `${x.b.network.trim()}${x.b.description.trim() ? ` (${x.b.description.trim()})` : ''}`;
    const v4 = blocks.filter(x => x.p.ok && x.p.value.prefix.family === 4).map(x => ({ value: x.b.id, label: label(x) }));
    const v6 = blocks.filter(x => x.p.ok && x.p.value.prefix.family === 6).map(x => ({ value: x.b.id, label: label(x) }));
    setChoices(block.control, v4.length > 0 ? v4 : [{ value: '', label: 'No IPv4 parent block for this site and VRF' }]);
    setChoices(block6.control, v6.length > 0 ? v6 : [{ value: '', label: 'No IPv6 parent block for this site and VRF' }]);
  }

  function generate(): void {
    const plan = source.plan();
    let out: ExportOutput | null = null;
    if (plan) {
      if (target === 'json') out = neutralJson(plan, scope.value());
      else if (target === 'variables') out = terraformVariables(plan, scope.value(), format.control.value as ValuesFormat);
      else out = awsTerraform(plan, {
        siteId: awsScope.site.control.value, vrfId: awsScope.vrf.control.value, blockId: block.control.value,
        ipv6: ipv6.control.value as Ipv6Mode, ipv6BlockId: block6.control.value, metadataTags: tags.input.checked,
      });
    }
    view.show(out, TITLE[target], 'Choose a plan above to see the export preview.');
  }

  const source = planSource(services, 'tf', () => { scope.setPlan(source.plan()); awsScope.setPlan(source.plan()); fillBlocks(); generate(); });
  const scope = scopeFields('tf', generate);
  const awsScope = scopeFields('tf-aws', () => { fillBlocks(); generate(); }, { requireSite: true, requireVrf: true });
  const targetChoice = segmented({ label: 'Export as', name: 'tf-target', choices: TARGETS, value: target, onChange: v => { target = v as Target; layout(); generate(); } });
  const format = selectField({ id: 'tf-format', label: 'Variable values file', groups: [{ label: null, options: [{ value: 'hcl', label: 'netforge.auto.tfvars (HCL syntax)' }, { value: 'json', label: 'netforge.auto.tfvars.json (JSON syntax)' }] }], value: 'hcl' });
  const block = choiceField('tf-block', 'VPC CIDR block (an IPv4 parent block of the site)', 'The plan must hold the range. NetForge does not invent one.');
  const ipv6 = selectField({ id: 'tf-ipv6', label: 'IPv6', hint: 'AWS chooses a VPC\'s IPv6 range unless it comes from your own BYOIP pool.', groups: [{ label: null, options: [{ value: 'none', label: 'Do not write IPv6 (report it as unsupported)' }, { value: 'byoip', label: 'The planned prefixes are in my BYOIP pool' }] }], value: 'none' });
  const block6 = choiceField('tf-block6', 'VPC IPv6 CIDR block (an IPv6 parent block of the site)');
  const tags = checkbox({ id: 'tf-tags', label: 'Write the plan\'s site, VRF, VLAN ID and gateway as netforge: tags', checked: true, onChange: generate });
  for (const f of [format, block, ipv6, block6]) f.control.addEventListener('change', () => { layout(); generate(); });

  const scopeRow = h('div', { class: 'controls-row', id: 'tf-scope' }, scope.site.root, scope.vrf.root, scope.namespace.root);
  const variableOptions = h('div', { class: 'controls-row', id: 'tf-variable-options' }, format.root);
  const awsOptions = h('div', { class: 'export-options', id: 'tf-aws-options' },
    h('p', { class: 'hint', id: 'tf-aws-note' }, 'An AWS VPC is not an on-premises VLAN, VRF or site. This target uses one VPC for one site\'s address block in one VRF and one subnet per VLAN network inside it, and lists everything in the plan that AWS cannot hold. It never chooses Availability Zones, route tables or gateways.'),
    h('div', { class: 'controls-row' }, awsScope.site.root, awsScope.vrf.root, block.root),
    h('div', { class: 'controls-row' }, ipv6.root, block6.root),
    tags.root);

  function layout(): void {
    scopeRow.hidden = target === 'aws';
    variableOptions.hidden = target !== 'variables';
    awsOptions.hidden = target !== 'aws';
    awsScope.namespace.root.hidden = true;
    block6.root.hidden = ipv6.control.value !== 'byoip';
  }

  host.appendChild(toolPage(meta, categoryName,
    source.panel,
    panel('Export', [targetChoice.root, scopeRow, variableOptions, awsOptions]),
    view.status,
    view.preview,
    view.account,
    h('p', { class: 'source-note' }, `${PREVIEW_NOTE} NetForge never runs terraform plan or terraform apply.`),
  ));
  scope.setPlan(null);
  awsScope.setPlan(null);
  fillBlocks();
  layout();
  generate();
}
