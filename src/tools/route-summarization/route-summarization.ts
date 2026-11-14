/** Route Summarization: networks in, the fewest exact routes out, with any broader supernet clearly separate. */
import { toJsonText } from '../../core/export/files';
import { formatInteger } from '../../core/format';
import { familyName, formatPrefix, prefixSize, prefixToRange, rangeSize } from '../../core/net/address';
import { summarizeRoutes, type RouteSummary } from '../../core/net/analysis';
import { parseNetworkList, type LineError } from '../../core/net/list';
import { routesCsv, routesJson } from '../../core/net/reports';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, dataTable, emptyState, notice, panel, problemList, textArea, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';

const EXAMPLE = [
  '172.16.0.0/24', '172.16.1.0/24', '172.16.2.0/24', '172.16.3.0/24', '172.16.5.0/24', '172.16.2.128/25', '172.16.1.0/24',
  '2001:db8:100::/48', '2001:db8:101::/48',
].join('\n');

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let summaries: RouteSummary[] = [];
  let errors: LineError[] = [];

  const listField = textArea({
    id: 'routes-input', label: 'Networks', mono: true, rows: 12, placeholder: '10.0.0.0/24\n10.0.1.0/24\n10.0.2.0/23\n2001:db8::/48',
    hint: 'One network per line in CIDR notation; single addresses and ranges work too. IPv4 and IPv6 are summarized separately. Text after # is ignored.',
  });
  const resultBody = h('div', { class: 'result-area', id: 'routes-result' });
  const allRoutes = () => (summaries.length ? summaries.flatMap(s => s.routes.map(formatPrefix)).join('\n') : null);
  const copyRoutes = copyButton(services, allRoutes, 'routes', { label: 'Copy routes' });
  const csvButton = button({ label: 'CSV', icon: 'download', title: 'Download the routes as CSV', onClick: () => { if (summaries.length) services.download('route-summary.csv', routesCsv(summaries), 'text/csv'); } });
  const jsonButton = button({ label: 'JSON', icon: 'download', title: 'Download the routes as JSON', onClick: () => { if (summaries.length) services.download('route-summary.json', toJsonText(routesJson(summaries)), 'application/json'); } });

  function familySection(s: RouteSummary): HTMLElement {
    const name = familyName(s.family);
    const removed = [s.duplicates ? `${s.duplicates} duplicate${s.duplicates === 1 ? '' : 's'}` : '', s.contained ? `${s.contained} contained in another entry` : ''].filter(Boolean).join(' and ');
    const id = `routes-v${s.family}`;
    return h('section', { class: 'route-family', id, 'aria-labelledby': `${id}-title` },
      h('h3', { class: 'sub-title', id: `${id}-title` }, `${name}: exact summary`),
      h('p', { class: 'status-line' }, `${formatInteger(s.inputCount)} ${s.inputCount === 1 ? 'entry' : 'entries'} become ${formatInteger(s.routes.length)} ${s.routes.length === 1 ? 'route' : 'routes'}, covering exactly the same ${formatInteger(s.addresses)} ${s.addresses === 1n ? 'address' : 'addresses'}.${removed ? ` Removed: ${removed}.` : ''}`),
      dataTable(`${name} routes`, [{ key: 'route', label: 'Route', mono: true }, { key: 'addresses', label: 'Addresses', numeric: true }],
        s.routes.map(p => ({ route: formatPrefix(p), addresses: formatInteger(rangeSize(prefixToRange(p))) })), `${id}-table`),
      h('div', { class: 'toolbar' }, copyButton(services, () => s.routes.map(formatPrefix).join('\n'), `${name} routes`, { label: `Copy ${name} routes` })),
      s.supernet ? notice('warning',
        h('p', null, h('strong', null, 'Broader supernet (not exact): '), h('span', { class: 'mono' }, formatPrefix(s.supernet.prefix))),
        h('p', null, `This single route covers every entry but also ${formatInteger(s.supernet.extraAddresses)} addresses that are not in your list (${(Number(s.supernet.extraAddresses) / Number(prefixSize(s.family, s.supernet.prefix.length)) * 100).toFixed(1)}% of it). Advertise it only if that extra space is yours to route.`),
      ) : null,
    );
  }

  function summarize(): void {
    const parsed = parseNetworkList(listField.control.value);
    errors = parsed.errors;
    listField.setError(errors.length ? `${errors.length} ${errors.length === 1 ? 'line has' : 'lines have'} a problem; see below.` : null);
    summaries = summarizeRoutes(parsed.entries);
    const problems = errors.length ? problemList('These lines could not be read and were left out:', errors.map(e => ({ where: `Line ${e.line}`, message: `${e.message} (${e.text})` }))) : null;
    replaceChildren(resultBody, problems, summaries.length === 0 ? (problems ? null : emptyState('Enter two or more networks to summarize, or load the example.')) : summaries.map(familySection));
    for (const b of [copyRoutes, csvButton, jsonButton]) b.disabled = summaries.length === 0;
  }

  listField.control.addEventListener('input', summarize);
  const exampleButton = button({ label: 'Example', variant: 'ghost', onClick: () => { listField.control.value = EXAMPLE; summarize(); } });
  const clearButton = button({ label: 'Clear', variant: 'ghost', onClick: () => { listField.control.value = ''; summarize(); listField.control.focus(); } });

  host.appendChild(toolPage(meta, categoryName,
    panel('Input', [listField.root], [exampleButton, clearButton]),
    panel('Summary', [resultBody], [copyRoutes, csvButton, jsonButton], 'result-panel'),
  ));
  summarize();
}
