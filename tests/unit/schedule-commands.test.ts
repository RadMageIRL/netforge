/**
 * Generated PowerShell, schtasks.exe and systemd timer text: quoting, placeholders, refusals.
 * Two independent decoders check the quoting: PowerShell's single-quoted string rule (a doubled
 * quote character is one quote; PowerShell counts U+2018, U+2019, U+201A and U+201B as quotes),
 * and the Microsoft C runtime's documented command-line splitting ("Parsing C++ command-line
 * arguments"), which schtasks.exe uses for its argument vector.
 */
import { describe, expect, it } from 'vitest';
import { checkTaskName, checkUnitName, cmdQuote, EMPTY_DETAILS, powershellCommands, PS_STOP_PARSING, psQuote, schtasksCommand, SCHTASKS_TR_LIMIT, timerUnit } from '../../src/core/schedule/commands';
import type { LocalDateTime, WindowsTrigger } from '../../src/core/schedule/windows';

const QUOTES = [0x27, 0x2018, 0x2019, 0x201a, 0x201b].map(c => String.fromCharCode(c));
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);

/** Decodes one PowerShell single-quoted literal; throws if it is not exactly one well-formed literal. */
function psDecode(literal: string): string {
  if (!QUOTES.includes(literal[0]) || !QUOTES.includes(literal[literal.length - 1])) throw new Error('not quoted');
  let out = '';
  for (let i = 1; i < literal.length - 1; i++) {
    const ch = literal[i];
    if (QUOTES.includes(ch)) {
      if (!QUOTES.includes(literal[i + 1]) || i + 1 >= literal.length - 1) throw new Error(`unescaped quote at ${i}`);
      out += ch;
      i++;
    } else out += ch;
  }
  return out;
}

/** Splits a command line the way the Microsoft C runtime does. */
function argv(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (ch === BS) {
        let n = 0;
        while (line[i] === BS) { n++; i++; }
        if (line[i] === DQ) {
          arg += BS.repeat(Math.floor(n / 2));
          if (n % 2 === 1) arg += DQ;
          else quoted = !quoted;
        } else {
          arg += BS.repeat(n);
          i--;
        }
      } else if (ch === DQ) quoted = !quoted;
      else if ((ch === ' ' || ch === '\t') && !quoted) break;
      else arg += ch;
    }
    args.push(arg);
  }
  return args;
}

/** The value after a schtasks switch. */
function opt(args: string[], name: string): string | undefined {
  const i = args.findIndex(a => a.toUpperCase() === name);
  return i < 0 ? undefined : args[i + 1];
}

const at = (h: number, m: number, y = 2026, mo = 11, d = 14): LocalDateTime => ({ year: y, month: mo, day: d, hour: h, minute: m, second: 0 });
const daily: WindowsTrigger = { kind: 'daily', start: at(9, 0), daysInterval: 1, repetition: null };

describe('PowerShell quoting', () => {
  it('doubles every quote character PowerShell recognizes', () => {
    expect(psQuote("it's")).toEqual({ ok: true, value: "'it''s'" });
    for (const q of QUOTES) {
      const r = psQuote(`a${q}b`);
      expect(r.ok && r.value).toBe(`'a${q}${q}b'`);
    }
  });

  it('round-trips awkward text', () => {
    const samples = ["O'Brien", `${QUOTES[2]}smart${QUOTES[1]}`, 'C:\\Program Files\\App\\app.exe', '$env:PATH `n "x"', "''''", `${QUOTES[3]}${QUOTES[4]}`, 'tab-free; & | < > % !', ''];
    for (const s of samples) {
      const r = psQuote(s);
      if (!r.ok) throw new Error(s);
      expect(psDecode(r.value)).toBe(s);
    }
  });

  it('refuses line breaks and control characters', () => {
    for (const code of [0x0a, 0x0d, 0x00, 0x1b, 0x85, 0x2028]) expect(psQuote(`a${String.fromCharCode(code)}b`).ok).toBe(false);
  });

  it('never writes the stop-parsing token as a plain quoted argument', () => {
    // '--%' as an argument stops PowerShell from parsing the rest of the line, quoted or not.
    expect(psQuote('--%')).toEqual({ ok: true, value: "('--%')" });
    expect(PS_STOP_PARSING).toBe('--%');
    // Only the exact token is special: anything longer or shorter is an ordinary literal.
    for (const s of ['--% ', ' --%', '--%x', 'x--%', '--', '-%', '--%%', '---%', "'--%'", '--% | calc']) {
      const r = psQuote(s);
      expect([s, r.ok && r.value]).toEqual([s, `'${s.replace(/'/g, "''")}'`]);
    }
  });

  it('keeps the stop-parsing token out of generated task commands in every position', () => {
    for (const details of [
      { name: '--%', program: 'x.exe', arguments: '' },
      { name: 'Task', program: '--%', arguments: 'x | Stop-Computer #' },
      { name: 'Task', program: 'x.exe', arguments: '--%' },
      { name: '--%', program: '--%', arguments: '--%' },
    ]) {
      const g = powershellCommands(daily, details);
      expect(g.supported).toBe(true);
      // No argument of any command is the bare or quoted token.
      expect(g.text).not.toMatch(/ '--%'( |$)/m);
      expect(g.text).not.toMatch(/ --%( |$)/m);
      const action = g.text.split('\n').find(l => l.startsWith('$action = '))!;
      const register = g.text.split('\n').find(l => l.startsWith('Register-ScheduledTask '))!;
      if (details.program === '--%') expect(action).toContain("-Execute ('--%')");
      if (details.arguments === '--%') expect(action).toContain("-Argument ('--%')");
      if (details.name === '--%') expect(register).toBe("Register-ScheduledTask -TaskName ('--%') -Trigger $trigger -Action $action");
      // Every other line is a comment, blank, or one of the two trigger assignments.
      for (const line of g.text.split('\n')) expect(line).toMatch(/^(#.*|\$trigger(\.[A-Za-z.]+)? = .*|\$action = New-ScheduledTaskAction .*|Register-ScheduledTask .*|)$/);
    }
  });
});

describe('Command Prompt quoting', () => {
  it('wraps plain values and refuses what cmd.exe would interpret', () => {
    expect(cmdQuote('Nightly backup')).toEqual({ ok: true, value: '"Nightly backup"' });
    for (const bad of ['a"b', '%PATH%', 'a!b', 'a^b', 'a&b', 'a|b', 'a<b', 'a>b', `C:${BS}dir${BS}`, `a${String.fromCharCode(10)}b`]) {
      expect(cmdQuote(bad).ok).toBe(false);
    }
  });

  it('checks task and unit names', () => {
    expect(checkTaskName('Nightly backup (v2)')).toBeNull();
    expect(checkTaskName('a/b')).not.toBeNull();
    expect(checkTaskName(' padded')).not.toBeNull();
    expect(checkUnitName('db-backup.daily')).toBeNull();
    expect(checkUnitName('db backup')).not.toBeNull();
  });
});

describe('PowerShell commands', () => {
  it('writes a daily trigger with a local start boundary and a template', () => {
    const g = powershellCommands(daily, EMPTY_DETAILS);
    expect(g.supported).toBe(true);
    expect(g.template).toBe(true);
    const code = g.text.split('\n').filter(l => l !== '' && !l.startsWith('#'));
    expect(code).toEqual([
      "$trigger = New-ScheduledTaskTrigger -Daily -At '2026-11-14T09:00:00'",
      "$trigger.StartBoundary = '2026-11-14T09:00:00'",
      "$action = New-ScheduledTaskAction -Execute '<PROGRAM>'",
      "Register-ScheduledTask -TaskName '<TASK NAME>' -Trigger $trigger -Action $action",
    ]);
    expect(g.text).toContain('# Template:');
    expect(g.text).toContain('needs no elevation');
    expect(g.text).not.toMatch(/-RunLevel|-User |Password|Highest/);
  });

  it('copies the repetition onto daily triggers and keeps running instances', () => {
    const g = powershellCommands({ ...daily, start: at(0, 0), repetition: { intervalMinutes: 15, durationMinutes: 1440 } }, EMPTY_DETAILS);
    expect(g.text).toContain("$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '2026-11-14T00:00:00' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition");
    expect(g.text).toContain('$trigger.Repetition.StopAtDurationEnd = $false');
  });

  it('writes weekly and one-time triggers', () => {
    const w = powershellCommands({ kind: 'weekly', start: at(9, 0), weeksInterval: 2, days: [5, 1, 3], repetition: null }, EMPTY_DETAILS);
    expect(w.text).toContain("$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 2 -DaysOfWeek Monday, Wednesday, Friday -At '2026-11-14T09:00:00'");
    const o = powershellCommands({ kind: 'once', start: at(8, 30), repetition: { intervalMinutes: 120, durationMinutes: null } }, EMPTY_DETAILS);
    expect(o.text).toContain("$trigger = New-ScheduledTaskTrigger -Once -At '2026-11-14T08:30:00' -RepetitionInterval (New-TimeSpan -Hours 2)");
    expect(o.text).not.toContain('RepetitionDuration');
    expect(o.text).not.toContain('StopAtDurationEnd');
  });

  it('says monthly triggers are not available in the cmdlet', () => {
    const g = powershellCommands({ kind: 'monthly', start: at(9, 0), months: [1], days: [1], lastDay: false, repetition: null }, EMPTY_DETAILS);
    expect(g.supported).toBe(false);
    expect(g.text).toBe('');
    expect(g.reasons.join(' ')).toContain('no monthly trigger');
  });

  it('fills in names safely when they are given', () => {
    const name = `Bob${QUOTES[2]}s ${QUOTES[0]}nightly${QUOTES[0]} job`;
    const g = powershellCommands(daily, { name, program: 'C:\\Tools\\backup.exe', arguments: "--label 'weekly' --dry-run" });
    expect(g.template).toBe(false);
    const reg = g.text.split('\n').find(l => l.startsWith('Register-ScheduledTask'))!;
    const act = g.text.split('\n').find(l => l.startsWith('$action'))!;
    const literal = (line: string, after: string) => {
      const rest = line.slice(line.indexOf(after) + after.length);
      let end = 1;
      while (end < rest.length) {
        if (QUOTES.includes(rest[end])) { if (QUOTES.includes(rest[end + 1])) { end += 2; continue; } break; }
        end++;
      }
      return rest.slice(0, end + 1);
    };
    expect(psDecode(literal(reg, '-TaskName '))).toBe(name);
    expect(psDecode(literal(act, '-Execute '))).toBe('C:\\Tools\\backup.exe');
    expect(psDecode(literal(act, '-Argument '))).toBe("--label 'weekly' --dry-run");
    expect(g.text).toContain('# Review these lines');
  });

  it('keeps a placeholder for an invalid task name and says why', () => {
    const g = powershellCommands(daily, { name: 'a/b', program: '', arguments: '' });
    expect(g.text).toContain("-TaskName '<TASK NAME>'");
    expect(g.reasons.join(' ')).toContain('Task name');
  });
});

describe('schtasks commands', () => {
  const cases: [string, WindowsTrigger, string][] = [
    ['daily', daily, '/SC DAILY /ST 09:00'],
    ['every 3 days', { ...daily, daysInterval: 3 }, '/SC DAILY /MO 3 /SD 11/14/2026 /ST 09:00'],
    ['weekdays', { kind: 'weekly', start: at(9, 0), weeksInterval: 1, days: [1, 2, 3, 4, 5], repetition: null }, '/SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:00'],
    ['every 2 weeks', { kind: 'weekly', start: at(9, 0), weeksInterval: 2, days: [0], repetition: null }, '/SC WEEKLY /MO 2 /D SUN /SD 11/14/2026 /ST 09:00'],
    ['monthly day', { kind: 'monthly', start: at(9, 0), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: [15], lastDay: false, repetition: null }, '/SC MONTHLY /D 15 /ST 09:00'],
    ['monthly day in some months', { kind: 'monthly', start: at(9, 0), months: [1, 7], days: [15], lastDay: false, repetition: null }, '/SC MONTHLY /D 15 /M JAN,JUL /ST 09:00'],
    ['last day', { kind: 'monthly', start: at(18, 0), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: [], lastDay: true, repetition: null }, '/SC MONTHLY /MO LASTDAY /M * /ST 18:00'],
    ['last Friday', { kind: 'monthly-dow', start: at(9, 0), months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], weeks: ['last'], days: [5], repetition: null }, '/SC MONTHLY /MO LAST /D FRI /ST 09:00'],
    ['once', { kind: 'once', start: at(8, 30), repetition: null }, '/SC ONCE /SD 11/14/2026 /ST 08:30'],
    ['every 15 minutes', { ...daily, start: at(0, 0), repetition: { intervalMinutes: 15, durationMinutes: 1440 } }, '/SC DAILY /ST 00:00 /RI 15 /DU 0024:00'],
  ];
  for (const [name, t, tail] of cases) {
    it(name, () => {
      const g = schtasksCommand(t, EMPTY_DETAILS, 'MDY');
      expect(g.text).toBe(`schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" ${tail}\n`);
      expect(g.template).toBe(true);
    });
  }

  it('writes /SD in the chosen date format', () => {
    expect(schtasksCommand({ ...daily, daysInterval: 2 }, EMPTY_DETAILS, 'DMY').text).toContain('/SD 14/11/2026');
    expect(schtasksCommand({ ...daily, daysInterval: 2 }, EMPTY_DETAILS, 'YMD').text).toContain('/SD 2026/11/14');
    expect(schtasksCommand({ ...daily, daysInterval: 2 }, EMPTY_DETAILS, 'MDY').notes.join(' ')).toContain('short date format');
  });

  it('refuses what schtasks cannot express', () => {
    expect(schtasksCommand({ kind: 'monthly', start: at(9, 0), months: [1], days: [1, 15], lastDay: false, repetition: null }, EMPTY_DETAILS, 'MDY').supported).toBe(false);
    expect(schtasksCommand({ kind: 'monthly-dow', start: at(9, 0), months: [1], weeks: [1, 3], days: [1], repetition: null }, EMPTY_DETAILS, 'MDY').supported).toBe(false);
    expect(schtasksCommand({ kind: 'once', start: at(9, 0), repetition: { intervalMinutes: 5, durationMinutes: null } }, EMPTY_DETAILS, 'MDY').reasons.join(' ')).toContain('indefinitely');
    expect(schtasksCommand({ ...daily, start: { ...at(9, 0), second: 30 } }, EMPTY_DETAILS, 'MDY').supported).toBe(false);
  });

  it('quotes names and program paths so the C runtime reads them back exactly', () => {
    const program = 'C:\\Program Files\\Backup Tool\\run.exe';
    const g = schtasksCommand(daily, { name: 'Nightly backup', program, arguments: '--quiet --target D:\\Backups' }, 'MDY');
    expect(g.template).toBe(false);
    const args = argv(g.text.trim());
    expect(args.slice(0, 2)).toEqual(['schtasks', '/Create']);
    expect(opt(args, '/TN')).toBe('Nightly backup');
    expect(opt(args, '/TR')).toBe(`${DQ}${program}${DQ} --quiet --target D:\\Backups`);
    expect(opt(args, '/SC')).toBe('DAILY');
    expect(opt(args, '/ST')).toBe('09:00');
    const plain = argv(schtasksCommand(daily, { name: 'x', program: 'C:\\Tools\\a.exe', arguments: '' }, 'MDY').text.trim());
    expect(opt(plain, '/TR')).toBe('C:\\Tools\\a.exe');
  });

  it('keeps placeholders for values cmd.exe would interpret, and says why', () => {
    const g = schtasksCommand(daily, { name: 'R&D backup', program: 'C:\\x.exe', arguments: '--pct 50%' }, 'MDY');
    expect(g.text).toContain('/TN "<TASK NAME>"');
    expect(g.text).toContain('/TR "<COMMAND>"');
    expect(g.reasons.join(' ')).toContain('&');
    expect(g.reasons.join(' ')).toContain('%');
  });

  it('enforces the /TR length limit', () => {
    const g = schtasksCommand(daily, { name: 'x', program: `C:\\${'a'.repeat(SCHTASKS_TR_LIMIT)}.exe`, arguments: '' }, 'MDY');
    expect(g.text).toContain('/TR "<COMMAND>"');
    expect(g.reasons.join(' ')).toContain(String(SCHTASKS_TR_LIMIT));
  });

  it('never adds credentials or elevation', () => {
    const g = schtasksCommand(daily, { name: 'x', program: 'C:\\a.exe', arguments: '' }, 'MDY');
    expect(g.text).not.toMatch(/\/RU|\/RP|\/RL|\/F\b/i);
    expect(g.notes.join(' ')).toContain('no /RU, /RP or /RL HIGHEST');
  });
});

describe('systemd timer unit preview', () => {
  it('is a template until a unit name is given, and never invents the service', () => {
    const t = timerUnit('Mon..Fri *-*-* 09:00:00 America/New_York', '');
    expect(t.template).toBe(true);
    expect(t.text).toContain('# <NAME>.timer');
    expect(t.text).toContain('OnCalendar=Mon..Fri *-*-* 09:00:00 America/New_York');
    expect(t.text).toContain('[Install]\nWantedBy=timers.target');
    expect(t.text).not.toMatch(/ExecStart|\/etc\/|\/usr\//);
    const named = timerUnit('daily', 'db-backup.timer');
    expect(named.template).toBe(false);
    expect(named.text).toContain('# db-backup.timer');
    expect(named.text).toContain('Starts db-backup.service, which you write yourself');
    const bad = timerUnit('daily', 'my backup');
    expect(bad.template).toBe(true);
    expect(bad.reasons.join(' ')).toContain('Unit name');
  });
});
