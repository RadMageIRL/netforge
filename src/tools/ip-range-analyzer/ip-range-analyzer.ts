/** IP Range Analyzer: a list of networks, addresses and ranges in; duplicates, overlaps, gaps and a summary out. */
import { toJsonText } from '../../core/export/files';
import { formatInteger } from '../../core/format';
import { familyName, formatAddress, formatPrefix, formatRange, prefixToRange, rangeSize } from '../../core/net/address';
import { analyzeRanges, parseParent, type FindingKind, type RangeReport } from '../../core/net/analysis';
import { parseNetworkList, type LineError } from '../../core/net/list';
import { analysisCsv, analysisJson, findingNotes } from '../../core/net/reports';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, dataTable, emptyState, notice, panel, problemList, summaryTable, textArea, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';

const EXAMPLE = [
  '# Site A',
  '10.20.0.0/16',
  '10.20.4.0/24',
  '10.20.4.0/24',
  '10.20.250.0 - 10.21.0.31',
  '10.21.0.0/24',
  '192.168.10.0/25',
  '192.168.10.128/25',
  '2001:db8:20::/48',
  '2001:db8:20:5::/64',
].join('\n');

const FINDING_LABEL: Record<FindingKind, string> = { duplicate: 'Duplicate', contains: 'Contains', overlap: 'Overlap' };
const LIVE_LIMIT = 2000;

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let report: RangeReport | null = null;
  let errors: LineError[] = [];
  let timer = 0;

  const listField = textArea({
    id: 'ranges-input', label: 'Networks, addresses and ranges', mono: true, rows: 12, placeholder: '10.0.0.0/16\n10.0.5.0/24\n192.0.2.10 - 192.0.2.40\n2001:db8::/48',
    hint: 'One per line: a CIDR, a single address, or a range such as 10.0.0.1 - 10.0.0.50. IPv4 and IPv6 can be mixed; they are analyzed separately. Text after # is ignored.',
  });
  const parentField = textField({ id: 'ranges-parent', label: 'Parent network (optional)', placeholder: '10.20.0.0/15', mono: true, hint: 'Shows the space inside it that nothing in the list covers.' });
  const resultBody = h('div', { class: 'result-area', id: 'ranges-result' });

  const summaryText = () => report && report.families.length ? report.families.flatMap(f => f.summary.map(formatPrefix)).join('\n') : null;
  const copySummary = copyButton(services, summaryText, 'summarized ranges', { label: 'Copy summary' });
  const csvButton = button({ label: 'CSV', icon: 'download', title: 'Download the analysis as CSV', onClick: () => { if (report) services.download('ip-range-analysis.csv', analysisCsv(report), 'text/csv'); } });
  const jsonButton = button({ label: 'JSON', icon: 'download', title: 'Download the analysis as JSON', onClick: () => { if (report) services.download('ip-range-analysis.json', toJsonText(analysisJson(report, errors)), 'application/json'); } });

  function analyze(): void {
    window.clearTimeout(timer);
    const parsed = parseNetworkList(listField.control.value);
    errors = parsed.errors;
    const parent = parseParent(parentField.control.value);
    parentField.setError(parent.error);
    listField.setError(errors.length ? `${errors.length} ${errors.length === 1 ? 'line has' : 'lines have'} a problem; see below.` : null);
    if (parsed.entries.length === 0) {
      report = null;
      replaceChildren(resultBody, errors.length ? problemList('These lines could not be read:', errors.map(e => ({ where: `Line ${e.line}`, message: `${e.message} (${e.text})` }))) : emptyState('Enter one or more networks to analyze, or load the example.'));
      setActions();
      return;
    }
    report = analyzeRanges(parsed.entries, parent.prefix);
    render(report, parent.note);
    setActions();
  }

  function setActions(): void {
    for (const b of [copySummary, csvButton, jsonButton]) b.disabled = report === null;
  }

  function render(r: RangeReport, parentNote: string | null): void {
    const counts = (family: 4 | 6, kind: FindingKind) => r.findings.filter(f => f.kind === kind && f.a.family === family).length;
    const notes = findingNotes(r);
    replaceChildren(resultBody,
      errors.length ? problemList('These lines could not be read and were left out:', errors.map(e => ({ where: `Line ${e.line}`, message: `${e.message} (${e.text})` }))) : null,
      parentNote ? notice('info', parentNote) : null,
      h('h3', { class: 'sub-title' }, 'Overview'),
      dataTable('Overview by address family', [
        { key: 'family', label: 'Family' }, { key: 'entries', label: 'Entries', numeric: true }, { key: 'addresses', label: 'Addresses covered', numeric: true },
        { key: 'duplicates', label: 'Duplicates', numeric: true }, { key: 'contains', label: 'Containments', numeric: true }, { key: 'overlaps', label: 'Partial overlaps', numeric: true },
      ], r.families.map(f => ({
        family: familyName(f.family), entries: formatInteger(f.entries.length), addresses: formatInteger(f.totalAddresses),
        duplicates: formatInteger(counts(f.family, 'duplicate')), contains: formatInteger(counts(f.family, 'contains')), overlaps: formatInteger(counts(f.family, 'overlap')),
      })), 'ranges-overview'),
      h('h3', { class: 'sub-title' }, 'Findings'),
      r.findings.length === 0 ? notice('ok', 'No duplicates, containment or overlaps.') : dataTable('Findings', [
        { key: 'kind', label: 'Finding' }, { key: 'lineA', label: 'Line', numeric: true }, { key: 'a', label: 'Network', mono: true },
        { key: 'lineB', label: 'Line', numeric: true }, { key: 'b', label: 'Network', mono: true }, { key: 'shared', label: 'Shared addresses', mono: true },
      ], r.findings.map(f => ({ kind: FINDING_LABEL[f.kind], lineA: String(f.a.line), a: formatRange(f.a), lineB: String(f.b.line), b: formatRange(f.b), shared: formatRange(f.shared) })), 'ranges-findings'),
      r.omittedFindings ? notice('warning', `${formatInteger(r.omittedFindings)} more findings are not listed. They are counted in the overview.`) : null,
      r.parent ? [
        h('h3', { class: 'sub-title' }, `Gaps in ${formatPrefix(r.parent.prefix)}`),
        summaryTable('Parent coverage', [
          ['Covered', `${formatInteger(r.parent.coveredAddresses)} addresses`],
          ['Not covered', `${formatInteger(r.parent.gapAddresses)} addresses in ${formatInteger(r.parent.gaps.length)} ${r.parent.gaps.length === 1 ? 'block' : 'blocks'}`],
        ]),
        r.parent.gaps.length ? dataTable('Gaps', [{ key: 'network', label: 'Gap', mono: true }, { key: 'addresses', label: 'Addresses', numeric: true }],
          r.parent.gaps.map(p => ({ network: formatPrefix(p), addresses: formatInteger(rangeSize(prefixToRange(p))) })), 'ranges-gaps') : notice('ok', 'The list covers the whole parent.'),
        r.parent.outside.length ? notice('warning', `Not entirely inside the parent: ${r.parent.outside.map(e => `line ${e.line} (${formatRange(e)})`).join(', ')}.`) : null,
      ] : null,
      h('h3', { class: 'sub-title' }, 'Summarized'),
      h('p', { class: 'muted' }, 'The combined address space as the fewest exact CIDR blocks, with nothing added.'),
      dataTable('Summarized ranges', [{ key: 'family', label: 'Family' }, { key: 'network', label: 'Network', mono: true }, { key: 'addresses', label: 'Addresses', numeric: true }],
        r.families.flatMap(f => f.summary.map(p => ({ family: familyName(f.family), network: formatPrefix(p), addresses: formatInteger(rangeSize(prefixToRange(p))) }))), 'ranges-summary'),
      h('h3', { class: 'sub-title' }, 'Sorted entries'),
      dataTable('Entries sorted by address', [
        { key: 'line', label: 'Line', numeric: true }, { key: 'input', label: 'Input', mono: true }, { key: 'normalized', label: 'Normalized', mono: true },
        { key: 'first', label: 'First', mono: true }, { key: 'last', label: 'Last', mono: true }, { key: 'addresses', label: 'Addresses', numeric: true }, { key: 'notes', label: 'Notes' },
      ], r.families.flatMap(f => f.entries.map(e => ({
        line: String(e.line), input: e.text, normalized: formatRange(e), first: formatAddress(e.family, e.first), last: formatAddress(e.family, e.last),
        addresses: formatInteger(rangeSize(e)), notes: [e.hostBitsSet ? 'host bits set' : '', ...(notes.get(e.line) ?? [])].filter(Boolean).join('; '),
      }))), 'ranges-entries'),
    );
  }

  const schedule = () => {
    window.clearTimeout(timer);
    if (listField.control.value.split('\n').length <= LIVE_LIMIT) analyze();
    else timer = window.setTimeout(analyze, 300);
  };
  listField.control.addEventListener('input', schedule);
  parentField.control.addEventListener('input', schedule);

  const exampleButton = button({ label: 'Example', variant: 'ghost', onClick: () => { listField.control.value = EXAMPLE; parentField.control.value = '10.20.0.0/15'; analyze(); } });
  const clearButton = button({ label: 'Clear', variant: 'ghost', onClick: () => { listField.control.value = ''; parentField.control.value = ''; analyze(); listField.control.focus(); } });

  host.appendChild(toolPage(meta, categoryName,
    panel('Input', [listField.root, parentField.root], [exampleButton, clearButton]),
    panel('Analysis', [resultBody], [copySummary, csvButton, jsonButton], 'result-panel'),
  ));
  analyze();
}
