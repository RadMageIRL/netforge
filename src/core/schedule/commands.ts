/**
 * Text generators for Windows Task Scheduler (PowerShell ScheduledTasks and schtasks.exe) and a
 * systemd timer unit preview. Nothing here runs anything; the output is text for a person to
 * review. Values the person did not supply (task name, program, unit name) stay as clearly marked
 * <PLACEHOLDERS>, and the output is then labeled a template.
 *
 * Quoting:
 * - PowerShell: single-quoted strings, where only quote characters are special. PowerShell treats
 *   U+2018, U+2019, U+201A and U+201B as single quotes too, so every one of them is doubled.
 *   Control characters and line breaks are refused. One value needs more than quotes: an argument
 *   that is exactly --% is PowerShell's stop-parsing token even when it is quoted, and everything
 *   after it on the line would be read verbatim (a pipe would start a second command). That value
 *   is written as the expression ('--%'), which PowerShell reads as an ordinary string.
 * - schtasks.exe for Command Prompt: values in double quotes. cmd.exe still expands % and ! inside
 *   quotes, and a quote inside a value would end the quoting for cmd and for the program's argument
 *   parser, so values containing " % ! ^ & | < > or control characters are refused instead of
 *   escaped. A program path with spaces is wrapped in \" inside /TR, as schtasks documents.
 */
import { ok, fail, type Result } from '../result';
import { formatClock, formatDate } from './calendar';
import { describeWindowsTrigger, type LocalDateTime, type Repetition, type WindowsTrigger } from './windows';

export interface TaskDetails {
  /** Task name (Windows) and unit name (systemd); may be empty. */
  readonly name: string;
  /** Program to run (Windows); may be empty. */
  readonly program: string;
  /** Arguments for the program; may be empty. */
  readonly arguments: string;
}

export const EMPTY_DETAILS: TaskDetails = { name: '', program: '', arguments: '' };

export interface GeneratedText {
  readonly supported: boolean;
  /** The generated text, or '' when unsupported. */
  readonly text: string;
  /** Placeholders remain: the person must fill them in. */
  readonly template: boolean;
  /** Why it is unsupported, or what limits it. */
  readonly reasons: readonly string[];
  readonly notes: readonly string[];
}

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const PS_QUOTE_CHARS = /['\u2018\u2019\u201a\u201b]/g;

/** PowerShell's stop-parsing token. As a bare or quoted command argument it ends normal parsing of the line. */
export const PS_STOP_PARSING = '--%';

/**
 * A PowerShell string for use as a command argument: a single-quoted literal, or for the
 * stop-parsing token a parenthesized one. Refuses control characters and line breaks.
 */
export function psQuote(value: string): Result<string, 'control'> {
  if (CONTROL.test(value)) return fail('control', 'Control characters and line breaks are not allowed.');
  if (value === PS_STOP_PARSING) return ok("('--%')");
  return ok(`'${value.replace(PS_QUOTE_CHARS, ch => ch + ch)}'`);
}

const CMD_UNSAFE = /["%!^&|<>]/;

/** A double-quoted schtasks argument for cmd.exe, or the reason it cannot be written safely. */
export function cmdQuote(value: string): Result<string, 'unsafe'> {
  if (CONTROL.test(value)) return fail('unsafe', 'Control characters and line breaks are not allowed.');
  const bad = CMD_UNSAFE.exec(value);
  if (bad) return fail('unsafe', `The character ${bad[0]} cannot be passed safely through Command Prompt; use the PowerShell output instead.`);
  if (value.endsWith('\\')) return fail('unsafe', 'A value ending in a backslash would escape the closing quote.');
  return ok(`"${value}"`);
}

const TASK_NAME_FORBIDDEN = /[\\/:*?"<>|]/;

export function checkTaskName(name: string): string | null {
  if (name.length > 200) return 'Keep the task name to 200 characters.';
  if (CONTROL.test(name)) return 'The task name cannot contain control characters or line breaks.';
  if (TASK_NAME_FORBIDDEN.test(name)) return 'A task name cannot contain \\ / : * ? " < > or |.';
  if (name.trim() !== name) return 'Remove spaces at the start and end of the task name.';
  return null;
}

/** systemd unit name stem: letters, digits and : _ . - (no "@" instances or escapes here). */
export function checkUnitName(name: string): string | null {
  if (!/^[A-Za-z0-9:_.-]+$/.test(name)) return 'A unit name uses letters, digits and : _ . - only.';
  if (name.length > 200) return 'Keep the unit name to 200 characters.';
  return null;
}

const iso = (s: LocalDateTime) => `${formatDate(s.year, s.month, s.day)}T${formatClock(s.hour, s.minute, s.second)}`;

function timeSpan(minutes: number): string {
  if (minutes % 1440 === 0) return `(New-TimeSpan -Days ${minutes / 1440})`;
  if (minutes % 60 === 0) return `(New-TimeSpan -Hours ${minutes / 60})`;
  return `(New-TimeSpan -Minutes ${minutes})`;
}

const PS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function repetitionArgs(r: Repetition): string {
  return ` -RepetitionInterval ${timeSpan(r.intervalMinutes)}${r.durationMinutes === null ? '' : ` -RepetitionDuration ${timeSpan(r.durationMinutes)}`}`;
}

/** PowerShell ScheduledTasks commands for a trigger. Monthly triggers are not supported by New-ScheduledTaskTrigger. */
export function powershellCommands(t: WindowsTrigger, details: TaskDetails): GeneratedText {
  if (t.kind === 'monthly' || t.kind === 'monthly-dow') {
    return {
      supported: false, text: '', template: false, notes: [],
      reasons: ['New-ScheduledTaskTrigger has no monthly trigger: its parameter sets are Once, Daily, Weekly, AtStartup and AtLogOn. Use the schtasks.exe output, or define the trigger in Task Scheduler or its XML.'],
    };
  }
  const at = `'${iso(t.start)}'`;
  const lines = [`# ${describeWindowsTrigger(t)} Times are the computer's local time.`];
  const r = t.repetition;
  if (t.kind === 'once') {
    lines.push(`$trigger = New-ScheduledTaskTrigger -Once -At ${at}${r ? repetitionArgs(r) : ''}`);
  } else if (t.kind === 'daily') {
    lines.push(`$trigger = New-ScheduledTaskTrigger -Daily${t.daysInterval > 1 ? ` -DaysInterval ${t.daysInterval}` : ''} -At ${at}`);
  } else {
    lines.push(`$trigger = New-ScheduledTaskTrigger -Weekly${t.weeksInterval > 1 ? ` -WeeksInterval ${t.weeksInterval}` : ''} -DaysOfWeek ${[...t.days].sort((a, b) => a - b).map(d => PS_DAYS[d]).join(', ')} -At ${at}`);
  }
  lines.push(
    '# New-ScheduledTaskTrigger stores -At as UTC, which pins the trigger to UTC and moves it by an hour across DST changes.',
    '# Writing the start boundary without an offset keeps it at the same local time all year.',
    `$trigger.StartBoundary = ${at}`,
  );
  if (r && t.kind !== 'once') {
    lines.push(
      '# Daily and weekly triggers take no repetition parameters; copy the repetition from a one-time trigger.',
      `$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At ${at}${repetitionArgs(r)}).Repetition`,
    );
  }
  if (r && r.durationMinutes !== null) {
    lines.push('# Do not stop a run that is still going when the repetition duration ends (the cmdlet turns this on).', '$trigger.Repetition.StopAtDurationEnd = $false');
  }
  const reasons: string[] = [];
  const name = details.name === '' ? null : checkTaskName(details.name) === null ? psQuote(details.name) : null;
  const program = details.program === '' ? null : psQuote(details.program);
  const args = details.arguments === '' ? null : psQuote(details.arguments);
  if (details.name !== '' && checkTaskName(details.name)) reasons.push(`Task name: ${checkTaskName(details.name)} A placeholder is used instead.`);
  if (program && !program.ok) reasons.push(`Program: ${program.error.message} A placeholder is used instead.`);
  if (args && !args.ok) reasons.push(`Arguments: ${args.error.message} A placeholder is used instead.`);
  const nameText = name && name.ok ? name.value : "'<TASK NAME>'";
  const programText = program && program.ok ? program.value : "'<PROGRAM>'";
  const argsText = args && args.ok ? ` -Argument ${args.value}` : '';
  const template = !(name && name.ok) || !(program && program.ok);
  lines.push(
    '',
    template ? '# Template: replace the values in angle brackets, review, then run these lines yourself.' : '# Review these lines before you run them yourself.',
    '# Registering a task for yourself needs no elevation; NetForge adds no credentials or run level.',
    `$action = New-ScheduledTaskAction -Execute ${programText}${argsText}`,
    `Register-ScheduledTask -TaskName ${nameText} -Trigger $trigger -Action $action`,
  );
  return { supported: true, text: `${lines.join('\n')}\n`, template, reasons, notes: [] };
}

export type DateFormat = 'MDY' | 'DMY' | 'YMD';
export const DATE_FORMAT_LABEL: Readonly<Record<DateFormat, string>> = { MDY: 'MM/DD/YYYY', DMY: 'DD/MM/YYYY', YMD: 'YYYY/MM/DD' };

function schtasksDate(s: LocalDateTime, f: DateFormat): string {
  const y = String(s.year).padStart(4, '0');
  const m = String(s.month).padStart(2, '0');
  const d = String(s.day).padStart(2, '0');
  return f === 'MDY' ? `${m}/${d}/${y}` : f === 'DMY' ? `${d}/${m}/${y}` : `${y}/${m}/${d}`;
}

const SCH_DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const SCH_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SCH_WEEKS: Readonly<Record<string, string>> = { 1: 'FIRST', 2: 'SECOND', 3: 'THIRD', 4: 'FOURTH', last: 'LAST' };
/** schtasks limits /TR to 261 characters. */
export const SCHTASKS_TR_LIMIT = 261;

function duration(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(4, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A schtasks.exe /Create command line for Command Prompt. */
export function schtasksCommand(t: WindowsTrigger, details: TaskDetails, dateFormat: DateFormat): GeneratedText {
  const unsupported = (reason: string): GeneratedText => ({ supported: false, text: '', template: false, reasons: [reason], notes: [] });
  const s = t.start;
  if (s.second !== 0) return unsupported('schtasks /ST takes hours and minutes only.');
  const args: string[] = [];
  let needsDate = false;
  switch (t.kind) {
    case 'once': args.push('/SC ONCE'); needsDate = true; break;
    case 'daily': args.push('/SC DAILY'); if (t.daysInterval > 1) { args.push(`/MO ${t.daysInterval}`); needsDate = true; } break;
    case 'weekly':
      args.push('/SC WEEKLY');
      if (t.weeksInterval > 1) { args.push(`/MO ${t.weeksInterval}`); needsDate = true; }
      args.push(`/D ${[...t.days].sort((a, b) => a - b).map(d => SCH_DAYS[d]).join(',')}`);
      break;
    case 'monthly':
      if (t.lastDay && t.days.length > 0) return unsupported('schtasks takes either days of the month or LASTDAY in one task, not both.');
      if (t.days.length > 1) return unsupported('schtasks takes one day of the month per task; create one task per day, or use Task Scheduler for several days.');
      args.push('/SC MONTHLY');
      if (t.lastDay) args.push('/MO LASTDAY', `/M ${t.months.length === 12 ? '*' : t.months.map(m => SCH_MONTHS[m - 1]).join(',')}`);
      else {
        args.push(`/D ${t.days[0]}`);
        if (t.months.length < 12) args.push(`/M ${t.months.map(m => SCH_MONTHS[m - 1]).join(',')}`);
      }
      break;
    case 'monthly-dow':
      if (t.weeks.length > 1 || t.days.length > 1) return unsupported('schtasks takes one week of the month (/MO) and one weekday (/D) per monthly task.');
      args.push('/SC MONTHLY', `/MO ${SCH_WEEKS[String(t.weeks[0])]}`, `/D ${SCH_DAYS[t.days[0]]}`);
      if (t.months.length < 12) args.push(`/M ${t.months.map(m => SCH_MONTHS[m - 1]).join(',')}`);
      break;
  }
  if (needsDate) args.push(`/SD ${schtasksDate(s, dateFormat)}`);
  args.push(`/ST ${formatClock(s.hour, s.minute)}`);
  const r = t.repetition;
  if (r) {
    if (r.durationMinutes === null) return unsupported('schtasks cannot repeat indefinitely: the longest /DU is 9999:59.');
    if (r.intervalMinutes > 599_940) return unsupported('schtasks /RI allows at most 599940 minutes.');
    args.push(`/RI ${r.intervalMinutes}`, `/DU ${duration(r.durationMinutes)}`);
  }
  const reasons: string[] = [];
  let nameText = '"<TASK NAME>"';
  if (details.name !== '') {
    const problem = checkTaskName(details.name);
    const q = cmdQuote(details.name);
    if (problem) reasons.push(`Task name: ${problem} A placeholder is used instead.`);
    else if (!q.ok) reasons.push(`Task name: ${q.error.message} A placeholder is used instead.`);
    else nameText = q.value;
  }
  let trText = '"<COMMAND>"';
  if (details.program !== '') {
    const program = details.program.includes(' ') ? `\\"${details.program}\\"` : details.program;
    const full = details.arguments === '' ? program : `${program} ${details.arguments}`;
    const raw = details.arguments === '' ? details.program : `${details.program} ${details.arguments}`;
    const check = cmdQuote(raw);
    if (!check.ok) reasons.push(`Command: ${check.error.message} A placeholder is used instead.`);
    // Inside /TR the path is wrapped in escaped quotes. A final backslash would join the one that
    // escapes the closing quote, end the argument early and turn what follows into schtasks options.
    else if (details.program.includes(' ') && details.program.endsWith('\\')) reasons.push('Command: a program path that has spaces and ends in a backslash would escape its closing quote. Remove the final backslash. A placeholder is used instead.');
    else if (full.length > SCHTASKS_TR_LIMIT) reasons.push(`Command: schtasks allows at most ${SCHTASKS_TR_LIMIT} characters in /TR. A placeholder is used instead.`);
    else trText = `"${full}"`;
  }
  const template = nameText.startsWith('"<') || trText.startsWith('"<');
  const text = `schtasks /Create /TN ${nameText} /TR ${trText} ${args.join(' ')}\n`;
  const notes: string[] = ['For Command Prompt (cmd.exe). It creates the task for the current user and adds no /RU, /RP or /RL HIGHEST, so it needs no stored password or elevation.'];
  if (needsDate) notes.push(`/SD is written as ${DATE_FORMAT_LABEL[dateFormat]}. schtasks reads it in the computer's short date format, so match that setting.`);
  if (/[^ -~]/.test(details.name + details.program + details.arguments)) notes.push('Characters outside ASCII depend on the Command Prompt code page.');
  return { supported: true, text, template, reasons, notes };
}

/** A .timer unit preview for an OnCalendar= expression. The service it starts is not generated. */
export function timerUnit(onCalendar: string, unitName: string): GeneratedText {
  const reasons: string[] = [];
  let stem = '<NAME>';
  if (unitName !== '') {
    const problem = checkUnitName(unitName.replace(/\.(timer|service)$/, ''));
    if (problem) reasons.push(`Unit name: ${problem} A placeholder is used instead.`);
    else stem = unitName.replace(/\.(timer|service)$/, '');
  }
  const template = stem === '<NAME>';
  const lines = [
    `# ${stem}.timer`,
    `# Starts ${stem}.service, which you write yourself; NetForge does not generate the service.`,
    template ? '# Template: replace <NAME> and <DESCRIPTION>, review, then install it with your usual procedure.' : '# Review it, then install it with your usual procedure, for example: systemctl enable --now ' + `${stem}.timer`,
    '[Unit]',
    template ? 'Description=<DESCRIPTION>' : `Description=Timer for ${stem}.service`,
    '',
    '[Timer]',
    `OnCalendar=${onCalendar}`,
    '# Optional: Persistent=true runs a missed activation after the next boot.',
    '# AccuracySec= defaults to 1min: the timer may elapse up to that long after the calendar time.',
    '',
    '[Install]',
    'WantedBy=timers.target',
  ];
  return { supported: true, text: `${lines.join('\n')}\n`, template, reasons, notes: [] };
}

