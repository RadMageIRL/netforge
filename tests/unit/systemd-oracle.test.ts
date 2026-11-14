/**
 * systemd calendar expressions against systemd itself (scripts/oracles/systemd_oracle.py, which runs
 * `systemd-analyze calendar` from systemd 257). Checks what is accepted, the normalized form, and
 * the next 10 elapse times in several zones, including both DST changes of 2026: systemd skips a
 * local time that does not exist and runs a repeated one only the first time, which is what
 * NetForge's SYSTEMD_DST_POLICY models. systemd-analyze lists elapses strictly after --base-time.
 *
 * The fixture's tzdata (the Linux host's) can be newer than this runtime's; the zones used here
 * have the same rules in both for the years tested.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextPatternRuns } from '../../src/core/schedule/search';
import { parseSystemd, systemdPattern, SYSTEMD_DST_POLICY } from '../../src/core/schedule/systemd';

interface NormalizeCase { expr: string; accepted: boolean; normalized: string | null; netforgeRejectsByDesign?: string }
interface ElapseCase { expr: string; zone: string; base: number; kind: 'generic' | 'gap' | 'repeat'; runs: number[] }
interface Fixture { systemd: string; tzdata: string; iterations: number; baseStrictlyBefore: boolean; normalize: NormalizeCase[]; elapses: ElapseCase[] }

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'systemd-oracle.json'), 'utf8')) as Fixture;

describe('systemd calendar expressions against systemd-analyze', () => {
  it('comes from systemd and covers the cases that matter', () => {
    expect(oracle.systemd).toMatch(/^systemd 257\b/);
    expect(oracle.baseStrictlyBefore).toBe(true);
    expect(oracle.normalize.length).toBeGreaterThanOrEqual(200);
    expect(oracle.normalize.filter(c => c.accepted).length).toBeGreaterThanOrEqual(120);
    expect(oracle.normalize.filter(c => !c.accepted).length).toBeGreaterThanOrEqual(50);
    expect(oracle.normalize.filter(c => c.netforgeRejectsByDesign).length).toBeGreaterThanOrEqual(5);
    expect(oracle.elapses.filter(c => c.kind === 'gap').length).toBeGreaterThanOrEqual(100);
    expect(oracle.elapses.filter(c => c.kind === 'repeat').length).toBeGreaterThanOrEqual(100);
    expect(oracle.elapses.filter(c => c.runs.length === 0).length).toBeGreaterThanOrEqual(10);
    expect(new Set(oracle.elapses.map(c => c.zone)).size).toBe(5);
  });

  it('accepts and rejects the same expressions and normalizes them the same way', () => {
    const mismatches: string[] = [];
    for (const c of oracle.normalize) {
      const r = parseSystemd(c.expr);
      if (c.netforgeRejectsByDesign) {
        if (r.ok || r.error.code !== c.netforgeRejectsByDesign) mismatches.push(`${c.expr}: expected NetForge to refuse with ${c.netforgeRejectsByDesign}, got ${r.ok ? r.value.normalized : r.error.code}`);
        continue;
      }
      if (c.accepted && !r.ok) mismatches.push(`${c.expr}: systemd accepts (${c.normalized}), NetForge refuses: ${r.error.message}`);
      else if (!c.accepted && r.ok) mismatches.push(`${c.expr}: systemd refuses, NetForge accepts as ${r.value.normalized}`);
      else if (r.ok && r.value.normalized !== c.normalized) mismatches.push(`${c.expr}: normalized ${r.value.normalized} vs systemd ${c.normalized}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('only refuses on purpose what systemd accepts: fractional seconds and zone abbreviations', () => {
    const design = oracle.normalize.filter(c => c.netforgeRejectsByDesign);
    expect(design.every(c => c.accepted)).toBe(true);
    expect(new Set(design.map(c => c.netforgeRejectsByDesign))).toEqual(new Set(['fraction', 'zone-abbreviation']));
  });

  it('lists the same next elapses, through DST gaps and repeats, month ends, leap days and 2199', () => {
    const mismatches: string[] = [];
    for (const c of oracle.elapses) {
      const r = parseSystemd(c.expr);
      if (!r.ok) { mismatches.push(`${c.expr}: NetForge refuses: ${r.error.message}`); continue; }
      const runs = nextPatternRuns(systemdPattern(r.value), r.value.zone ?? c.zone, c.base * 1000, SYSTEMD_DST_POLICY, { count: oracle.iterations });
      const got = runs.rows.flatMap(row => (row.type === 'run' && row.index !== null ? [row.epochMs / 1000] : []));
      if (JSON.stringify(got) !== JSON.stringify(c.runs)) {
        mismatches.push(`${c.expr} TZ=${c.zone} base ${new Date(c.base * 1000).toISOString()} (${c.kind}):\n  NetForge ${got.map(s => new Date(s * 1000).toISOString()).join(' ')}\n  systemd  ${c.runs.map(s => new Date(s * 1000).toISOString()).join(' ')}`);
      }
    }
    expect(mismatches.slice(0, 8)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });
});
