/** IP Range Analyzer and Route Summarization logic, and the CSV/JSON exports of every network tool. */
import { describe, expect, it } from 'vitest';
import { formatPrefix, formatRange, parsePrefixText, type IpPrefix } from '../../src/core/net/address';
import { analyzeRanges, parseParent, summarizeRoutes } from '../../src/core/net/analysis';
import { parseNetworkList } from '../../src/core/net/list';
import { splitPrefix } from '../../src/core/net/ops';
import { analysisCsv, analysisJson, prefixListCsv, prefixListJson, routesCsv, routesJson, vlsmCsv, vlsmJson } from '../../src/core/net/reports';
import { allocateVlsm } from '../../src/core/net/vlsm';

const CRLF = String.fromCharCode(13, 10);
const lines = (...rows: string[]) => rows.join(CRLF) + CRLF;

function prefix(text: string): IpPrefix {
  const r = parsePrefixText(text);
  if (!r.ok) throw new Error('setup');
  return r.value.prefix;
}

const SAMPLE = [
  '10.0.0.0/16', //                     1
  '10.0.5.0/24', //                     2: inside 1
  '10.0.5.0/24', //                     3: same as 2
  '10.1.0.0 - 10.1.0.255', //           4
  '10.0.255.0 - 10.1.0.10', //          5: overlaps 1 and 4
  '2001:db8::/48', //                   6
  '2001:db8:0:1::/64', //               7: inside 6
].join('\n');

describe('analyzeRanges', () => {
  const { entries, errors } = parseNetworkList(SAMPLE);
  const report = analyzeRanges(entries, prefix('10.0.0.0/15'));

  it('finds duplicates, containment and partial overlaps, once per pair', () => {
    expect(errors).toEqual([]);
    expect(report.findings.map(f => [f.kind, f.a.line, f.b.line, formatRange(f.shared)])).toEqual([
      ['contains', 1, 2, '10.0.5.0/24'],
      ['contains', 1, 3, '10.0.5.0/24'],
      ['overlap', 1, 5, '10.0.255.0/24'],
      ['duplicate', 2, 3, '10.0.5.0/24'],
      ['overlap', 5, 4, '10.1.0.0 - 10.1.0.10'],
      ['contains', 6, 7, '2001:db8:0:1::/64'],
    ]);
  });

  it('sorts each family and summarizes it exactly', () => {
    expect(report.families.map(f => f.family)).toEqual([4, 6]);
    expect(report.families[0].entries.map(e => e.line)).toEqual([1, 2, 3, 5, 4]);
    expect(report.families[0].summary.map(formatPrefix)).toEqual(['10.0.0.0/16', '10.1.0.0/24']);
    expect(report.families[0].totalAddresses).toBe(65792n);
    expect(report.families[1].summary.map(formatPrefix)).toEqual(['2001:db8::/48']);
  });

  it('finds the gaps in the parent and the entries outside it', () => {
    expect(report.parent!.gaps.map(formatPrefix)).toEqual([
      '10.1.1.0/24', '10.1.2.0/23', '10.1.4.0/22', '10.1.8.0/21', '10.1.16.0/20', '10.1.32.0/19', '10.1.64.0/18', '10.1.128.0/17',
    ]);
    expect(report.parent!.gapAddresses).toBe(131072n - 65792n);
    expect(report.parent!.coveredAddresses).toBe(65792n);
    expect(report.parent!.outside.map(e => e.line)).toEqual([6, 7]);
  });

  it('counts entries that are only partly inside the parent as outside', () => {
    const r = analyzeRanges(entries, prefix('10.0.0.0/16'));
    expect(r.parent!.outside.map(e => e.line)).toEqual([4, 5, 6, 7]);
    expect(r.parent!.gaps).toEqual([]);
  });

  it('caps the findings list and counts the rest', () => {
    const many = parseNetworkList(Array.from({ length: 10 }, () => '10.0.0.0/24').join('\n')).entries;
    const r = analyzeRanges(many, null, 5);
    expect(r.findings).toHaveLength(5);
    expect(r.omittedFindings).toBe(40);
  });

  it('reads the optional parent', () => {
    expect(parseParent('')).toEqual({ prefix: null, error: null, note: null });
    expect(parseParent('10.0.5.0/16').note).toContain('10.0.0.0/16');
    expect(parseParent('10.0.0.0').error).toContain('prefix length');
  });
});

describe('summarizeRoutes', () => {
  const routes = summarizeRoutes(parseNetworkList(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24', '10.0.4.0/24', '10.0.1.0/24', '10.0.2.128/25', '2001:db8::/33', '2001:db8:8000::/33'].join('\n')).entries);

  it('gives the fewest exact routes for each family separately', () => {
    expect(routes.map(r => [r.family, r.routes.map(formatPrefix)])).toEqual([
      [4, ['10.0.0.0/22', '10.0.4.0/24']],
      [6, ['2001:db8::/32']],
    ]);
    expect(routes[0]).toMatchObject({ inputCount: 7, addresses: 1280n, duplicates: 1, contained: 1 });
  });

  it('offers a broader supernet only as a labeled extra, with the added space counted', () => {
    expect(routes[0].supernet).toEqual({ prefix: prefix('10.0.0.0/21'), extraAddresses: 768n });
    expect(routes[1].supernet).toBeNull();
  });

  it('never adds coverage to make the exact list shorter', () => {
    const r = summarizeRoutes(parseNetworkList('10.0.1.0/24\n10.0.2.0/24').entries)[0];
    expect(r.routes.map(formatPrefix)).toEqual(['10.0.1.0/24', '10.0.2.0/24']);
    expect(r.supernet).toEqual({ prefix: prefix('10.0.0.0/22'), extraAddresses: 512n });
  });
});

describe('exports', () => {
  it('writes a split as CSV and JSON', () => {
    const subnets = splitPrefix(prefix('10.0.0.0/24'), 26, 0n, 2).subnets;
    expect(prefixListCsv(subnets)).toBe(lines('Network,First address,Last address,Addresses', '10.0.0.0/26,10.0.0.0,10.0.0.63,64', '10.0.0.64/26,10.0.0.64,10.0.0.127,64'));
    expect(prefixListJson([prefix('2001:db8::/127')])).toEqual([{ network: '2001:db8::/127', first: '2001:db8::', last: '2001:db8::1', addresses: '2' }]);
  });

  it('writes a VLSM plan as CSV with allocations, failures and free space', () => {
    const r = allocateVlsm({ parent: '10.0.0.0/28', requests: [{ name: 'A', hosts: 5 }, { name: 'B', hosts: 20 }], reserved: [{ name: 'GW', range: '10.0.0.14 - 10.0.0.15' }] });
    expect(vlsmCsv(r)).toBe(lines(
      'Name,Type,Network,Subnet mask,First usable,Last usable,Requested hosts,Host capacity,Addresses',
      'A,Request,10.0.0.0/29,255.255.255.248,10.0.0.1,10.0.0.6,5,6,8',
      'GW,Reserved,10.0.0.14/31,,,,,,2',
      'B,Not allocated,,,,,20,,',
      ',Free,10.0.0.8/30,255.255.255.252,,,,,4',
      ',Free,10.0.0.12/31,255.255.255.254,,,,,2',
    ));
  });

  it('writes a VLSM plan as JSON', () => {
    const json = vlsmJson(allocateVlsm({ parent: '10.0.0.0/29', requests: [{ name: 'L', hosts: 2 }], pointToPoint: true })) as Record<string, unknown>;
    expect(json).toEqual({
      parent: '10.0.0.0/29',
      allocations: [{ name: 'L', type: 'request', network: '10.0.0.0/31', range: '10.0.0.0/31', subnetMask: '255.255.255.254', firstUsable: '10.0.0.0', lastUsable: '10.0.0.1', requestedHosts: 2, hostCapacity: 2, addresses: 2 }],
      failures: [],
      unallocated: ['10.0.0.2/31', '10.0.0.4/30'],
      summary: { parentAddresses: 8, allocatedAddresses: 2, fixedAddresses: 0, reservedAddresses: 0, freeAddresses: 6, requestedHosts: 2, hostCapacity: 2 },
      notes: [],
    });
  });

  it('writes the range analysis as CSV with findings per line', () => {
    const { entries } = parseNetworkList('10.0.0.0/24\n10.0.0.128/25\n2001:db8::1');
    expect(analysisCsv(analyzeRanges(entries))).toBe(lines(
      'Line,Input,Family,Normalized,First address,Last address,Addresses,Findings',
      '1,10.0.0.0/24,IPv4,10.0.0.0/24,10.0.0.0,10.0.0.255,256,contains line 2',
      '2,10.0.0.128/25,IPv4,10.0.0.128/25,10.0.0.128,10.0.0.255,128,inside line 1',
      '3,2001:db8::1,IPv6,2001:db8::1/128,2001:db8::1,2001:db8::1,1,',
    ));
  });

  it('writes the range analysis as JSON, including input errors', () => {
    const { entries, errors } = parseNetworkList('10.0.0.0/24\nbad\n10.0.0.0/24');
    const json = analysisJson(analyzeRanges(entries, prefix('10.0.0.0/23')), errors) as { errors: unknown[]; findings: unknown[]; parent: unknown };
    expect(json.errors).toEqual([{ line: 2, input: 'bad', message: expect.any(String) }]);
    expect(json.findings).toEqual([{ kind: 'duplicate', lineA: 1, lineB: 3, a: '10.0.0.0/24', b: '10.0.0.0/24', shared: '10.0.0.0/24' }]);
    expect(json.parent).toEqual({ network: '10.0.0.0/23', coveredAddresses: '256', gapAddresses: '256', gaps: ['10.0.1.0/24'], outsideLines: [] });
  });

  it('writes route summaries as CSV and JSON, marking the supernet as not exact', () => {
    const s = summarizeRoutes(parseNetworkList('10.0.1.0/24\n10.0.2.0/24\n2001:db8::/32').entries);
    expect(routesCsv(s)).toBe(lines('Family,Route,First address,Last address,Addresses', 'IPv4,10.0.1.0/24,10.0.1.0,10.0.1.255,256', 'IPv4,10.0.2.0/24,10.0.2.0,10.0.2.255,256', 'IPv6,2001:db8::/32,2001:db8::,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,79228162514264337593543950336'));
    expect(routesJson(s)).toEqual({
      ipv4: { inputs: 2, routes: ['10.0.1.0/24', '10.0.2.0/24'], addresses: '512', duplicates: 0, contained: 0, broaderSupernet: { network: '10.0.0.0/22', extraAddresses: '512', exact: false } },
      ipv6: { inputs: 1, routes: ['2001:db8::/32'], addresses: '79228162514264337593543950336', duplicates: 0, contained: 0, broaderSupernet: null },
    });
  });
});
