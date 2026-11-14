/** VLSM Allocator: a parent IPv4 network and named host-count requests in, a non-overlapping plan out. */
import { toJsonText } from '../../core/export/files';
import { formatInteger } from '../../core/format';
import { formatPrefix, formatRange, prefixMask, prefixToRange, rangeSize } from '../../core/net/address';
import { formatIPv4 } from '../../core/net/ipv4';
import { vlsmCsv, vlsmJson } from '../../core/net/reports';
import { allocateVlsm, type VlsmBlock, type VlsmResult, type VlsmSection } from '../../core/net/vlsm';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, copyButton, dataTable, emptyState, notice, panel, problemList, summaryTable, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { rowEditor, type RowEditor } from '../../ui/row-editor';

const EXAMPLE = {
  parent: '10.40.0.0/16',
  requests: [
    { name: 'Servers', hosts: '400' }, { name: 'Clients', hosts: '1000' }, { name: 'Voice', hosts: '350' },
    { name: 'Cameras', hosts: '120' }, { name: 'Printers', hosts: '80' }, { name: 'Management', hosts: '30' },
  ],
};

const KIND_LABEL: Record<VlsmBlock['kind'], string> = { request: 'Request', fixed: 'Fixed', reserved: 'Reserved' };
const pct = (part: bigint | number, whole: bigint | number) => (Number(whole) === 0 ? '0%' : `${(Number(part) / Number(whole) * 100).toFixed(1)}%`);

function tableText(result: VlsmResult): string {
  const rows = [['Name', 'Type', 'Network', 'Subnet mask', 'Usable range', 'Requested hosts', 'Host capacity']];
  for (const b of result.blocks) {
    rows.push([
      b.name, KIND_LABEL[b.kind], b.prefix ? formatPrefix(b.prefix) : formatRange(b.range), b.prefix ? formatIPv4(prefixMask(4, b.prefix.length)) : '',
      b.firstUsable === null ? '' : `${formatIPv4(b.firstUsable)} - ${formatIPv4(b.lastUsable!)}`, b.requestedHosts?.toString() ?? '', b.hostCapacity?.toString() ?? '',
    ]);
  }
  return rows.map(r => r.join(String.fromCharCode(9))).join('\n');
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let pointToPoint = false;
  let result: VlsmResult | null = null;
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 120);
  };

  const parentField = textField({ id: 'vlsm-parent', label: 'Parent network', placeholder: '10.40.0.0/16', mono: true, hint: 'The IPv4 block to divide, in CIDR notation or with a subnet mask.' });
  parentField.control.addEventListener('input', schedule);
  const p2p = checkbox({ id: 'vlsm-p2p', label: 'Use /31 for 2-host and /32 for 1-host requests (RFC 3021 point-to-point)', onChange: value => { pointToPoint = value; update(); } });

  const requests = rowEditor({
    id: 'vlsm-requests', label: 'Requests', rowNoun: 'request', addLabel: 'Add request', initialRows: 3, onChange: schedule,
    description: 'Each request gets the smallest subnet with at least that many usable hosts. Normally a subnet loses its network and broadcast addresses.',
    columns: [{ key: 'name', label: 'Name', placeholder: 'Servers' }, { key: 'hosts', label: 'Hosts', placeholder: '400', numeric: true, mono: true }],
  });
  const fixed = rowEditor({
    id: 'vlsm-fixed', label: 'Fixed allocations (optional)', rowNoun: 'fixed allocation', addLabel: 'Add fixed allocation', initialRows: 1, onChange: schedule,
    description: 'Networks that already exist. They are kept exactly where they are.',
    columns: [{ key: 'name', label: 'Name', placeholder: 'Existing DMZ' }, { key: 'network', label: 'Network', placeholder: '10.40.200.0/24', mono: true }],
  });
  const reserved = rowEditor({
    id: 'vlsm-reserved', label: 'Reserved ranges (optional)', rowNoun: 'reserved range', addLabel: 'Add reserved range', initialRows: 1, onChange: schedule,
    description: 'Space to leave alone: a CIDR, an address, or a range such as 10.40.0.1 - 10.40.0.20.',
    columns: [{ key: 'name', label: 'Label', placeholder: 'Gateways' }, { key: 'range', label: 'Range', placeholder: '10.40.0.1 - 10.40.0.20', mono: true }],
  });

  const resultBody = h('div', { class: 'result-area', id: 'vlsm-result' });
  const copyTable = copyButton(services, () => (result && result.summary ? tableText(result) : null), 'allocation table', { label: 'Copy table' });
  const csvButton = button({ label: 'CSV', icon: 'download', title: 'Download the plan as CSV', onClick: () => { if (result?.summary) services.download(`vlsm-${fileName(result)}.csv`, vlsmCsv(result), 'text/csv'); } });
  const jsonButton = button({ label: 'JSON', icon: 'download', title: 'Download the plan as JSON', onClick: () => { if (result?.summary) services.download(`vlsm-${fileName(result)}.json`, toJsonText(vlsmJson(result)), 'application/json'); } });
  const fileName = (r: VlsmResult) => (r.parent ? formatPrefix(r.parent).replace('/', '-') : 'plan');

  const editors: Record<Exclude<VlsmSection, 'parent'>, RowEditor> = { requests, fixed, reserved };
  const SECTION_LABEL: Record<VlsmSection, string> = { parent: 'Parent network', requests: 'Request', fixed: 'Fixed allocation', reserved: 'Reserved range' };

  function nonEmpty(rows: Record<string, string>[]): { rows: Record<string, string>[]; map: number[] } {
    const map: number[] = [];
    const kept = rows.filter((row, i) => {
      const used = Object.values(row).some(v => v.trim() !== '');
      if (used) map.push(i);
      return used;
    });
    return { rows: kept, map };
  }

  function update(): void {
    window.clearTimeout(timer);
    for (const e of Object.values(editors)) e.clearErrors();
    parentField.setError(null);
    const req = nonEmpty(requests.rows());
    const fix = nonEmpty(fixed.rows());
    const res = nonEmpty(reserved.rows());
    const maps: Record<Exclude<VlsmSection, 'parent'>, number[]> = { requests: req.map, fixed: fix.map, reserved: res.map };
    if (parentField.control.value.trim() === '' && req.rows.length === 0) {
      result = null;
      replaceChildren(resultBody, emptyState('Enter a parent network and at least one request, or load the example.'));
      setActions();
      return;
    }
    result = allocateVlsm({
      parent: parentField.control.value,
      requests: req.rows.map(r => ({ name: r.name, hosts: r.hosts })),
      fixed: fix.rows.map(r => ({ name: r.name, network: r.network })),
      reserved: res.rows.map(r => ({ name: r.name, range: r.range })),
      pointToPoint,
    });
    if (result.issues.length > 0) {
      const perRow = new Map<string, string[]>();
      for (const issue of result.issues) {
        if (issue.section === 'parent') parentField.setError(issue.detail);
        else {
          const key = `${issue.section}:${maps[issue.section][issue.index]}`;
          perRow.set(key, [...(perRow.get(key) ?? []), issue.detail]);
        }
      }
      for (const [key, messages] of perRow) {
        const [section, row] = key.split(':') as [Exclude<VlsmSection, 'parent'>, string];
        editors[section].setRowError(Number(row), messages.join(' '));
      }
      replaceChildren(resultBody, problemList('Fix these before allocating:', result.issues.map(i => ({
        where: i.section === 'parent' ? SECTION_LABEL.parent : `${SECTION_LABEL[i.section]} ${maps[i.section as Exclude<VlsmSection, 'parent'>][i.index] + 1}`,
        message: i.detail,
      }))));
      setActions();
      return;
    }
    renderResult(result);
    setActions();
  }

  function setActions(): void {
    const ready = !!result?.summary;
    for (const b of [copyTable, csvButton, jsonButton]) b.disabled = !ready;
  }

  function renderResult(r: VlsmResult): void {
    const s = r.summary!;
    const used = s.allocatedAddresses + s.fixedAddresses + s.reservedAddresses;
    replaceChildren(resultBody,
      r.notes.map(n => notice('info', n)),
      r.failures.length ? notice('error',
        h('p', null, h('strong', null, `${r.failures.length} ${r.failures.length === 1 ? 'request does' : 'requests do'} not fit.`)),
        h('ul', { class: 'problem-list' }, r.failures.map(f => h('li', null, f.message))),
      ) : notice('ok', `All ${r.order.length} ${r.order.length === 1 ? 'request was' : 'requests were'} placed in ${formatPrefix(r.parent!)}.`),
      dataTable('Allocations in address order', [
        { key: 'name', label: 'Name' }, { key: 'kind', label: 'Type' }, { key: 'network', label: 'Network', mono: true }, { key: 'mask', label: 'Subnet mask', mono: true },
        { key: 'usable', label: 'Usable range', mono: true }, { key: 'requested', label: 'Requested', numeric: true }, { key: 'capacity', label: 'Capacity', numeric: true },
        { key: 'fill', label: 'Used', numeric: true },
      ], r.blocks.map(b => ({
        name: b.name, kind: KIND_LABEL[b.kind], network: b.prefix ? formatPrefix(b.prefix) : formatRange(b.range),
        mask: b.prefix ? formatIPv4(prefixMask(4, b.prefix.length)) : '',
        usable: b.firstUsable === null ? '' : b.firstUsable === b.lastUsable ? formatIPv4(b.firstUsable) : `${formatIPv4(b.firstUsable)} - ${formatIPv4(b.lastUsable!)}`,
        requested: b.requestedHosts === null ? '' : formatInteger(b.requestedHosts),
        capacity: b.hostCapacity === null ? '' : formatInteger(b.hostCapacity),
        fill: b.requestedHosts === null ? '' : pct(b.requestedHosts, b.hostCapacity!),
      })), 'vlsm-table'),
      h('h3', { class: 'sub-title' }, 'Utilization'),
      summaryTable('Utilization', [
        ['Parent network', `${formatPrefix(r.parent!)} (${formatInteger(s.parentAddresses)} addresses)`],
        ['Allocated to requests', `${formatInteger(s.allocatedAddresses)} addresses (${pct(s.allocatedAddresses, s.parentAddresses)})`],
        ['Fixed allocations', `${formatInteger(s.fixedAddresses)} addresses`],
        ['Reserved', `${formatInteger(s.reservedAddresses)} addresses`],
        ['Free', `${formatInteger(s.freeAddresses)} addresses (${pct(s.freeAddresses, s.parentAddresses)})`],
        ['Parent in use', pct(used, s.parentAddresses)],
        ['Requested hosts / capacity', `${formatInteger(s.requestedHosts)} of ${formatInteger(s.hostCapacity)} (${pct(s.requestedHosts, s.hostCapacity)})`],
      ]),
      h('h3', { class: 'sub-title' }, 'Unallocated space'),
      r.free.length === 0 ? emptyState('None: the parent is fully used.') : dataTable('Unallocated space', [
        { key: 'network', label: 'Free block', mono: true }, { key: 'addresses', label: 'Addresses', numeric: true },
      ], r.free.map(p => ({ network: formatPrefix(p), addresses: formatInteger(rangeSize(prefixToRange(p))) })), 'vlsm-free'),
      h('p', { class: 'source-note' }, 'Placement: largest block first (equal blocks by requested hosts, then in the order entered), each at the lowest free address aligned to its size.'),
    );
  }

  const exampleButton = button({ label: 'Example', variant: 'ghost', onClick: () => {
    parentField.control.value = EXAMPLE.parent;
    requests.setRows(EXAMPLE.requests);
    fixed.setRows([]);
    reserved.setRows([]);
    update();
  } });
  const clearButton = button({ label: 'Clear', variant: 'ghost', onClick: () => {
    parentField.control.value = '';
    requests.setRows([{}, {}, {}]);
    fixed.setRows([]);
    reserved.setRows([]);
    update();
    parentField.control.focus();
  } });

  host.appendChild(toolPage(meta, categoryName,
    panel('Plan', [parentField.root, p2p.root, requests.root], [exampleButton, clearButton]),
    panel('Constraints', [fixed.root, reserved.root]),
    panel('Allocation', [resultBody], [copyTable, csvButton, jsonButton], 'result-panel'),
  ));
  update();
}
