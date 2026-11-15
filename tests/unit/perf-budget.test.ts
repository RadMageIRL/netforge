/**
 * Time budgets for the heavy paths at their documented limits. Each budget is several times the
 * time measured on the development machine, so the test fails on an accidental change of
 * complexity (linear to quadratic), not on a slow day.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convert as convertNumber } from '../../src/core/numbers/bases';
import { dhcpScript, DEFAULT_DHCP_OPTIONS } from '../../src/core/infra/powershell';
import { iosConfig } from '../../src/core/infra/ios';
import { neutralJson } from '../../src/core/infra/neutral';
import { WHOLE_PLAN } from '../../src/core/infra/source';
import { parsePrefixText } from '../../src/core/net/address';
import { summarizeRanges, splitPrefix } from '../../src/core/net/ops';
import { prefixToRange } from '../../src/core/net/address';
import { planToJson, parsePlanJson } from '../../src/core/plan/file';
import { blankVlan, emptyPlan, type Plan } from '../../src/core/plan/model';
import { validatePlan } from '../../src/core/plan/validate';
import { parseCron, cronPattern, cronDstPolicy } from '../../src/core/schedule/cron';
import { nextPatternRuns } from '../../src/core/schedule/search';
import { DEFAULT_TRANSFORM, transformLines } from '../../src/core/textops/lines';
import { analyzeJson } from '../../src/core/data/json';

const measured: string[] = [];

function timed<T>(label: string, budgetMs: number, run: () => T): T {
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  measured.push(`${label}: ${ms.toFixed(0)} ms (budget ${budgetMs})`);
  expect([label, ms < budgetMs]).toEqual([label, true]);
  return result;
}

/** `count` VLANs with a /24 each, a gateway and a DHCP pool, in one site and VRF. */
function bigPlan(count: number): Plan {
  const plan = emptyPlan();
  for (let i = 0; i < count; i++) {
    const v = blankVlan(`v${i + 1}`, { siteId: 's1', namespaceId: 'n1', vrfId: 'r1' });
    v.vlanId = String(2 + (i % 4000));
    v.name = `Net${i + 1}`;
    const a = 10 + Math.floor(i / 65536);
    const b = Math.floor(i / 256) % 256;
    const c = i % 256;
    v.ipv4 = { network: `${a}.${b}.${c}.0/24`, gateway: `${a}.${b}.${c}.1`, dhcp: [`${a}.${b}.${c}.100 - ${a}.${b}.${c}.200`], fixed: false };
    // VLAN IDs repeat after 4,000, so later VLANs go to further namespaces.
    const ns = Math.floor(i / 4000);
    if (ns > 0) {
      const id = `n${ns + 1}`;
      if (!plan.namespaces.some(n => n.id === id)) plan.namespaces.push({ id, name: `Switches ${ns + 1}`, siteId: 's1', description: '' });
      v.namespaceId = id;
    }
    plan.vlans.push(v);
  }
  return plan;
}

describe('time budgets at the documented limits', () => {
  it('validates, saves, reopens and exports a plan of 5,000 VLANs', () => {
    const plan = bigPlan(5000);
    const validation = timed('validate 5,000 VLANs', 3000, () => validatePlan(plan));
    expect(validation.counts.error).toBe(0);
    const text = timed('serialize 5,000 VLANs', 1500, () => planToJson(plan));
    const loaded = timed('parse a 5,000-VLAN plan file', 3000, () => parsePlanJson(text));
    expect(loaded.ok).toBe(true);
    const json = timed('JSON export of 5,000 VLANs', 3000, () => neutralJson(plan, WHOLE_PLAN));
    expect(json.ok).toBe(true);
    const dhcp = timed('DHCP script for 5,000 scopes', 4000, () => dhcpScript(plan, DEFAULT_DHCP_OPTIONS));
    expect(dhcp.ok).toBe(true);
    const ios = timed('IOS snippet for 4,000 VLANs', 4000, () => iosConfig(plan, {
      context: { scope: { siteId: 's1', vrfId: '', namespaceId: 'n1' }, globalVrfId: 'r1', vrfNames: {} }, sections: { vlans: true, svis: true, dhcp: true }, dnsServers: '', dnsDomain: '',
    }));
    expect(ios.ok).toBe(true);
  });

  it('handles IPv6 at full width', () => {
    const p = parsePrefixText('2001:db8::/32');
    if (!p.ok) throw new Error('prefix');
    const split = timed('list 256 of the /64s in a /32', 500, () => splitPrefix(p.value.prefix, 64, 0n, 256));
    expect(split.subnets.length).toBe(256);
    const ranges = split.subnets.map(prefixToRange);
    const summary = timed('summarize 256 adjacent /64s', 500, () => summarizeRanges(ranges));
    expect(summary).toHaveLength(1);
  });

  it('finds the next runs of a sparse schedule', () => {
    const parsed = parseCron('0 0 29 2 *');
    if (!parsed.ok) throw new Error('cron');
    const runs = timed('next 10 runs of "February 29 at midnight"', 3000, () => nextPatternRuns(cronPattern(parsed.value), 'America/New_York', Date.UTC(2026, 10, 14), cronDstPolicy(parsed.value), { count: 10 }));
    expect(runs.rows.length).toBeGreaterThan(0);
  });

  it('converts numbers and text at their limits', () => {
    const digits = '9'.repeat(1200);
    const number = timed('a 1,200-digit decimal in every base', 500, () => convertNumber(digits, { base: 10, signed: false, width: null }));
    expect(number.ok).toBe(true);
    const lines = Array.from({ length: 200_000 }, (_, i) => `line ${(i * 7919) % 200_000}`).join('\n');
    const sorted = timed('sort and deduplicate 200,000 lines', 5000, () => transformLines(lines, { ...DEFAULT_TRANSFORM, trim: 'both', removeEmpty: true, dedupe: true, ignoreCase: true, sort: 'natural' }));
    expect(sorted.ok).toBe(true);
    const json = `[${Array.from({ length: 200_000 }, (_, i) => `{"id":${i},"name":"item ${i}"}`).join(',')}]`;
    const checked = timed(`validate ${Math.round(json.length / 1e6)} MB of JSON`, 3000, () => analyzeJson(json));
    expect(checked).toBeTruthy();
    // NETFORGE_PERF_OUT=<file> writes the measured times, for the release notes.
    if (process.env.NETFORGE_PERF_OUT) writeFileSync(process.env.NETFORGE_PERF_OUT, `${measured.join('\n')}\n`);
  });
});
