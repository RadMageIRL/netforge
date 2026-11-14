/**
 * Cisco / Juniper Export: reviewable configuration snippets for the VLANs, gateway interfaces and
 * DHCP pools of a network plan, for Cisco IOS / IOS-XE and Juniper Junos. Device facts a plan
 * does not hold (which VRF is the global table, what a VRF is called on the device) are asked
 * for, never guessed. Nothing is sent to a device and nothing is stored.
 */
import type { ToolMeta, ToolServices } from '../../app/registry';
import { GLOBAL_NONE, GLOBAL_UNSET, vrfsInScope, type DeviceContext } from '../../core/infra/devices';
import { iosConfig, IOS_NAME, IOS_VRF_NAME_MAX } from '../../core/infra/ios';
import { junosConfig } from '../../core/infra/junos';
import type { ExportOutput } from '../../core/infra/model';
import { checkbox, panel, segmented, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { choiceField, debounced, outputView, planSource, PREVIEW_NOTE, scopeFields, setChoices } from '../export-shared/export-view';

type Target = 'ios' | 'junos';

const TARGETS: readonly { value: Target; label: string }[] = [
  { value: 'ios', label: 'Cisco IOS / IOS-XE' },
  { value: 'junos', label: 'Juniper Junos' },
];
const TITLE: Readonly<Record<Target, string>> = { ios: 'Cisco IOS / IOS-XE snippet', junos: 'Junos set commands' };

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let target: Target = 'ios';
  const view = outputView(services, 'nc');
  /** Device VRF names typed so far, by plan VRF id. Kept while the page is open, never stored. */
  const vrfNames: Record<string, string> = {};
  let shownVrfs = '';

  function context(): DeviceContext {
    return { scope: scope.value(), globalVrfId: globalVrf.control.value, vrfNames: { ...vrfNames } };
  }

  function generate(): void {
    const plan = source.plan();
    let out: ExportOutput | null = null;
    if (plan) {
      out = target === 'ios'
        ? iosConfig(plan, { context: context(), sections: { vlans: vlans.input.checked, svis: l3.input.checked, dhcp: dhcp.input.checked }, dnsServers: dns.control.value, dnsDomain: domain.control.value })
        : junosConfig(plan, { context: context(), sections: { vlans: vlans.input.checked, irb: l3.input.checked } });
    }
    view.show(out, TITLE[target], 'Choose a plan above to see the configuration preview.');
  }
  const later = debounced(generate);

  /** One name field per VRF in scope, rebuilt only when the set of VRFs changes so typing is never interrupted. */
  function fillVrfs(): void {
    const plan = source.plan();
    const vrfs = plan ? vrfsInScope(plan, scope.value()) : [];
    setChoices(globalVrf.control, [
      { value: GLOBAL_UNSET, label: 'Choose...' },
      { value: GLOBAL_NONE, label: 'None: every VRF here is a named VRF on the device' },
      ...vrfs.map(v => ({ value: v.id, label: v.name })),
    ], GLOBAL_UNSET);
    const named = vrfs.filter(v => v.id !== globalVrf.control.value);
    const key = named.map(v => v.id).join('\n');
    if (key === shownVrfs) return;
    shownVrfs = key;
    replaceChildren(vrfFields, named.map(v => {
      if (!Object.hasOwn(vrfNames, v.id)) vrfNames[v.id] = IOS_NAME.test(v.name) && v.name.length <= IOS_VRF_NAME_MAX ? v.name : '';
      const field = textField({ id: `nc-vrf-name-${v.id}`, label: `Device name of VRF "${v.name}"`, value: vrfNames[v.id], mono: true, hint: 'The VRF or routing-instance name exactly as configured on the device.' });
      field.control.addEventListener('input', () => { vrfNames[v.id] = field.control.value; later(); });
      return field.root;
    }));
  }

  const source = planSource(services, 'nc', () => { scope.setPlan(source.plan()); fillVrfs(); generate(); });
  const scope = scopeFields('nc', () => { fillVrfs(); generate(); });
  const targetChoice = segmented({ label: 'Platform', name: 'nc-target', choices: TARGETS, value: target, onChange: v => { target = v as Target; layout(); generate(); } });
  const vlans = checkbox({ id: 'nc-vlans', label: 'VLANs and names', checked: true, onChange: generate });
  const l3 = checkbox({ id: 'nc-l3', label: 'Gateway interfaces (SVIs on IOS, IRB units on Junos)', checked: true, onChange: generate });
  const dhcp = checkbox({ id: 'nc-dhcp', label: 'DHCP pools (IOS only)', checked: false, onChange: () => { layout(); generate(); } });
  const globalVrf = choiceField('nc-global-vrf', 'Which VRF is the device\'s global routing table?', 'A plan does not say. Gateway interfaces and DHCP pools are not written until this is answered.');
  const vrfFields = h('div', { class: 'controls-row', id: 'nc-vrf-names' });
  const dns = textField({ id: 'nc-dns', label: 'DNS servers for DHCP pools (optional)', hint: 'IPv4 addresses, separated by commas. None are written unless you enter them.', mono: true });
  const domain = textField({ id: 'nc-domain', label: 'Domain name for DHCP pools (optional)', mono: true });
  globalVrf.control.addEventListener('change', () => { fillVrfs(); generate(); });
  for (const f of [dns, domain]) f.control.addEventListener('input', later);

  const dhcpOptions = h('div', { class: 'controls-row', id: 'nc-dhcp-options' }, dns.root, domain.root);
  function layout(): void {
    dhcp.root.hidden = target !== 'ios';
    dhcpOptions.hidden = target !== 'ios' || !dhcp.input.checked;
  }

  host.appendChild(toolPage(meta, categoryName,
    source.panel,
    panel('Export', [
      targetChoice.root,
      h('div', { class: 'controls-row', id: 'nc-scope' }, scope.site.root, scope.vrf.root, scope.namespace.root),
      h('p', { class: 'hint' }, 'A device has one VLAN per ID. Choose the site, and the VLAN namespace when the site has more than one.'),
      h('fieldset', { class: 'check-group' }, h('legend', { class: 'field-label' }, 'Sections to write'), vlans.root, l3.root, dhcp.root),
      h('div', { class: 'controls-row' }, globalVrf.root),
      vrfFields,
      dhcpOptions,
    ]),
    view.status,
    view.preview,
    view.account,
    h('p', { class: 'source-note' }, `${PREVIEW_NOTE} The snippets are written from the vendors' command references; they have not been loaded on a Cisco or Juniper device. They contain no commit, save, delete or shutdown command.`),
  ));
  scope.setPlan(null);
  fillVrfs();
  layout();
  generate();
}
