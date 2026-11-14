/**
 * Generated PowerShell against Windows PowerShell itself (tests/fixtures/windows-oracle.json, made
 * by scripts/oracles/windows_oracle.ps1). PowerShell's own parser reads every script; the string
 * values it finds for -TaskName, -Execute and -Argument must be exactly what the person typed; and
 * the trigger lines (only those, after the syntax tree confirms they call nothing but
 * New-ScheduledTaskTrigger and New-TimeSpan) build an in-memory trigger whose properties must
 * match the schedule. Nothing is registered. Regenerate on Windows:
 *
 *   NETFORGE_WRITE_PS_CASES=<cases.json> npx vitest run tests/unit/windows-oracle.test.ts
 *   powershell -NoProfile -File scripts/oracles/windows_oracle.ps1 <cases.json> tests/fixtures/windows-oracle.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateBuilder, windowsTrigger, type BuilderInput } from '../../src/core/schedule/builder';
import { EMPTY_DETAILS, powershellCommands, type TaskDetails } from '../../src/core/schedule/commands';
import type { WindowsTrigger } from '../../src/core/schedule/windows';

const Q = (code: number) => String.fromCharCode(code);
const BASE: BuilderInput = {
  frequency: 'daily', everyMinutes: '15', everyHours: '1', minute: '0', time: '09:00', weekday: '1', everyWeeks: '1', weekdays: [1],
  monthlyKind: 'day', monthDay: '1', nth: '1', nthWeekday: '1', zone: 'UTC', startDate: '2026-11-14',
};

interface Case {
  readonly id: string;
  readonly trigger: WindowsTrigger;
  readonly details: TaskDetails;
}

function fromBuilder(id: string, over: Partial<BuilderInput>, details: TaskDetails = EMPTY_DETAILS): Case {
  const v = validateBuilder({ ...BASE, ...over });
  if (!v.spec) throw new Error(id);
  return { id, trigger: windowsTrigger(v.spec), details };
}

const CASES: Case[] = [
  fromBuilder('daily', {}),
  fromBuilder('every-15-minutes', { frequency: 'minutes', everyMinutes: '15' }),
  fromBuilder('every-7-minutes', { frequency: 'minutes', everyMinutes: '7' }),
  fromBuilder('every-5-hours', { frequency: 'hourly', everyHours: '5', minute: '30' }),
  fromBuilder('weekdays', { frequency: 'weekdays', time: '08:30' }),
  fromBuilder('every-2-weeks', { frequency: 'weekly', weekday: '1', everyWeeks: '2' }),
  fromBuilder('weekend', { frequency: 'days', weekdays: [6, 0], time: '23:45' }),
  fromBuilder('quotes', {}, { name: `Bob's ${Q(0x2018)}nightly${Q(0x2019)} job`, program: 'C:\\Program Files\\Backup Tool\\run.exe', arguments: "--label 'x' $env:TEMP `n %PATH% & | < > \"q\"" }),
  fromBuilder('more-quotes', { frequency: 'weekly', weekday: '5' }, { name: `a${Q(0x201a)}b${Q(0x201b)}c''d`, program: 'C:\\Tools\\x.exe', arguments: '' }),
  { id: 'once-indefinite', trigger: { kind: 'once', start: { year: 2026, month: 11, day: 14, hour: 8, minute: 30, second: 0 }, repetition: { intervalMinutes: 120, durationMinutes: null } }, details: EMPTY_DETAILS },
  { id: 'once-for-a-day', trigger: { kind: 'once', start: { year: 2026, month: 11, day: 14, hour: 0, minute: 0, second: 0 }, repetition: { intervalMinutes: 30, durationMinutes: 1440 } }, details: EMPTY_DETAILS },
  { id: 'every-3-days', trigger: { kind: 'daily', start: { year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 0 }, daysInterval: 3, repetition: null }, details: EMPTY_DETAILS },
];

const generated = CASES.map(c => ({ id: c.id, text: powershellCommands(c.trigger, c.details).text }));

interface Observed {
  id: string;
  text: string;
  parseErrors: string[];
  strings: { TaskName: string | null; Execute: string | null; Argument: string | null };
  trigger: { CimClassName: string; StartBoundary: string; DaysInterval: number | null; WeeksInterval: number | null; DaysOfWeek: number | null; Interval: string | null; Duration: string | null; StopAtDurationEnd: boolean | null };
}
interface Fixture { powershell: string; os: string; cases: Observed[] }

const target = process.env.NETFORGE_WRITE_PS_CASES;

describe('PowerShell output checked by Windows PowerShell', () => {
  if (target) {
    it('writes the cases for scripts/oracles/windows_oracle.ps1', () => {
      writeFileSync(target, `${JSON.stringify({ cases: generated }, null, 2)}\n`);
      expect(generated.length).toBe(CASES.length);
    });
    return;
  }
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'windows-oracle.json'), 'utf8')) as Fixture;
  const byId = new Map(fixture.cases.map(c => [c.id, c]));

  it('was checked against the current generator output', () => {
    expect(fixture.powershell).toMatch(/^5\.1\./);
    expect(fixture.cases.map(c => c.id)).toEqual(CASES.map(c => c.id));
    for (const g of generated) expect(byId.get(g.id)!.text).toBe(g.text);
  });

  it('parses without errors', () => {
    for (const c of fixture.cases) expect([c.id, c.parseErrors]).toEqual([c.id, []]);
  });

  it('passes every typed value through exactly, quotes and all', () => {
    for (const c of CASES) {
      const o = byId.get(c.id)!;
      expect([c.id, o.strings.TaskName]).toEqual([c.id, c.details.name === '' ? '<TASK NAME>' : c.details.name]);
      expect([c.id, o.strings.Execute]).toEqual([c.id, c.details.program === '' ? '<PROGRAM>' : c.details.program]);
      expect([c.id, o.strings.Argument]).toEqual([c.id, c.details.arguments === '' ? null : c.details.arguments]);
    }
  });

  it('builds triggers with the schedule\'s local start, interval, days and repetition', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const c of CASES) {
      const t = c.trigger;
      const o = byId.get(c.id)!.trigger;
      const s = t.start;
      const local = `${s.year}-${pad(s.month)}-${pad(s.day)}T${pad(s.hour)}:${pad(s.minute)}:${pad(s.second)}`;
      const cls = t.kind === 'once' ? 'MSFT_TaskTimeTrigger' : t.kind === 'daily' ? 'MSFT_TaskDailyTrigger' : 'MSFT_TaskWeeklyTrigger';
      expect([c.id, o.CimClassName, o.StartBoundary]).toEqual([c.id, cls, local]);
      if (t.kind === 'daily') expect([c.id, o.DaysInterval]).toEqual([c.id, t.daysInterval]);
      if (t.kind === 'weekly') {
        expect([c.id, o.WeeksInterval]).toEqual([c.id, t.weeksInterval]);
        // Task Scheduler's DaysOfWeek bitmask: Sunday 1, Monday 2, ... Saturday 64.
        expect([c.id, o.DaysOfWeek]).toEqual([c.id, t.days.reduce((m, d) => m | (1 << d), 0)]);
      }
      const r = t.repetition;
      if (!r) {
        expect([c.id, o.Interval ?? null]).toEqual([c.id, null]);
        continue;
      }
      const interval = r.intervalMinutes % 60 === 0 ? `PT${r.intervalMinutes / 60}H` : `PT${r.intervalMinutes}M`;
      expect([c.id, o.Interval]).toEqual([c.id, interval]);
      if (r.durationMinutes === null) expect([c.id, o.Duration ?? '']).toEqual([c.id, '']);
      else {
        expect([c.id, o.Duration]).toEqual([c.id, r.durationMinutes === 1440 ? 'P1D' : `PT${r.durationMinutes}M`]);
        expect([c.id, o.StopAtDurationEnd]).toEqual([c.id, false]);
      }
    }
  });
});
