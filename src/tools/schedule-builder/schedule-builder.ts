/**
 * Schedule Builder: choose a schedule, get standard cron, Quartz, systemd and Windows Task
 * Scheduler (PowerShell and schtasks) versions, each labeled Exact, Approximate or Unsupported,
 * with the differences, conditions and DST behavior spelled out. Commands are text to review;
 * nothing is run, stored or sent.
 */
import { toJsonText } from '../../core/export/files';
import {
  BUILDER_DST_POLICY, FREQUENCY_LABEL, buildSchedule, intendedPattern, intendedRuns, todayIn, translationRuns, validateBuilder,
  type BuilderInput, type BuilderResult, type Fidelity, type Frequency, type MonthlyKind, type Nth, type Translation,
} from '../../core/schedule/builder';
import { DATE_FORMAT_LABEL, type DateFormat } from '../../core/schedule/commands';
import { WEEKDAY_NAMES } from '../../core/schedule/calendar';
import { dstImpacts } from '../../core/schedule/dst';
import { builderJson, builderText, runsCsv, runViews, stopMessage, type RunView } from '../../core/schedule/reports';
import { DEFAULT_RUN_COUNT, patternWalls, type NextRuns } from '../../core/schedule/search';
import { browserTimeZone } from '../../core/time/zones';
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { builderOffer, readBuilderShare } from './builder-share';
import { button, checkbox, copyButton, emptyState, notice, panel, segmented, selectField, textField, toolPage, type FieldHandle } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { DEVICE_ZONE, hasOption, zoneGroups } from '../../ui/zone-select';
import { bulletList, codeBlock, dstSection, runTable, section, warnings } from '../schedule-shared/schedule-view';

const FIDELITY_TEXT: Readonly<Record<Fidelity, string>> = { exact: 'Exact', approximate: 'Approximate', unsupported: 'Unsupported' };
const FIDELITY_BADGE: Readonly<Record<Fidelity, string>> = { exact: 'badge badge-ok', approximate: 'badge badge-warning', unsupported: 'badge badge-error' };
/** Monday first, as most schedules are written. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function numberField(id: string, label: string, value: string, hint?: string): FieldHandle<HTMLInputElement> {
  const f = textField({ id, label, value, hint, mono: true });
  f.control.inputMode = 'numeric';
  f.control.classList.add('input-short');
  return f;
}

function weekdaySelect(id: string, label: string, value: string): FieldHandle<HTMLSelectElement> {
  return selectField({ id, label, value, groups: [{ label: null, options: DAY_ORDER.map(d => ({ value: String(d), label: WEEKDAY_NAMES[d] })) }] });
}

/** Compares an output's runs with the schedule's: null when they agree. */
function compareRuns(intended: NextRuns, actual: NextRuns): string | null {
  const a = intended.rows.filter(r => r.type === 'run' && r.index !== null);
  const b = actual.rows.filter(r => r.type === 'run' && r.index !== null);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x.type === 'run' && y.type === 'run' && x.epochMs !== y.epochMs) {
      return `Differs from the schedule at run ${i + 1}: ${new Date(y.epochMs).toISOString().replace('.000', '')} instead of ${new Date(x.epochMs).toISOString().replace('.000', '')}.`;
    }
  }
  if (a.length !== b.length) return `Found ${b.length} runs where the schedule has ${a.length}.`;
  return null;
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  const device = browserTimeZone();
  let zoneChoice = DEVICE_ZONE;
  let result: BuilderResult | null = null;
  let intendedViews: RunView[] = [];
  let fromMs = Date.now();
  let timer = 0;
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(update, 120); };

  const frequency = selectField({
    id: 'builder-frequency', label: 'Repeat', value: 'daily',
    groups: [{ label: null, options: (Object.keys(FREQUENCY_LABEL) as Frequency[]).map(f => ({ value: f, label: FREQUENCY_LABEL[f] })) }],
  });
  const everyMinutes = numberField('builder-every-minutes', 'Every (minutes)', '15', '1 to 59. Counted from minute 0 of each hour.');
  const everyHours = numberField('builder-every-hours', 'Every (hours)', '1', '1 to 23. Counted from midnight.');
  const minute = numberField('builder-minute', 'At minute', '0', 'Minute past the hour, 0 to 59.');
  const time = textField({ id: 'builder-time', label: 'Time of day', value: '09:00', mono: true });
  time.control.type = 'time';
  const weekday = weekdaySelect('builder-weekday', 'Day of the week', '1');
  const everyWeeks = numberField('builder-every-weeks', 'Every (weeks)', '1', '1 to 52. Weeks are counted from the week of the start date.');
  const dayChecks = DAY_ORDER.map(d => checkbox({ id: `builder-day-${d}`, label: WEEKDAY_NAMES[d], checked: d === 1 || d === 3 || d === 5, onChange: () => update() }));
  const daysGroup = h('fieldset', { class: 'check-group', id: 'builder-days' }, h('legend', { class: 'field-label' }, 'Days of the week'), h('div', { class: 'check-list' }, dayChecks.map(c => c.root)));
  const daysError = h('p', { class: 'field-error', id: 'builder-days-error', hidden: true });
  daysGroup.appendChild(daysError);
  let monthlyKind: MonthlyKind = 'day';
  const monthlyControl = segmented({
    label: 'Day of the month', name: 'builder-monthly', value: 'day',
    choices: [{ value: 'day', label: 'Date' }, { value: 'last-day', label: 'Last day' }, { value: 'nth', label: 'Weekday of the month' }],
    onChange: v => { monthlyKind = v as MonthlyKind; update(); },
  });
  const monthDay = numberField('builder-month-day', 'Day', '1', '1 to 31. Months without that day have no run.');
  const nth = selectField({ id: 'builder-nth', label: 'Which', value: '1', groups: [{ label: null, options: [{ value: '1', label: 'First' }, { value: '2', label: 'Second' }, { value: '3', label: 'Third' }, { value: '4', label: 'Fourth' }, { value: 'last', label: 'Last' }] }] });
  const nthWeekday = weekdaySelect('builder-nth-weekday', 'Weekday', '1');
  const zoneField = selectField({ id: 'builder-zone', label: 'Time zone', groups: zoneGroups(device), value: DEVICE_ZONE });
  const startField = textField({ id: 'builder-start', label: 'Start date', value: todayIn(device, Date.now()), mono: true, hint: 'The Windows start boundary, and the first week of an every-N-weeks schedule.' });
  startField.control.type = 'date';

  const nameField = textField({ id: 'builder-name', label: 'Task or unit name', hint: 'Used in the Windows commands and the timer unit. Left empty, they keep a <TASK NAME> or <NAME> placeholder.' });
  const programField = textField({ id: 'builder-program', label: 'Program to run (Windows)', mono: true, hint: 'A full path. Left empty, the commands keep a placeholder.' });
  const argumentsField = textField({ id: 'builder-arguments', label: 'Arguments (Windows)', mono: true });
  const dateFormat = selectField({
    id: 'builder-date-format', label: 'schtasks /SD date format', value: 'MDY',
    hint: 'schtasks reads dates in the computer\'s short date format.',
    groups: [{ label: null, options: (Object.keys(DATE_FORMAT_LABEL) as DateFormat[]).map(f => ({ value: f, label: DATE_FORMAT_LABEL[f] })) }],
  });
  const details = h('details', { class: 'disclosure-inline', id: 'builder-details' },
    h('summary', null, 'Names for the generated commands (optional)'),
    h('div', { class: 'option-stack' }, nameField.root, programField.root, argumentsField.root, dateFormat.root),
  );

  const timeRow = h('div', { class: 'controls-row' }, time.root, weekday.root, everyWeeks.root);
  const monthlyRow = h('div', { class: 'controls-row' }, monthDay.root, nth.root, nthWeekday.root);
  const choices = h('div', { class: 'option-stack', id: 'builder-choices' },
    h('div', { class: 'controls-row' }, frequency.root, everyMinutes.root, everyHours.root, minute.root),
    timeRow, daysGroup, monthlyControl.root, monthlyRow,
    h('div', { class: 'controls-row' }, zoneField.root, startField.root),
    details,
  );

  const summaryArea = h('div', { class: 'result-area', id: 'builder-summary' });
  const outputs = h('div', { class: 'output-grid', id: 'builder-outputs' });

  const copyAll = copyButton(services, () => (result ? builderText(result) : null), 'all outputs', { label: 'Copy all' });
  const json = button({ label: 'JSON', icon: 'download', title: 'Download every output and the next runs as JSON', onClick: () => { if (result) services.download('schedule-builder.json', toJsonText(builderJson(result, intendedViews, fromMs)), 'application/json'); } });
  const csv = button({ label: 'CSV', icon: 'download', title: 'Download the next runs as CSV', onClick: () => { if (result) services.download('schedule-builder-runs.csv', runsCsv(intendedViews, result.spec.zone), 'text/csv'); } });

  const zone = () => (zoneChoice === DEVICE_ZONE ? device : zoneChoice);

  function input(): BuilderInput {
    return {
      frequency: frequency.control.value as Frequency,
      everyMinutes: everyMinutes.control.value, everyHours: everyHours.control.value, minute: minute.control.value,
      time: time.control.value, weekday: weekday.control.value, everyWeeks: everyWeeks.control.value,
      weekdays: dayChecks.map((c, i) => (c.input.checked ? DAY_ORDER[i] : -1)).filter(d => d >= 0),
      monthlyKind, monthDay: monthDay.control.value, nth: nth.control.value as Nth, nthWeekday: nthWeekday.control.value,
      zone: zone(), startDate: startField.control.value,
    };
  }

  function showFields(f: Frequency): void {
    everyMinutes.root.hidden = f !== 'minutes';
    everyHours.root.hidden = f !== 'hourly';
    minute.root.hidden = f !== 'hourly';
    time.root.hidden = f === 'minutes' || f === 'hourly';
    weekday.root.hidden = f !== 'weekly';
    everyWeeks.root.hidden = f !== 'weekly';
    daysGroup.hidden = f !== 'days';
    monthlyControl.root.hidden = f !== 'monthly';
    monthlyRow.hidden = f !== 'monthly';
    monthDay.root.hidden = monthlyKind !== 'day';
    nth.root.hidden = monthlyKind !== 'nth';
    nthWeekday.root.hidden = monthlyKind !== 'nth';
  }

  const fieldsById: Partial<Record<keyof BuilderInput, FieldHandle<HTMLElement & { value: string }>>> = {
    everyMinutes, everyHours, minute, time, weekday, everyWeeks, monthDay, nthWeekday, zone: zoneField, startDate: startField,
  };

  function card(t: Translation, intended: NextRuns): HTMLElement {
    const id = `builder-card-${t.target}`;
    const runs = translationRuns(result!, t.target, fromMs, { count: DEFAULT_RUN_COUNT });
    const compare = runs ? compareRuns(intended, runs) : null;
    const head = h('div', { class: 'output-head' },
      h('h3', { class: 'output-title', id: `${id}-title` }, t.label),
      h('span', { class: `${FIDELITY_BADGE[t.fidelity]} fidelity`, 'data-fidelity': t.fidelity }, FIDELITY_TEXT[t.fidelity]),
      t.template ? h('span', { class: 'badge badge-info' }, 'Template') : null,
      t.text ? copyButton(services, () => t.text, t.label, { label: 'Copy' }) : null,
    );
    const timer = t.target === 'systemd' && result!.timerUnit ? h('details', { class: 'disclosure-inline', id: 'builder-timer-unit', 'data-key': 'timer-unit' },
      h('summary', null, 'Timer unit preview'),
      result!.timerUnit.template ? h('p', { class: 'reach-note' }, 'Template: it keeps <NAME> and <DESCRIPTION> placeholders until you enter a unit name above.') : null,
      bulletList(result!.timerUnit.reasons),
      codeBlock(result!.timerUnit.text, 'Timer unit preview', 'builder-timer-text'),
      h('div', { class: 'toolbar' }, copyButton(services, () => result?.timerUnit?.text ?? null, 'timer unit', { label: 'Copy timer unit' })),
    ) : null;
    return h('article', { class: `output-card fidelity-${t.fidelity}`, 'data-target': t.target, id, 'aria-labelledby': `${id}-title` },
      head,
      t.text ? codeBlock(t.text, `${t.label} output`, `builder-text-${t.target}`) : null,
      t.differences.length ? h('div', { class: 'output-section' },
        h('p', { class: 'output-label' }, t.fidelity === 'unsupported' ? 'Why it cannot be expressed' : 'How it differs from the schedule'),
        bulletList(t.differences)) : null,
      t.conditions.length ? h('div', { class: 'output-section' }, h('p', { class: 'output-label' }, 'Holds only if'), bulletList(t.conditions)) : null,
      t.notes.length ? h('div', { class: 'output-section' }, h('p', { class: 'output-label' }, 'Notes'), bulletList(t.notes)) : null,
      t.fidelity !== 'unsupported' ? h('p', { class: 'source-note' }, `DST changes: ${t.dst.basis}.`) : null,
      timer,
      runs ? h('details', { class: 'disclosure-inline', 'data-key': `runs-${t.target}` },
        h('summary', null, compare ? 'Next runs by these rules (they differ)' : 'Next runs by these rules'),
        h('p', { class: compare ? 'reach-note compare-differs' : 'reach-note compare-same' }, compare ?? `The same as the schedule's next ${DEFAULT_RUN_COUNT} runs.`),
        runTable(runViews(runs, t.dst), `${t.label}: next runs`, runs.zone, `builder-runs-${t.target}`),
      ) : null,
    );
  }

  function update(): void {
    window.clearTimeout(timer);
    fromMs = Date.now();
    const f = frequency.control.value as Frequency;
    showFields(f);
    for (const fh of Object.values(fieldsById)) fh?.setError(null);
    daysError.hidden = true;
    const v = validateBuilder(input());
    if (!v.spec) {
      for (const issue of v.issues) {
        if (issue.field === 'weekdays') { replaceChildren(daysError, issue.message); daysError.hidden = false; }
        else fieldsById[issue.field]?.setError(issue.message);
      }
      result = null;
      replaceChildren(summaryArea, emptyState('Fix the highlighted choices to see the schedule.'));
      replaceChildren(outputs);
      for (const b of [copyAll, json, csv]) b.disabled = true;
      return;
    }
    const spec = v.spec;
    result = buildSchedule(spec, { name: nameField.control.value.trim(), program: programField.control.value.trim(), arguments: argumentsField.control.value.trim() }, dateFormat.control.value as DateFormat);
    const intended = intendedRuns(spec, fromMs, { count: DEFAULT_RUN_COUNT });
    intendedViews = runViews(intended, BUILDER_DST_POLICY);
    const pattern = intendedPattern(spec);
    const impacts = dstImpacts(w => patternWalls(pattern, w, pattern.lastYear), spec.zone, fromMs);
    const stop = stopMessage(intended, DEFAULT_RUN_COUNT);
    replaceChildren(summaryArea,
      h('p', { class: 'schedule-summary', id: 'builder-description' }, result.description),
      warnings(v.warnings, 'builder-warnings'),
      section(`Next ${DEFAULT_RUN_COUNT} runs`, runTable(intendedViews, `Next runs in ${spec.zone} and UTC`, spec.zone, 'builder-runs'),
        stop ? notice('warning', h('p', null, stop)) : null),
      dstSection(BUILDER_DST_POLICY, impacts, spec.zone, 'builder-dst'),
    );
    // Outputs are rebuilt on every change; keep the disclosures the person opened open.
    const open = new Set([...outputs.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.key));
    replaceChildren(outputs, result.translations.map(t => card(t, intended)));
    for (const d of outputs.querySelectorAll<HTMLDetailsElement>('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
    for (const b of [copyAll, json, csv]) b.disabled = false;
  }

  for (const f of [everyMinutes, everyHours, minute, everyWeeks, monthDay, nameField, programField, argumentsField]) f.control.addEventListener('input', schedule);
  for (const f of [time, startField]) { f.control.addEventListener('input', schedule); f.control.addEventListener('change', update); }
  for (const f of [frequency, weekday, nth, nthWeekday, dateFormat]) f.control.addEventListener('change', update);
  zoneField.control.addEventListener('change', () => { zoneChoice = zoneField.control.value; update(); });

  host.appendChild(toolPage(meta, categoryName,
    panel('Schedule', [choices]),
    panel('Summary', [summaryArea], h('div', { class: 'toolbar' }, copyAll, csv, json), 'result-panel'),
    panel('Outputs', [
      h('p', { class: 'reach-note' }, 'Exact: runs at the same local times (DST changes aside; each output says how it handles them). Approximate: runs, but at times that differ, listed below. Unsupported: the format cannot express this schedule. Generated commands are text to review: NetForge never runs them.'),
      outputs,
    ]),
  ));
  update();
  return {
    activate: update,
    share: {
      offer: () => builderOffer({ ...input(), zone: zoneChoice === DEVICE_ZONE ? null : zoneChoice }, device),
      // The schedule only: the names for the generated commands are left as they are.
      apply(params) {
        const s = readBuilderShare(params);
        if (!s || (s.zone !== null && !hasOption(zoneField.control, s.zone))) return false;
        frequency.control.value = s.frequency;
        everyMinutes.control.value = s.everyMinutes;
        everyHours.control.value = s.everyHours;
        minute.control.value = s.minute;
        time.control.value = s.time;
        weekday.control.value = s.weekday;
        everyWeeks.control.value = s.everyWeeks;
        dayChecks.forEach((c, i) => { c.input.checked = s.weekdays.includes(DAY_ORDER[i]); });
        monthlyKind = s.monthlyKind;
        monthlyControl.set(s.monthlyKind);
        monthDay.control.value = s.monthDay;
        nth.control.value = s.nth;
        nthWeekday.control.value = s.nthWeekday;
        zoneChoice = s.zone ?? DEVICE_ZONE;
        zoneField.control.value = zoneChoice;
        if (s.startDate !== '') startField.control.value = s.startDate;
        update();
        return true;
      },
    },
  };
}
