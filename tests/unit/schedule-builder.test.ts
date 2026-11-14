/**
 * Schedule Builder: validation, the text of every translation, and the meaning of the labels.
 * "Exact" is checked by running each generated output through its own dialect's engine and
 * comparing with the chosen schedule over hundreds of runs; "approximate" must actually differ or
 * carry an undocumented-behavior reason; "unsupported" must produce no text.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSchedule, describeSpec, intendedRuns, todayIn, translationRuns, validateBuilder,
  type BuilderInput, type BuilderSpec, type Frequency, type TargetId,
} from '../../src/core/schedule/builder';
import type { NextRuns } from '../../src/core/schedule/search';

const BASE: BuilderInput = {
  frequency: 'daily', everyMinutes: '15', everyHours: '1', minute: '0', time: '09:00', weekday: '1', everyWeeks: '1', weekdays: [1, 3, 5],
  monthlyKind: 'day', monthDay: '15', nth: '1', nthWeekday: '1', zone: 'America/New_York', startDate: '2026-11-14',
};

function spec(over: Partial<BuilderInput>): BuilderSpec {
  const v = validateBuilder({ ...BASE, ...over });
  if (!v.spec) throw new Error(JSON.stringify(v.issues));
  return v.spec;
}

type Row = [TargetId, string, string];
function table(over: Partial<BuilderInput>): Row[] {
  return buildSchedule(spec(over)).translations.map(t => [t.target, t.fidelity, t.text.split('\n').filter(l => l && !l.startsWith('#') && !l.startsWith('$action') && !l.startsWith('Register-')).join(' | ')]);
}

describe('validation', () => {
  it('reports every bad field', () => {
    const v = validateBuilder({ ...BASE, frequency: 'minutes', everyMinutes: '0', zone: 'Mars/Base', startDate: '2026-02-30' });
    expect(v.spec).toBeNull();
    expect(v.issues.map(i => i.field).sort()).toEqual(['everyMinutes', 'startDate', 'zone']);
    expect(validateBuilder({ ...BASE, time: '24:00' }).issues.map(i => i.field)).toEqual(['time']);
    expect(validateBuilder({ ...BASE, time: '' }).issues.map(i => i.field)).toEqual(['time']);
    expect(validateBuilder({ ...BASE, frequency: 'days', weekdays: [] }).issues.map(i => i.field)).toEqual(['weekdays']);
    expect(validateBuilder({ ...BASE, frequency: 'hourly', everyHours: '24', minute: '60' }).issues.map(i => i.field)).toEqual(['everyHours', 'minute']);
    expect(validateBuilder({ ...BASE, frequency: 'weekly', everyWeeks: '53' }).issues.map(i => i.field)).toEqual(['everyWeeks']);
    expect(validateBuilder({ ...BASE, frequency: 'monthly', monthDay: '32' }).issues.map(i => i.field)).toEqual(['monthDay']);
    expect(validateBuilder({ ...BASE, frequency: 'minutes', everyMinutes: '1.5' }).issues.map(i => i.field)).toEqual(['everyMinutes']);
  });

  it('ignores fields the frequency does not use', () => {
    expect(validateBuilder({ ...BASE, frequency: 'minutes', time: 'garbage', everyMinutes: '5' }).spec).not.toBeNull();
  });

  it('warns about uneven intervals and short months', () => {
    expect(validateBuilder({ ...BASE, frequency: 'minutes', everyMinutes: '7' }).warnings.join(' ')).toContain('4 minutes later');
    expect(validateBuilder({ ...BASE, frequency: 'minutes', everyMinutes: '20' }).warnings).toEqual([]);
    expect(validateBuilder({ ...BASE, frequency: 'hourly', everyHours: '5', minute: '30' }).warnings.join(' ')).toContain('4 hours later');
    expect(validateBuilder({ ...BASE, frequency: 'monthly', monthDay: '30' }).warnings.join(' ')).toContain('Day 30');
  });
});

describe('translations', () => {
  it('daily', () => {
    expect(table({})).toEqual([
      ['cron', 'exact', '0 9 * * *'],
      ['quartz', 'exact', '0 0 9 * * ?'],
      ['systemd', 'exact', '*-*-* 09:00:00 America/New_York'],
      ['powershell', 'exact', "$trigger = New-ScheduledTaskTrigger -Daily -At '2026-11-14T09:00:00' | $trigger.StartBoundary = '2026-11-14T09:00:00'"],
      ['schtasks', 'exact', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 09:00'],
    ]);
  });

  it('every 15 minutes', () => {
    const t = table({ frequency: 'minutes', everyMinutes: '15' });
    expect(t.slice(0, 3)).toEqual([['cron', 'exact', '*/15 * * * *'], ['quartz', 'exact', '0 0/15 * * * ?'], ['systemd', 'exact', '*-*-* *:00/15:00 America/New_York']]);
    expect(t[3][1]).toBe('exact');
    expect(t[3][2]).toContain('-RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)');
    expect(t[4]).toEqual(['schtasks', 'exact', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 00:00 /RI 15 /DU 0024:00']);
  });

  it('every minute and every 7 minutes', () => {
    expect(table({ frequency: 'minutes', everyMinutes: '1' }).slice(0, 3).map(r => r[2])).toEqual(['* * * * *', '0 * * * * ?', '*-*-* *:*:00 America/New_York']);
    const seven = buildSchedule(spec({ frequency: 'minutes', everyMinutes: '7' }));
    expect(seven.translations.map(t => t.fidelity)).toEqual(['exact', 'exact', 'exact', 'approximate', 'approximate']);
    expect(seven.translations[3].differences.join(' ')).toContain('00:56, 01:03');
  });

  it('hourly', () => {
    expect(table({ frequency: 'hourly', everyHours: '1', minute: '5' }).slice(0, 3).map(r => r[2])).toEqual(['5 * * * *', '0 5 * * * ?', '*-*-* *:05:00 America/New_York']);
    const five = table({ frequency: 'hourly', everyHours: '5', minute: '30' });
    expect(five.map(r => r[1])).toEqual(['exact', 'exact', 'exact', 'exact', 'exact']);
    expect(five.slice(0, 3).map(r => r[2])).toEqual(['30 */5 * * *', '0 30 0/5 * * ?', '*-*-* 00/5:30:00 America/New_York']);
    expect(five[4][2]).toContain('/SC DAILY /ST 00:30 /RI 300 /DU 0024:00');
  });

  it('weekdays, weekly and specific weekdays', () => {
    expect(table({ frequency: 'weekdays', time: '08:30' }).map(r => r[2])).toEqual([
      '30 8 * * 1-5', '0 30 8 ? * MON-FRI', 'Mon..Fri *-*-* 08:30:00 America/New_York',
      "$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '2026-11-14T08:30:00' | $trigger.StartBoundary = '2026-11-14T08:30:00'",
      'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:30',
    ]);
    expect(table({ frequency: 'weekly', weekday: '0' }).slice(0, 3).map(r => r[2])).toEqual(['0 9 * * 0', '0 0 9 ? * SUN', 'Sun *-*-* 09:00:00 America/New_York']);
    expect(table({ frequency: 'days', weekdays: [5, 1, 3] }).slice(0, 3).map(r => r[2])).toEqual(['0 9 * * 1,3,5', '0 0 9 ? * MON,WED,FRI', 'Mon,Wed,Fri *-*-* 09:00:00 America/New_York']);
    expect(table({ frequency: 'days', weekdays: [6, 0] })[2][2]).toBe('Sat,Sun *-*-* 09:00:00 America/New_York');
  });

  it('every 2 weeks: only Windows can count weeks', () => {
    const r = buildSchedule(spec({ frequency: 'weekly', weekday: '1', everyWeeks: '2' }));
    expect(r.translations.map(t => [t.target, t.fidelity])).toEqual([['cron', 'unsupported'], ['quartz', 'unsupported'], ['systemd', 'unsupported'], ['powershell', 'exact'], ['schtasks', 'exact']]);
    for (const t of r.translations.slice(0, 3)) {
      expect(t.text).toBe('');
      expect(t.differences.join(' ')).toContain('week counter');
    }
    expect(r.timerUnit).toBeNull();
    expect(r.translations[4].text).toContain('/SC WEEKLY /MO 2 /D MON /SD 11/14/2026 /ST 09:00');
    const sunday = buildSchedule(spec({ frequency: 'weekly', weekday: '0', everyWeeks: '2' }));
    expect(sunday.translations[3].fidelity).toBe('approximate');
    expect(sunday.translations[3].differences.join(' ')).toContain('Sunday or Monday');
  });

  it('monthly by date, last day and weekday of the month', () => {
    expect(table({ frequency: 'monthly', monthDay: '15' }).map(r => [r[0], r[1]])).toEqual([['cron', 'exact'], ['quartz', 'exact'], ['systemd', 'exact'], ['powershell', 'unsupported'], ['schtasks', 'exact']]);
    expect(table({ frequency: 'monthly', monthDay: '15' }).map(r => r[2]).filter(Boolean)).toEqual([
      '0 9 15 * *', '0 0 9 15 * ?', '*-*-15 09:00:00 America/New_York', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /D 15 /ST 09:00',
    ]);
    expect(table({ frequency: 'monthly', monthDay: '31' })[4][1]).toBe('approximate');
    const last = table({ frequency: 'monthly', monthlyKind: 'last-day', time: '18:00' });
    expect(last.map(r => [r[0], r[1], r[2]])).toEqual([
      ['cron', 'unsupported', ''], ['quartz', 'exact', '0 0 18 L * ?'], ['systemd', 'exact', '*-*~01 18:00:00 America/New_York'],
      ['powershell', 'unsupported', ''], ['schtasks', 'exact', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO LASTDAY /M * /ST 18:00'],
    ]);
    const lastFri = table({ frequency: 'monthly', monthlyKind: 'nth', nth: 'last', nthWeekday: '5' });
    expect(lastFri.map(r => r[2])).toEqual(['', '0 0 9 ? * 6L', 'Fri *-*~07/1 09:00:00 America/New_York', '', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO LAST /D FRI /ST 09:00']);
    const firstMon = table({ frequency: 'monthly', monthlyKind: 'nth', nth: '1', nthWeekday: '1' });
    expect(firstMon.map(r => r[2])).toEqual(['', '0 0 9 ? * 2#1', 'Mon *-*-01..07 09:00:00 America/New_York', '', 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO FIRST /D MON /ST 09:00']);
    expect(table({ frequency: 'monthly', monthlyKind: 'nth', nth: '4', nthWeekday: '0' })[2][2]).toBe('Sun *-*-22..28 09:00:00 America/New_York');
    expect(buildSchedule(spec({ frequency: 'monthly', monthlyKind: 'nth', nth: '1', nthWeekday: '1' })).translations[0].differences.join(' ')).toContain('EITHER');
  });

  it('writes UTC as UTC for systemd', () => {
    expect(table({ zone: 'UTC' })[2][2]).toBe('*-*-* 09:00:00 UTC');
  });

  it('states conditions and DST notes for every supported output', () => {
    const r = buildSchedule(spec({}));
    for (const t of r.translations) {
      expect(t.conditions.length).toBeGreaterThan(0);
      expect(t.dst.basis.length).toBeGreaterThan(10);
    }
    expect(r.translations[0].conditions.join(' ')).toContain('CRON_TZ=America/New_York');
    expect(r.translations[1].conditions.join(' ')).toContain('inTimeZone');
    expect(r.translations[3].conditions.join(' ')).toContain("computer's local time zone");
    expect(r.translations[3].notes[0]).toBe('Trigger: At 09:00 every day, starting 2026-11-14.');
    expect(r.translations[4].notes[0]).toBe('Trigger: At 09:00 every day, starting 2026-11-14.');
    expect(r.timerUnit?.text).toContain('OnCalendar=*-*-* 09:00:00 America/New_York');
  });

  it('describes the chosen schedule', () => {
    expect(describeSpec(spec({ frequency: 'monthly', monthlyKind: 'nth', nth: 'last', nthWeekday: '5' }))).toBe('On the last Friday of every month at 09:00, America/New_York time.');
    expect(describeSpec(spec({ frequency: 'weekly', everyWeeks: '2' }))).toBe('Every 2 weeks on Monday at 09:00, counting from the week of 2026-11-14, America/New_York time.');
    expect(describeSpec(spec({ frequency: 'minutes', everyMinutes: '1' }))).toBe('Every minute, America/New_York time.');
  });

  it('gives today in a zone', () => {
    expect(todayIn('Pacific/Kiritimati', Date.parse('2026-11-14T12:00:00Z'))).toBe('2026-11-15');
    expect(todayIn('America/Los_Angeles', Date.parse('2026-11-14T05:00:00Z'))).toBe('2026-11-13');
  });
});

/** Normal (non-DST) runs of both lists, up to the instant both lists reach. */
function comparable(a: NextRuns, b: NextRuns): [number[], number[]] {
  const runsOf = (r: NextRuns) => r.rows.flatMap(x => (x.type === 'run' && x.index !== null ? [x] : []));
  const ra = runsOf(a);
  const rb = runsOf(b);
  const end = Math.min(ra[ra.length - 1]?.epochMs ?? 0, rb[rb.length - 1]?.epochMs ?? 0);
  const pick = (list: typeof ra) => list.filter(x => x.kind === 'normal' && x.epochMs <= end).map(x => x.epochMs);
  return [pick(ra), pick(rb)];
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('labels mean what they say', () => {
  const FROMS = ['2026-11-14T17:00:00Z', '2027-03-13T12:00:00Z', '2027-10-30T12:00:00Z'];
  const ZONES = ['UTC', 'America/New_York', 'Australia/Lord_Howe'];

  function check(over: Partial<BuilderInput>, count: number): { exact: number; approximate: number } {
    let exact = 0;
    let approximate = 0;
    for (const zone of ZONES) {
      const s = spec({ ...over, zone, startDate: '2026-11-14' });
      const r = buildSchedule(s);
      for (const from of FROMS) {
        const fromMs = Date.parse(from);
        const intended = intendedRuns(s, fromMs, { count });
        for (const t of r.translations) {
          const own = translationRuns(r, t.target, fromMs, { count });
          if (t.fidelity === 'unsupported') {
            expect(t.text).toBe('');
            expect(own).toBeNull();
            continue;
          }
          const [want, have] = comparable(intended, own!);
          if (t.fidelity === 'exact') {
            if (JSON.stringify(want) !== JSON.stringify(have)) throw new Error(`${t.target} labeled exact differs for ${JSON.stringify(over)} in ${zone} from ${from}`);
            expect(want.length).toBeGreaterThan(Math.min(count, 5) / 2);
            exact++;
          } else {
            // Approximate either produces different runs or rests on behavior Microsoft does not document.
            const differs = JSON.stringify(want) !== JSON.stringify(have);
            if (!differs && !t.differences.some(d => d.includes('does not document'))) throw new Error(`${t.target} labeled approximate but identical for ${JSON.stringify(over)}`);
            approximate++;
          }
        }
      }
    }
    return { exact, approximate };
  }

  const cases: Partial<BuilderInput>[] = [
    {}, { frequency: 'minutes', everyMinutes: '15' }, { frequency: 'minutes', everyMinutes: '7' }, { frequency: 'minutes', everyMinutes: '1' },
    { frequency: 'hourly', everyHours: '5', minute: '30' }, { frequency: 'hourly', everyHours: '1', minute: '0' },
    { frequency: 'weekdays', time: '23:59' }, { frequency: 'weekly', weekday: '3', everyWeeks: '1' }, { frequency: 'weekly', weekday: '3', everyWeeks: '3' },
    { frequency: 'weekly', weekday: '0', everyWeeks: '2' }, { frequency: 'days', weekdays: [0, 6] },
    { frequency: 'monthly', monthDay: '1', time: '00:00' }, { frequency: 'monthly', monthDay: '31' }, { frequency: 'monthly', monthlyKind: 'last-day' },
    { frequency: 'monthly', monthlyKind: 'nth', nth: '2', nthWeekday: '2' }, { frequency: 'monthly', monthlyKind: 'nth', nth: 'last', nthWeekday: '0' },
  ];
  for (const over of cases) {
    it(`${JSON.stringify(over)}`, () => {
      const n = check(over, over.frequency === 'minutes' ? 300 : 60);
      expect(n.exact + n.approximate).toBeGreaterThan(0);
    });
  }

  it('holds for 120 random schedules', () => {
    const rnd = seeded(2026);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    const freqs: Frequency[] = ['minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'days', 'monthly'];
    let exact = 0;
    for (let i = 0; i < 120; i++) {
      const f = pick(freqs);
      const time = `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
      const over: Partial<BuilderInput> = {
        frequency: f, time, everyMinutes: String(1 + Math.floor(rnd() * 59)), everyHours: String(1 + Math.floor(rnd() * 23)), minute: String(Math.floor(rnd() * 60)),
        weekday: String(Math.floor(rnd() * 7)), everyWeeks: String(1 + Math.floor(rnd() * 4)),
        weekdays: [0, 1, 2, 3, 4, 5, 6].filter(() => rnd() < 0.4).concat([Math.floor(rnd() * 7)]),
        monthlyKind: pick(['day', 'last-day', 'nth'] as const), monthDay: String(1 + Math.floor(rnd() * 31)), nth: pick(['1', '2', '3', '4', 'last'] as const), nthWeekday: String(Math.floor(rnd() * 7)),
      };
      exact += check(over, f === 'minutes' ? 120 : 30).exact;
    }
    expect(exact).toBeGreaterThan(600);
  });
});
