/**
 * Cron and Quartz next runs against scripts/oracles/schedule_oracle.py: a brute-force scanner written
 * in Python from the Vixie cron rules and the Quartz documentation, croniter where it models the
 * expression faithfully, and Python zoneinfo (IANA 2025b, the same release as this runtime) for
 * times that DST changes skip or repeat.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronDstPolicy, cronPattern, parseCron } from '../../src/core/schedule/cron';
import type { CalendarPattern, DstPolicy } from '../../src/core/schedule/model';
import { parseQuartz, quartzPattern, QUARTZ_DST_POLICY } from '../../src/core/schedule/quartz';
import { nextPatternRuns, type NextRuns } from '../../src/core/schedule/search';

interface RunCase { expr: string; from: number; runs: number[]; stop: string | null; refs: string[] }
interface Row { type: 'run' | 'group'; kind: string; epochMs?: number; wallMs?: number; at?: number; firstWallMs?: number; lastWallMs?: number; count?: number }
interface DstCase { dialect: 'cron' | 'quartz'; expr: string; zone: string; from: number; count: number; rows: Row[] }
interface SpecialCase { dialect: 'cron' | 'quartz'; expr: string; zone: string; from: number; count: number; runs: number[]; stop: string | null }
interface Fixture {
  tzdata: string;
  runsPerCase: number;
  cron: RunCase[];
  quartz: RunCase[];
  dst: DstCase[];
  special: SpecialCase[];
  croniterExcluded: { dialect: string; expr: string; reason: string }[];
}

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'schedule-oracle.json'), 'utf8')) as Fixture;

function compile(dialect: 'cron' | 'quartz', expr: string): { pattern: CalendarPattern; policy: DstPolicy } {
  if (dialect === 'cron') {
    const r = parseCron(expr);
    if (!r.ok) throw new Error(`NetForge rejected cron ${expr}: ${r.error.message}`);
    return { pattern: cronPattern(r.value), policy: cronDstPolicy(r.value) };
  }
  const r = parseQuartz(expr);
  if (!r.ok) throw new Error(`NetForge rejected Quartz ${expr}: ${r.error.message}`);
  return { pattern: quartzPattern(r.value), policy: QUARTZ_DST_POLICY };
}

const counted = (runs: NextRuns) => runs.rows.flatMap(r => (r.type === 'run' && r.index !== null ? [r.epochMs / 1000] : []));

function rows(runs: NextRuns): Row[] {
  return runs.rows.map(r => (r.type === 'run'
    ? { type: 'run', kind: r.kind, epochMs: r.epochMs, wallMs: r.wallMs }
    : { type: 'group', kind: r.kind, at: r.transition.at, firstWallMs: r.firstWallMs, lastWallMs: r.lastWallMs, count: r.count }));
}

function checkRunCases(dialect: 'cron' | 'quartz', cases: RunCase[]): string[] {
  const mismatches: string[] = [];
  for (const c of cases) {
    const { pattern, policy } = compile(dialect, c.expr);
    const runs = nextPatternRuns(pattern, 'UTC', c.from * 1000, policy, { count: oracle.runsPerCase });
    const got = counted(runs);
    const stop = runs.stop?.kind ?? null;
    if (JSON.stringify(got) !== JSON.stringify(c.runs) || stop !== c.stop) {
      mismatches.push(`${c.expr} from ${c.from}: ${JSON.stringify(got.slice(0, 3))} stop ${stop} vs ${JSON.stringify(c.runs.slice(0, 3))} stop ${c.stop} (${c.refs.join('+')})`);
    }
  }
  return mismatches;
}

describe('schedules against the Python oracle', () => {
  it('uses the same IANA release as this runtime', () => {
    expect(oracle.tzdata).toBe(process.versions.tz);
  });

  it('covers enough cases of every kind', () => {
    expect(oracle.cron.length).toBeGreaterThanOrEqual(300);
    expect(oracle.cron.filter(c => c.refs.includes('croniter')).length).toBeGreaterThanOrEqual(250);
    expect(oracle.cron.filter(c => !c.refs.includes('croniter')).length).toBeGreaterThanOrEqual(10);
    expect(oracle.quartz.length).toBeGreaterThanOrEqual(150);
    expect(oracle.quartz.filter(c => c.refs.includes('croniter')).length).toBeGreaterThanOrEqual(80);
    for (const special of ['L-', 'LW', 'W ', '#', 'L ']) expect(oracle.quartz.some(c => c.expr.includes(special))).toBe(true);
    expect(oracle.quartz.filter(c => c.expr.split(/\s+/).length === 7).length).toBeGreaterThanOrEqual(20);
    expect(oracle.dst.length).toBeGreaterThanOrEqual(100);
    expect(oracle.dst.filter(c => c.rows.some(r => r.type === 'group')).length).toBeGreaterThanOrEqual(50);
    expect(oracle.dst.filter(c => c.rows.some(r => r.kind === 'repeated-second')).length).toBeGreaterThanOrEqual(50);
    expect(new Set(oracle.dst.map(c => c.zone)).size).toBeGreaterThanOrEqual(8);
    expect(oracle.special.filter(c => c.stop === 'never').length).toBeGreaterThanOrEqual(3);
    // croniter is left out only for the documented reasons, never because it disagreed.
    expect(oracle.croniterExcluded.filter(e => e.reason.includes('disagrees'))).toEqual([]);
  });

  it('finds the same standard cron runs (Vixie day rule included)', () => {
    const mismatches = checkRunCases('cron', oracle.cron);
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it('finds the same Quartz runs (seconds, ?, L, L-n, LW, nW, nL, n#k, years)', () => {
    const mismatches = checkRunCases('quartz', oracle.quartz);
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it('marks the same skipped and repeated local times, in instant order, at every DST transition', () => {
    const mismatches: string[] = [];
    for (const c of oracle.dst) {
      const { pattern, policy } = compile(c.dialect, c.expr);
      const got = rows(nextPatternRuns(pattern, c.zone, c.from, policy, { count: c.count }));
      if (JSON.stringify(got) !== JSON.stringify(c.rows)) {
        mismatches.push(`${c.dialect} "${c.expr}" ${c.zone} from ${new Date(c.from).toISOString()}:\n  got ${JSON.stringify(got.slice(0, 4))}\n  exp ${JSON.stringify(c.rows.slice(0, 4))}`);
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(mismatches.length).toBe(0);
  });

  it('handles leap days, month ends, year boundaries, rare and impossible schedules', () => {
    const mismatches: string[] = [];
    for (const c of oracle.special) {
      const { pattern, policy } = compile(c.dialect, c.expr);
      const runs = nextPatternRuns(pattern, c.zone, c.from * 1000, policy, { count: c.count });
      const got = counted(runs);
      if (JSON.stringify(got) !== JSON.stringify(c.runs) || (runs.stop?.kind ?? null) !== c.stop) {
        mismatches.push(`${c.dialect} ${c.expr}: ${JSON.stringify(got)} ${runs.stop?.kind ?? null} vs ${JSON.stringify(c.runs)} ${c.stop}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
