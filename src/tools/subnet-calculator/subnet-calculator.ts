/** Subnet Calculator: IPv4 address and prefix in, every subnet property out. */
import { toCsv } from '../../core/export/csv';
import { toJsonText } from '../../core/export/files';
import { formatInteger } from '../../core/format';
import { calculateSubnet, formatIPv4, parseSubnetInput, type SubnetInfo } from '../../core/net/ipv4';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, emptyState, notice, panel, resultTable, textField, toolPage, type ResultRow } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';

const EXAMPLES = ['192.168.1.130/26', '10.0.0.0/8', '172.16.5.4 255.255.240.0', '203.0.113.9/31', '198.51.100.7/32', '0.0.0.0/0'];

/** Rows in display order. Exported for the browser tests' expectations of labels. */
export function subnetRows(info: SubnetInfo): ResultRow[] {
  const ip = formatIPv4;
  const roleNote = info.addressRole === 'network' ? 'This is the network address of the subnet.'
    : info.addressRole === 'broadcast' ? 'This is the broadcast address of the subnet, not a usable host address.' : undefined;
  const broadcast: ResultRow = info.broadcast === null
    ? { key: 'broadcast', label: 'Broadcast address', value: 'None', copy: null, note: info.kind === 'host' ? 'A /32 is a single address.' : 'A /31 point-to-point link has no broadcast address (RFC 3021).' }
    : { key: 'broadcast', label: 'Broadcast address', value: ip(info.broadcast) };
  const range = info.firstUsable === info.lastUsable ? ip(info.firstUsable) : `${ip(info.firstUsable)} - ${ip(info.lastUsable)}`;
  return [
    { key: 'cidr', label: 'Network (CIDR)', value: `${ip(info.network)}/${info.prefix}` },
    { key: 'address', label: 'Address', value: ip(info.address), note: roleNote },
    { key: 'network', label: 'Network address', value: ip(info.network), note: info.kind === 'point-to-point' ? 'Also a usable host address on a /31.' : undefined },
    broadcast,
    { key: 'mask', label: 'Subnet mask', value: ip(info.mask) },
    { key: 'wildcard', label: 'Wildcard mask', value: ip(info.wildcard) },
    { key: 'prefix', label: 'Prefix length', value: `/${info.prefix}` },
    { key: 'total', label: 'Total addresses', value: formatInteger(info.totalAddresses), copy: info.totalAddresses.toString() },
    { key: 'range', label: 'Usable host range', value: range },
    { key: 'usable', label: 'Usable hosts', value: formatInteger(info.usableHosts), copy: info.usableHosts.toString() },
  ];
}

function subnetJson(info: SubnetInfo): Record<string, unknown> {
  const ip = formatIPv4;
  return {
    cidr: `${ip(info.network)}/${info.prefix}`,
    address: ip(info.address),
    network: ip(info.network),
    broadcast: info.broadcast === null ? null : ip(info.broadcast),
    subnetMask: ip(info.mask),
    wildcardMask: ip(info.wildcard),
    prefixLength: info.prefix,
    totalAddresses: Number(info.totalAddresses),
    firstUsable: ip(info.firstUsable),
    lastUsable: ip(info.lastUsable),
    usableHosts: Number(info.usableHosts),
    kind: info.kind,
  };
}

function kindNotice(info: SubnetInfo): HTMLElement | null {
  if (info.kind === 'point-to-point') return notice('info', 'A /31 is a point-to-point link (RFC 3021): both addresses are usable, and no network or broadcast address is reserved.');
  if (info.kind === 'host') return notice('info', 'A /32 is a single host address, as used for host routes and loopback interfaces.');
  if (info.prefix === 0) return notice('info', 'A /0 covers the entire IPv4 address space.');
  return null;
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  const field = textField({
    id: 'subnet-input', label: 'IPv4 address and prefix', placeholder: '192.0.2.10/24', mono: true,
    hint: 'CIDR notation (192.0.2.10/24) or an address followed by a subnet mask (192.0.2.10 255.255.255.0).',
  });
  const input = field.control;
  let current: SubnetInfo | null = null;
  const resultBody = h('div', { class: 'result-area', id: 'subnet-result' });

  const copyAll = copyButton(services, () => current && subnetRows(current).map(r => `${r.label}: ${r.copy === undefined ? r.value : r.copy ?? r.value}`).join('\n'), 'all results', { label: 'Copy all' });
  const csvButton = button({
    label: 'CSV', icon: 'download', title: 'Download as CSV', onClick: () => {
      if (!current) return;
      const rows = subnetRows(current).map(r => [r.label, r.copy === undefined ? r.value : r.copy ?? r.value]);
      services.download(`subnet-${formatIPv4(current.network)}-${current.prefix}.csv`, toCsv([['Field', 'Value'], ...rows]), 'text/csv');
    },
  });
  const jsonButton = button({
    label: 'JSON', icon: 'download', title: 'Download as JSON', onClick: () => {
      if (!current) return;
      services.download(`subnet-${formatIPv4(current.network)}-${current.prefix}.json`, toJsonText(subnetJson(current)), 'application/json');
    },
  });
  const actions = [copyAll, csvButton, jsonButton];

  function update(): void {
    const text = input.value;
    current = null;
    if (text.trim() === '') {
      field.setError(null);
      replaceChildren(resultBody, emptyState('Enter an IPv4 address with a prefix length or mask to see its subnet.'));
    } else {
      const parsed = parseSubnetInput(text);
      if (!parsed.ok) {
        field.setError(parsed.error.message);
        replaceChildren(resultBody, emptyState('Fix the input to see results.'));
      } else {
        field.setError(null);
        current = calculateSubnet(parsed.value.address, parsed.value.prefix);
        replaceChildren(resultBody, kindNotice(current), resultTable('Subnet details', subnetRows(current), services));
      }
    }
    for (const b of actions) b.disabled = current === null;
  }

  input.addEventListener('input', update);
  const examples = h('div', { class: 'examples' }, h('span', null, 'Examples:'), EXAMPLES.map(example =>
    h('button', { type: 'button', class: 'chip', onclick: () => { input.value = example; update(); input.focus(); } }, example)));

  host.appendChild(toolPage(meta, categoryName,
    panel('Input', [field.root, examples]),
    panel('Result', [resultBody], actions, 'result-panel'),
  ));
  update();
}

