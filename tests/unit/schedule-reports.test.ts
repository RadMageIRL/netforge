/** ScheduleForge rows, copied text, CSV and JSON. */
import { describe, expect, it } from 'vitest';
import { buildSchedule, BUILDER_DST_POLICY, intendedRuns, validateBuilder } from '../../src/core/schedule/builder';
import { cronDstPolicy, cronPattern, explainCron, parseCron } from '../../src/core/schedule/cron';
import { dstImpacts } from '../../src/core/schedule/dst';
import {
  builderJson, builderText, explainJson, explainText, impactText, runsCsv, runViews, stopMessage, zoneAbbreviation, type ExplainReport,
} from '../../src/core/schedule/reports';
import { nextPatternRuns, patternWalls, type NextRuns } from '../../src/core/schedule/search';
import { parseSystemd, systemdPattern, SYSTEMD_DST_POLICY } from '../../src/core/schedule/systemd';

const NY = 'America/New_York';

function cronReport(expr: string, from: string, zone = NY, count = 3): ExplainReport {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error.message);
  const p = cronPattern(r.value);
  const policy = cronDstPolicy(r.value);
  const runs = nextPatternRuns(p, zone, Date.parse(from), policy, { count });
  return {
    dialect: 'cron', expression: expr, zone, fromMs: Date.parse(from), explanation: explainCron(r.value), views: runViews(runs, policy),
    stop: stopMessage(runs, count), policy, impacts: dstImpacts(w => patternWalls(p, w, 9999), zone, Date.parse(from)),
  };
}

describe('run rows', () => {
  it('show both passes of a repeated time with their offsets and abbreviations', () => {
    const v = cronReport('30 1 * * *', '2026-10-31T12:00:00Z').views;
    expect(v[0]).toEqual({
      index: '1', local: 'Sun 2026-11-01 01:30:00', localIso: '2026-11-01T01:30:00-04:00', offset: '-04:00', abbreviation: 'EDT',
      utc: '2026-11-01T05:30:00Z', unixSeconds: String(Date.parse('2026-11-01T05:30:00Z') / 1000),
      status: 'scheduled', statusLabel: 'Scheduled (1st of 2)',
      note: `Clocks go back from 02:00 to 01:00 (UTC-04:00 to UTC-05:00) at 2026-11-01T06:00:00Z. ${cronDstPolicy(okCron('30 1 * * *')).repeatedNote}`,
    });
    expect([v[1].localIso, v[1].abbreviation, v[1].status, v[1].statusLabel]).toEqual(['2026-11-01T01:30:00-05:00', 'EST', 'uncertain', 'Uncertain (2nd of 2)']);
    expect([v[2].local, v[2].status, v[2].note]).toEqual(['Mon 2026-11-02 01:30:00', 'scheduled', '']);
  });

  it('show a time that does not exist, without an instant', () => {
    const v = cronReport('30 2 * * *', '2026-03-07T12:00:00Z').views;
    expect(v[0]).toMatchObject({ index: '', local: 'Sun 2026-03-08 02:30:00', localIso: '', utc: '', unixSeconds: '', status: 'nonexistent', statusLabel: 'Does not exist' });
    expect(v[0].note.startsWith('Clocks jump forward from 02:00 to 03:00 (UTC-05:00 to UTC-04:00) at 2026-03-08T07:00:00Z.')).toBe(true);
    expect(cronReport('* 2 * * *', '2026-03-08T06:58:00Z').views[0].local).toBe('Sun 2026-03-08 02:00:00 to 02:59:00 (60 times)');
  });

  it('show what systemd skips', () => {
    const s = parseSystemd('*-*-* 01:30:00');
    if (!s.ok) throw new Error();
    const v = runViews(nextPatternRuns(systemdPattern(s.value), NY, Date.parse('2026-10-31T12:00:00Z'), SYSTEMD_DST_POLICY, { count: 2 }), SYSTEMD_DST_POLICY);
    expect(v.map(x => [x.index, x.status, x.statusLabel])).toEqual([['1', 'scheduled', 'Scheduled (1st of 2)'], ['', 'skipped', 'Skipped (repeat)'], ['2', 'scheduled', 'Scheduled']]);
  });

  it('use alphabetic abbreviations only', () => {
    expect(zoneAbbreviation(Date.parse('2026-01-15T12:00:00Z'), NY)).toBe('EST');
    expect(zoneAbbreviation(Date.parse('2026-07-15T12:00:00Z'), NY)).toBe('EDT');
    expect(zoneAbbreviation(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe('');
    expect(zoneAbbreviation(Date.parse('2026-07-15T12:00:00Z'), 'UTC')).toBe('UTC');
  });
});

function okCron(expr: string) {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('stop messages', () => {
  const base: Omit<NextRuns, 'stop' | 'found'> = { zone: 'UTC', fromMs: 0, rows: [] };
  it('explain every reason', () => {
    expect(stopMessage({ ...base, found: 0, stop: { kind: 'never' } }, 10)).toBe('This schedule never runs: no date matches all of its fields.');
    expect(stopMessage({ ...base, found: 0, stop: { kind: 'past' } }, 10)).toContain('earlier');
    expect(stopMessage({ ...base, found: 2, stop: { kind: 'last-year', year: 2099 } }, 10)).toBe('Only 2 runs before the end of 2099, the last year this scheduler supports.');
    expect(stopMessage({ ...base, found: 1, stop: { kind: 'horizon', years: 400 } }, 10)).toBe('Only 1 run in the next 400 years (the search limit).');
    expect(stopMessage({ ...base, found: 3, stop: { kind: 'limit', examined: 500001 } }, 10)).toBe('The search stopped after checking 500,001 candidate times, with 3 runs found of 10.');
    expect(stopMessage({ ...base, found: 0, stop: { kind: 'ended' } }, 10)).toBe('This one-time trigger has no runs after the start time.');
    expect(stopMessage({ ...base, found: 10, stop: null }, 10)).toBeNull();
  });
});

describe('exports', () => {
  it('CSV has a fixed header, one line per row, CRLF endings and guarded text', () => {
    const r = cronReport('30 1 * * *', '2026-10-31T12:00:00Z');
    const csv = runsCsv(r.views, r.zone);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('#,Local time,Local ISO 8601,Time zone,UTC offset,Abbreviation,UTC,Unix seconds,Status,Note');
    expect(lines).toHaveLength(r.views.length + 2);
    expect(lines[lines.length - 1]).toBe('');
    expect(lines[3]).toBe(`3,Mon 2026-11-02 01:30:00,2026-11-02T01:30:00-05:00,America/New_York,'-05:00,EST,2026-11-02T06:30:00Z,${Date.parse('2026-11-02T06:30:00Z') / 1000},Scheduled,`);
  });

  it('JSON carries the expression, explanation, DST policy and runs', () => {
    const j = explainJson(cronReport('30 2 * * *', '2026-03-07T12:00:00Z')) as Record<string, unknown>;
    expect(j).toMatchObject({ format: 'netforge-schedule-explanation', version: 1, dialect: 'cron', dialectName: 'Standard cron', expression: '30 2 * * *', timeZone: NY, runsAfter: '2026-03-07T12:00:00Z', summary: 'At 02:30.' });
    expect(j.dst).toEqual({ basis: cronDstPolicy(okCron('30 2 * * *')).basis, nonexistent: 'uncertain', repeatedFirst: 'runs', repeatedSecond: 'uncertain' });
    const runs = j.runs as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ index: null, status: 'nonexistent', utc: null, unixSeconds: null });
    expect(runs[1]).toMatchObject({ index: 1, utc: '2026-03-09T06:30:00Z', offset: '-04:00', abbreviation: 'EDT' });
    expect((j.dstChangesAhead as string[]).length).toBe(1);
    expect(j.searchStopped).toBeNull();
  });

  it('copied text lists the runs, warnings and DST changes', () => {
    const text = explainText(cronReport('30 1,2 * * *', '2026-03-07T12:00:00Z', NY, 3));
    expect(text).toContain('Standard cron: 30 1,2 * * *');
    expect(text).toContain('Meaning: At 01:30 and 02:30.');
    expect(text).toContain('  1  Sun 2026-03-08 01:30:00 EST (-05:00)  =  2026-03-08T06:30:00Z');
    expect(text).toContain('Sun 2026-03-08 02:30:00  [Does not exist]');
    expect(text).toContain('DST changes in the next year:');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('describes DST changes ahead', () => {
    const r = cronReport('30 1 * * *', '2026-10-01T00:00:00Z');
    expect(impactText(r.impacts[0])).toBe('Clocks go back from 02:00 to 01:00 (UTC-04:00 to UTC-05:00) at 2026-11-01T06:00:00Z. On that day the scheduled time Sun 2026-11-01 01:30:00 happens twice.');
  });

  it('builder JSON and text include every output with its label', () => {
    const v = validateBuilder({ frequency: 'monthly', everyMinutes: '15', everyHours: '1', minute: '0', time: '18:00', weekday: '1', everyWeeks: '1', weekdays: [1], monthlyKind: 'last-day', monthDay: '1', nth: '1', nthWeekday: '1', zone: 'UTC', startDate: '2026-11-14' });
    const r = buildSchedule(v.spec!);
    const views = runViews(intendedRuns(v.spec!, Date.parse('2026-11-14T00:00:00Z'), { count: 2 }), BUILDER_DST_POLICY);
    const j = builderJson(r, views, Date.parse('2026-11-14T00:00:00Z')) as { format: string; outputs: { target: string; fidelity: string; text: string | null }[]; runs: unknown[]; timerUnit: string };
    expect(j.format).toBe('netforge-schedule-builder');
    expect(j.outputs.map(o => [o.target, o.fidelity, o.text === null])).toEqual([['cron', 'unsupported', true], ['quartz', 'exact', false], ['systemd', 'exact', false], ['powershell', 'unsupported', true], ['schtasks', 'exact', false]]);
    expect(j.runs).toHaveLength(2);
    expect(j.timerUnit).toContain('OnCalendar=*-*~01 18:00:00 UTC');
    const text = builderText(r);
    expect(text).toContain('Standard cron [unsupported]');
    expect(text).toContain('Quartz cron [exact]');
    expect(text).toContain('  0 0 18 L * ?');
    expect(text).toContain('Windows: schtasks.exe [exact, template]');
  });
});
