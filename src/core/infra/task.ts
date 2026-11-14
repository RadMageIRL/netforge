/**
 * A scheduled task example for the PowerShell Generator, built entirely by the Phase 3 scheduling
 * engine: the schedule is validated by the Schedule Builder's rules, translated into a Windows
 * Task Scheduler trigger, and written by the same PowerShell writer. This module only presents
 * that result in the shared export shape. The task name and the program are never invented:
 * without them the output keeps clearly marked placeholders.
 */
import { buildSchedule, validateBuilder, type BuilderInput, type Frequency } from '../schedule/builder';
import type { TaskDetails } from '../schedule/commands';
import { ItemBuilder, output, refused, type ExportOutput } from './model';

/** The schedule kinds offered here. The Schedule Builder has the rest. */
export const TASK_FREQUENCIES: readonly Frequency[] = ['daily', 'weekdays', 'weekly', 'hourly', 'minutes'];

export interface TaskOptions {
  readonly frequency: Frequency;
  /** HH:MM for daily, weekdays and weekly. */
  readonly time: string;
  /** 0 (Sunday) to 6, for weekly. */
  readonly weekday: string;
  /** For "minutes": 1 to 59. For "hourly": 1 to 23. */
  readonly every: string;
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly zone: string;
  readonly details: TaskDetails;
}

const FIELD_LABEL: Readonly<Partial<Record<keyof BuilderInput, string>>> = {
  time: 'Time', weekday: 'Day of the week', everyMinutes: 'Every', everyHours: 'Every', minute: 'Minute', startDate: 'Start date', zone: 'Time zone',
};

export function taskScript(options: TaskOptions): ExportOutput {
  if (!TASK_FREQUENCIES.includes(options.frequency)) return refused(['Choose one of the schedules offered here. The Schedule Builder covers the others.']);
  // As a quoted command argument, "--%" is still PowerShell's stop-parsing token: the rest of the
  // line would be taken verbatim up to a pipe character, and whatever follows the pipe would run.
  const d = options.details;
  if (d.name === '--%' || d.program === '--%' || d.arguments === '--%') {
    return refused(['"--%" is the stop-parsing token of PowerShell and cannot be used as a task name, a program or the arguments: PowerShell would stop reading the rest of the command as parameters.']);
  }
  const input: BuilderInput = {
    frequency: options.frequency, everyMinutes: options.every, everyHours: options.every, minute: '0', time: options.time,
    weekday: options.weekday, everyWeeks: '1', weekdays: [], monthlyKind: 'day', monthDay: '1', nth: '1', nthWeekday: '1',
    zone: options.zone, startDate: options.startDate,
  };
  const checked = validateBuilder(input);
  if (!checked.spec) return refused(checked.issues.map(i => `${FIELD_LABEL[i.field] ?? i.field}: ${i.message}`));
  const built = buildSchedule(checked.spec, options.details);
  const ps = built.translations.find(t => t.target === 'powershell');
  if (!ps || ps.fidelity === 'unsupported') return refused(ps ? [...ps.differences] : ['The scheduling engine produced no PowerShell output.']);
  const item = new ItemBuilder(`Scheduled task: ${built.description.replace(/\.$/, '')}`);
  item.wrote('a trigger, an action and a Register-ScheduledTask command');
  if (ps.fidelity === 'approximate') for (const d of ps.differences) item.approximate('Schedule', d);
  for (const w of checked.warnings) item.remark(w);
  for (const n of ps.notes) item.remark(n);
  return output({
    files: [{ name: 'netforge-scheduled-task.ps1', kind: 'PowerShell', mime: 'text/plain', text: ps.text }],
    items: [item.build()],
    assumptions: [...ps.conditions, 'Windows 8 or Windows Server 2012 or later, with the ScheduledTasks module that ships with Windows.'],
    manualSteps: [
      ...(ps.template ? ['Replace every value in angle brackets. NetForge does not invent a task name or a program to run.'] : []),
      'Review the commands and run them yourself. The Schedule Builder shows the next runs and the other schedule kinds.',
    ],
    notCovered: ['Credentials, run levels, conditions and settings (idle, power, network). The task is registered for the person who runs the commands.', 'Monthly schedules: New-ScheduledTaskTrigger has none. The Schedule Builder writes them for schtasks.exe.'],
    privileges: ['No administrator rights are needed to register a task for yourself. Registering one that runs as another account or with highest privileges does need them, and NetForge writes neither.'],
  });
}
