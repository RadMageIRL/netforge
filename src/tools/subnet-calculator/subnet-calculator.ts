/**
 * Subnet Calculator: an IPv4 or IPv6 address and prefix in, every property of the network out,
 * plus its address classification, equal splits and supernets. IPv4 is the default family and
 * behaves exactly as in Phase 0.
 */
import { toCsv } from '../../core/export/csv';
import { toJsonText } from '../../core/export/files';
import { formatInteger } from '../../core/format';
import { expandAddress, FAMILY_BITS, familyName, formatAddress, formatPrefix, parsePrefixText, prefixMask, prefixSize, prefixToRange, type Family, type IpPrefix } from '../../core/net/address';
import { blocksOverlapping, classifyAddress, PROPERTY_LABELS, type Classification, type Reachability } from '../../core/net/classify';
import { calculateSubnet, formatIPv4, parseSubnetInput, type SubnetInfo } from '../../core/net/ipv4';
import { formatIPv6 } from '../../core/net/ipv6';
import { splitPrefix, supernet } from '../../core/net/ops';
import { REGISTRY_SOURCES } from '../../core/net/registry-data';
import { prefixListCsv, prefixListJson } from '../../core/net/reports';
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { readSubnetShare, subnetOffer } from './subnet-share';
import { button, chipList, copyButton, dataTable, emptyState, notice, panel, resultTable, segmented, summaryTable, textField, toolPage, type ResultRow } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';

const EXAMPLES = ['192.168.1.130/26', '10.0.0.0/8', '172.16.5.4 255.255.240.0', '203.0.113.9/31', '198.51.100.7/32', '0.0.0.0/0'];
const EXAMPLES_V6 = ['2001:db8:abcd:12::1/64', '2001:db8::/32', 'fd12:3456:789a::/48', 'fe80::1/64', '2001:db8::a/127', '::ffff:192.0.2.1/128'];
const SPLIT_SHOWN = 256;
const SPLIT_EXPORT = 65_536;

const TEXT: Record<Family, { label: string; placeholder: string; hint: string; empty: string }> = {
  4: {
    label: 'IPv4 address and prefix', placeholder: '192.0.2.10/24',
    hint: 'CIDR notation (192.0.2.10/24) or an address followed by a subnet mask (192.0.2.10 255.255.255.0).',
    empty: 'Enter an IPv4 address with a prefix length or mask to see its subnet.',
  },
  6: {
    label: 'IPv6 address and prefix', placeholder: '2001:db8::1/64',
    hint: 'Any standard form, such as 2001:db8::1/64 or 2001:0DB8:0:0::/48. Results are written in the RFC 5952 canonical form.',
    empty: 'Enter an IPv6 address with a prefix length to see its prefix.',
  },
};

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

/** A count for display: exact digits while readable, otherwise a power of two. */
function bigCount(n: bigint): string {
  if (n < 10n ** 15n) return formatInteger(n);
  const exp = n.toString(2).length - 1;
  return n === 1n << BigInt(exp) ? `2^${exp}` : formatInteger(n);
}

/** IPv6 rows. No broadcast and no usable-host arithmetic: every address in a prefix is an address. */
export function ipv6Rows(prefix: IpPrefix, address: bigint, typed: string): ResultRow[] {
  const r = prefixToRange(prefix);
  const total = prefixSize(6, prefix.length);
  const canonical = formatIPv6(address);
  const rows: ResultRow[] = [
    { key: 'cidr', label: 'Network (CIDR)', value: formatPrefix(prefix) },
    { key: 'address', label: 'Address', value: canonical, note: typed.toLowerCase() !== canonical ? 'Written in the RFC 5952 canonical form.' : undefined },
    { key: 'address-expanded', label: 'Address (expanded)', value: expandAddress(6, address) },
    { key: 'network', label: 'Network address', value: formatIPv6(r.first) },
    { key: 'network-expanded', label: 'Network address (expanded)', value: expandAddress(6, r.first) },
    { key: 'last', label: 'Last address', value: formatIPv6(r.last) },
    { key: 'last-expanded', label: 'Last address (expanded)', value: expandAddress(6, r.last) },
    { key: 'prefix', label: 'Prefix length', value: `/${prefix.length}` },
    { key: 'mask', label: 'Prefix mask', value: formatIPv6(prefixMask(6, prefix.length)) },
    { key: 'total', label: 'Total addresses', value: formatInteger(total), copy: total.toString(), note: `2^${128 - prefix.length}` },
  ];
  if (prefix.length <= 64) {
    const count = 1n << BigInt(64 - prefix.length);
    rows.push({ key: 'subnets64', label: '/64 subnets', value: formatInteger(count), copy: count.toString() });
  }
  return rows;
}

function ipv6Json(prefix: IpPrefix, address: bigint): Record<string, unknown> {
  const r = prefixToRange(prefix);
  return {
    family: 'IPv6',
    cidr: formatPrefix(prefix),
    address: formatIPv6(address),
    addressExpanded: expandAddress(6, address),
    network: formatIPv6(r.first),
    networkExpanded: expandAddress(6, r.first),
    lastAddress: formatIPv6(r.last),
    lastAddressExpanded: expandAddress(6, r.last),
    prefixLength: prefix.length,
    prefixMask: formatIPv6(prefixMask(6, prefix.length)),
    totalAddresses: prefixSize(6, prefix.length).toString(),
    subnets64: prefix.length <= 64 ? (1n << BigInt(64 - prefix.length)).toString() : null,
  };
}

function kindNotice(info: SubnetInfo): HTMLElement | null {
  if (info.kind === 'point-to-point') return notice('info', 'A /31 is a point-to-point link (RFC 3021): both addresses are usable, and no network or broadcast address is reserved.');
  if (info.kind === 'host') return notice('info', 'A /32 is a single host address, as used for host routes and loopback interfaces.');
  if (info.prefix === 0) return notice('info', 'A /0 covers the entire IPv4 address space.');
  return null;
}

function ipv6Notice(prefix: IpPrefix): HTMLElement {
  if (prefix.length === 128) return notice('info', 'A /128 is a single address, as used for loopbacks and host routes.');
  if (prefix.length === 127) return notice('info', 'A /127 is the recommended prefix for point-to-point links between routers (RFC 6164).');
  return notice('info', 'IPv6 has no broadcast address, and NetForge does not subtract unusable addresses. The all-zeros interface ID is the Subnet-Router anycast address (RFC 4291 section 2.6.1), and RFC 2526 reserves the highest 128 interface IDs of each /64 for subnet anycast, so plan host numbering around them.');
}

const REACH_LABEL: Record<Reachability, string> = {
  'true': 'Yes', 'false': 'No', 'n/a': 'Not applicable', 'unspecified': 'Not stated', 'not-listed': 'Not listed',
};

function propertyLabels(c: Classification): string[] {
  return c.properties.map(p => PROPERTY_LABELS[p]);
}

function classificationView(c: Classification, prefix: IpPrefix): HTMLElement {
  const source = c.family === 4 ? REGISTRY_SOURCES.ipv4Special : REGISTRY_SOURCES.ipv6Special;
  const labels = propertyLabels(c);
  const facts: [string, string][] = [['Globally reachable (registry)', REACH_LABEL[c.globallyReachable]]];
  if (c.addressSpace) facts.push(['IPv6 address space', `${c.addressSpace.allocation} (${c.addressSpace.block})`]);
  if (c.multicastScope) facts.push(['Multicast scope', c.multicastScope]);
  if (c.embeddedIPv4) {
    const inner = propertyLabels(c.embeddedIPv4);
    facts.push(['Embedded IPv4 address', `${formatIPv4(c.value & 0xffffffffn)}: ${inner.length ? inner.join(', ') : 'ordinary unicast'}`]);
  }
  const flag = (f: string) => ({ true: 'Yes', false: 'No', 'n/a': 'N/A', unspecified: '' } as Record<string, string>)[f] ?? f;
  const inside = blocksOverlapping(prefix).filter(b => b.relation !== 'contains-prefix' && !c.matches.includes(b.block));
  const notes = [...new Set(c.matches.flatMap(m => m.notes))];
  return h('div', { class: 'result-area', id: 'class-result' },
    h('p', { class: 'class-address' }, 'Address ', h('span', { class: 'mono' }, formatAddress(c.family, c.value))),
    labels.length ? chipList(labels, 'Properties') : h('p', { class: 'muted' }, 'No special-purpose properties.'),
    summaryTable('Classification facts', facts),
    h('p', { class: 'reach-note' }, c.reachabilityNote),
    c.matches.length ? dataTable('Matching special-purpose blocks', [
      { key: 'block', label: 'Block', mono: true }, { key: 'name', label: 'Name' }, { key: 'rfc', label: 'Reference' }, { key: 'allocated', label: 'Allocated' },
      { key: 'global', label: 'Globally reachable' }, { key: 'source', label: 'Source' }, { key: 'destination', label: 'Destination' },
      { key: 'forwardable', label: 'Forwardable' }, { key: 'reserved', label: 'Reserved by protocol' },
    ], c.matches.map(m => ({
      block: m.block, name: m.name, rfc: m.rfc, allocated: m.terminated ? `${m.allocated} (ended ${m.terminated})` : m.allocated,
      global: flag(m.globallyReachable), source: flag(m.source), destination: flag(m.destination), forwardable: flag(m.forwardable), reserved: flag(m.reservedByProtocol),
    })), 'class-matches') : null,
    notes.length ? h('ul', { class: 'registry-notes' }, notes.map(n => h('li', null, `Registry note: ${n}`))) : null,
    inside.length ? h('div', null,
      h('h3', { class: 'sub-title' }, `Special-purpose blocks inside ${formatPrefix(prefix)}`),
      dataTable('Special-purpose blocks inside this prefix', [{ key: 'block', label: 'Block', mono: true }, { key: 'name', label: 'Name' }, { key: 'global', label: 'Globally reachable' }],
        inside.map(b => ({ block: b.block.block, name: b.block.name, global: flag(b.block.globallyReachable) }))),
    ) : null,
    h('p', { class: 'source-note' }, `Source: IANA ${familyName(c.family)} Special-Purpose Address Registry, updated ${source.updated}, bundled with NetForge on ${source.retrieved}. ${source.url}`),
  );
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  let family: Family = 4;
  const values: Record<Family, string> = { 4: '', 6: '' };
  const field = textField({ id: 'subnet-input', label: TEXT[4].label, placeholder: TEXT[4].placeholder, mono: true, hint: TEXT[4].hint });
  const input = field.control;
  const labelEl = field.root.querySelector('label')!;
  const hintEl = field.root.querySelector('.hint')!;

  type Current = { family: 4; info: SubnetInfo; prefix: IpPrefix; address: bigint } | { family: 6; prefix: IpPrefix; address: bigint; typed: string };
  let current: Current | null = null;
  const resultBody = h('div', { class: 'result-area', id: 'subnet-result' });
  const classBody = h('div');
  const classPanel = panel('Address classification', [classBody], undefined, 'class-panel');

  const rowsFor = (c: Current) => (c.family === 4 ? subnetRows(c.info) : ipv6Rows(c.prefix, c.address, c.typed));
  const fileBase = (c: Current) => (c.family === 4 ? `subnet-${formatIPv4(c.info.network)}-${c.info.prefix}` : `subnet-${formatIPv6(c.prefix.network).split(':').join('-')}-${c.prefix.length}`);

  const copyAll = copyButton(services, () => current && rowsFor(current).map(r => `${r.label}: ${r.copy === undefined ? r.value : r.copy ?? r.value}`).join('\n'), 'all results', { label: 'Copy all' });
  const csvButton = button({
    label: 'CSV', icon: 'download', title: 'Download as CSV', onClick: () => {
      if (!current) return;
      const rows = rowsFor(current).map(r => [r.label, r.copy === undefined ? r.value : r.copy ?? r.value]);
      services.download(`${fileBase(current)}.csv`, toCsv([['Field', 'Value'], ...rows]), 'text/csv');
    },
  });
  const jsonButton = button({
    label: 'JSON', icon: 'download', title: 'Download as JSON', onClick: () => {
      if (!current) return;
      services.download(`${fileBase(current)}.json`, toJsonText(current.family === 4 ? subnetJson(current.info) : ipv6Json(current.prefix, current.address)), 'application/json');
    },
  });
  const actions = [copyAll, csvButton, jsonButton];

  // ---- Split and supernet (collapsible) ----------------------------------------------------
  const splitSelect = h('select', { class: 'select', id: 'split-length' });
  const splitBody = h('div', { class: 'result-area', id: 'split-result' });
  let splitSubnets: IpPrefix[] = [];
  const splitCopy = copyButton(services, () => (splitSubnets.length ? splitSubnets.map(formatPrefix).join('\n') : null), 'subnet list', { label: 'Copy list' });
  const splitCsv = button({ label: 'CSV', icon: 'download', title: 'Download the subnets as CSV', onClick: () => exportSplit('csv') });
  const splitJson = button({ label: 'JSON', icon: 'download', title: 'Download the subnets as JSON', onClick: () => exportSplit('json') });
  const splitPanel = h('details', { class: 'panel disclosure', id: 'split-panel' },
    h('summary', { class: 'disclosure-summary' }, 'Split into equal subnets'),
    h('div', { class: 'panel-body' },
      h('div', { class: 'controls-row' }, h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'split-length' }, 'Split into'), splitSelect), h('div', { class: 'toolbar' }, splitCopy, splitCsv, splitJson)),
      splitBody,
    ),
  );
  const superSelect = h('select', { class: 'select', id: 'supernet-length' });
  const superBody = h('div', { class: 'result-area', id: 'supernet-result' });
  let superText: string | null = null;
  const superCopy = copyButton(services, () => superText, 'supernet', { label: 'Copy supernet' });
  const superPanel = h('details', { class: 'panel disclosure', id: 'supernet-panel' },
    h('summary', { class: 'disclosure-summary' }, 'Find a supernet'),
    h('div', { class: 'panel-body' },
      h('div', { class: 'controls-row' }, h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'supernet-length' }, 'Supernet at'), superSelect), h('div', { class: 'toolbar' }, superCopy)),
      superBody,
    ),
  );

  function exportSplit(kind: 'csv' | 'json'): void {
    if (!current) return;
    const length = Number(splitSelect.value);
    const { total, subnets } = splitPrefix(current.prefix, length, 0n, SPLIT_EXPORT);
    const name = `${fileBase(current)}-split-${length}`;
    if (kind === 'csv') services.download(`${name}.csv`, prefixListCsv(subnets), 'text/csv');
    else services.download(`${name}.json`, toJsonText({ network: formatPrefix(current.prefix), splitInto: length, totalSubnets: total.toString(), exported: subnets.length, subnets: prefixListJson(subnets) }), 'application/json');
  }

  function fillSelect(select: HTMLSelectElement, lengths: number[], wanted: number, label: (n: number) => string): void {
    const keep = lengths.includes(Number(select.value)) && select.options.length > 0 ? Number(select.value) : wanted;
    replaceChildren(select, lengths.map(n => h('option', { value: String(n) }, label(n))));
    select.value = String(lengths.includes(keep) ? keep : wanted);
  }

  function renderSplit(): void {
    splitSubnets = [];
    if (!current) return;
    const p = current.prefix;
    const bits = FAMILY_BITS[p.family];
    const lengths = Array.from({ length: bits - p.length }, (_v, i) => p.length + 1 + i);
    splitSelect.disabled = lengths.length === 0;
    [splitCopy, splitCsv, splitJson].forEach(b => { b.disabled = lengths.length === 0; });
    if (lengths.length === 0) {
      replaceChildren(splitSelect);
      replaceChildren(splitBody, emptyState(`A /${bits} is a single address and cannot be split.`));
      return;
    }
    const wanted = p.family === 6 && p.length < 64 ? 64 : p.length + 1;
    fillSelect(splitSelect, lengths, wanted, n => `/${n}: ${bigCount(1n << BigInt(n - p.length))} subnets of ${bigCount(prefixSize(p.family, n))} ${prefixSize(p.family, n) === 1n ? 'address' : 'addresses'}`);
    const length = Number(splitSelect.value);
    const { total, subnets } = splitPrefix(p, length, 0n, SPLIT_SHOWN);
    splitSubnets = subnets;
    const shown = total > BigInt(SPLIT_SHOWN) ? `Showing the first ${SPLIT_SHOWN} of ${formatInteger(total)}. Downloads include the first ${formatInteger(SPLIT_EXPORT < total ? BigInt(SPLIT_EXPORT) : total)}.` : null;
    replaceChildren(splitBody,
      h('p', { class: 'status-line' }, `${formatPrefix(p)} splits into ${formatInteger(total)} ${total === 1n ? 'subnet' : 'subnets'} of /${length}.`),
      shown ? notice('info', shown) : null,
      dataTable(`Subnets of ${formatPrefix(p)}`, [{ key: 'network', label: 'Subnet', mono: true }, { key: 'first', label: 'First address', mono: true }, { key: 'last', label: 'Last address', mono: true }],
        subnets.map(s => { const r = prefixToRange(s); return { network: formatPrefix(s), first: formatAddress(s.family, r.first), last: formatAddress(s.family, r.last) }; }), 'split-table'),
    );
  }

  function renderSupernet(): void {
    superText = null;
    if (!current) return;
    const p = current.prefix;
    superSelect.disabled = p.length === 0;
    superCopy.disabled = p.length === 0;
    if (p.length === 0) {
      replaceChildren(superSelect);
      replaceChildren(superBody, emptyState('A /0 is the whole address space and has no supernet.'));
      return;
    }
    fillSelect(superSelect, Array.from({ length: p.length }, (_v, i) => p.length - 1 - i), p.length - 1, n => `/${n}`);
    const length = Number(superSelect.value);
    const s = supernet(p, length);
    const r = prefixToRange(s);
    superText = formatPrefix(s);
    replaceChildren(superBody, summaryTable('Supernet', [
      ['Supernet', formatPrefix(s)],
      ['First address', formatAddress(s.family, r.first)],
      ['Last address', formatAddress(s.family, r.last)],
      ['Addresses', formatInteger(prefixSize(s.family, length))],
      ['Contains', `${formatInteger(1n << BigInt(p.length - length))} networks the size of /${p.length}`],
    ]));
  }

  splitSelect.addEventListener('change', renderSplit);
  superSelect.addEventListener('change', renderSupernet);

  // ---- Main calculation --------------------------------------------------------------------
  function switchTo(next: Family, carry?: string): void {
    values[family] = input.value;
    family = next;
    familyControl.set(String(next));
    if (carry !== undefined) values[next] = carry;
    input.value = values[next];
    labelEl.textContent = TEXT[next].label;
    input.placeholder = TEXT[next].placeholder;
    hintEl.textContent = TEXT[next].hint;
    renderExamples();
    update();
  }

  function familyError(message: string, other: Family): void {
    field.setError(message);
    replaceChildren(resultBody,
      emptyState('Fix the input to see results.'),
      h('p', null, button({ label: `Switch to ${familyName(other)}`, variant: 'secondary', onClick: () => { switchTo(other, input.value); input.focus(); } })),
    );
  }

  function update(): void {
    const text = input.value;
    current = null;
    if (text.trim() === '') {
      field.setError(null);
      replaceChildren(resultBody, emptyState(TEXT[family].empty));
    } else if (family === 4) {
      const parsed = parseSubnetInput(text);
      if (!parsed.ok) {
        if (parsed.error.code === 'ipv6') familyError(parsed.error.message, 6);
        else {
          field.setError(parsed.error.message);
          replaceChildren(resultBody, emptyState('Fix the input to see results.'));
        }
      } else {
        field.setError(null);
        const info = calculateSubnet(parsed.value.address, parsed.value.prefix);
        current = { family: 4, info, prefix: { family: 4, network: info.network, length: info.prefix }, address: info.address };
        replaceChildren(resultBody, kindNotice(info), resultTable('Subnet details', subnetRows(info), services));
      }
    } else {
      const parsed = parsePrefixText(text, 6);
      if (!parsed.ok) {
        if (parsed.error.code === 'wrong-family') familyError(parsed.error.message, 4);
        else {
          field.setError(parsed.error.message);
          replaceChildren(resultBody, emptyState('Fix the input to see results.'));
        }
      } else {
        field.setError(null);
        const typed = text.trim().split('/')[0].trim();
        current = { family: 6, prefix: parsed.value.prefix, address: parsed.value.address, typed };
        replaceChildren(resultBody, ipv6Notice(parsed.value.prefix), resultTable('Prefix details', ipv6Rows(parsed.value.prefix, parsed.value.address, typed), services));
      }
    }
    for (const b of actions) b.disabled = current === null;
    classPanel.hidden = splitPanel.hidden = superPanel.hidden = current === null;
    if (current) replaceChildren(classBody, classificationView(classifyAddress(current.family, current.address), current.prefix));
    renderSplit();
    renderSupernet();
  }

  const familyControl = segmented({
    label: 'Address family', name: 'subnet-family', value: '4',
    choices: [{ value: '4', label: 'IPv4' }, { value: '6', label: 'IPv6' }],
    onChange: value => switchTo(value === '6' ? 6 : 4),
  });

  input.addEventListener('input', update);
  const examples = h('div', { class: 'examples' });
  function renderExamples(): void {
    replaceChildren(examples, h('span', null, 'Examples:'), (family === 4 ? EXAMPLES : EXAMPLES_V6).map(example =>
      h('button', { type: 'button', class: 'chip', onclick: () => { input.value = example; update(); input.focus(); } }, example)));
  }
  renderExamples();

  host.appendChild(toolPage(meta, categoryName,
    panel('Input', [familyControl.root, field.root, examples]),
    panel('Result', [resultBody], actions, 'result-panel'),
    classPanel,
    splitPanel,
    superPanel,
  ));
  update();

  return {
    share: {
      // The split and supernet lengths go in only when their panels are open: those are the ones chosen.
      offer: () => subnetOffer(family, input.value,
        splitPanel.open && !splitSelect.disabled ? Number(splitSelect.value) : null,
        superPanel.open && !superSelect.disabled ? Number(superSelect.value) : null),
      apply(params) {
        const s = readSubnetShare(params);
        if (!s) return false;
        switchTo(s.family, s.text);
        if (s.split !== null) {
          splitSelect.value = String(s.split);
          renderSplit();
          splitPanel.open = true;
        }
        if (s.supernet !== null) {
          superSelect.value = String(s.supernet);
          renderSupernet();
          superPanel.open = true;
        }
        return true;
      },
    },
  };
}

