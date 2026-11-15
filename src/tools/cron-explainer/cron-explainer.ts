/**
 * Cron Explainer: standard cron, Quartz and systemd calendar expressions, each read by its own
 * parser. Explains every field, lists the next 10 runs in a chosen zone and UTC, and marks times
 * that DST changes skip or repeat. Nothing is stored and nothing leaves the page.
 */
import { toJsonText } from '../../core/export/files';
import { timerUnit } from '../../core/schedule/commands';
import { cronDstPolicy, cronPattern, explainCron, parseCron } from '../../core/schedule/cron';
import { dstImpacts } from '../../core/schedule/dst';
import { DIALECT_LABEL, type CalendarPattern, type DialectId, type DstPolicy, type Explanation, type ScheduleError } from '../../core/schedule/model';
import { explainQuartz, parseQuartz, quartzPattern, QUARTZ_DST_POLICY } from '../../core/schedule/quartz';
import { explainJson, explainText, runsCsv, runViews, stopMessage, type ExplainReport } from '../../core/schedule/reports';
import { DEFAULT_RUN_COUNT, nextPatternRuns, patternWalls } from '../../core/schedule/search';
import { explainSystemd, parseSystemd, systemdPattern, SYSTEMD_DST_POLICY } from '../../core/schedule/systemd';
import { words } from '../../core/schedule/tokens';
import { browserTimeZone } from '../../core/time/zones';
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { cronOffer, readCronShare } from './cron-share';
import { button, copyButton, dataTable, emptyState, notice, panel, segmented, selectField, textField, toolPage } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { DEVICE_ZONE, hasOption, zoneGroups } from '../../ui/zone-select';
import { caretLine, codeBlock, dstSection, readStart, runTable, section, warnings } from '../schedule-shared/schedule-view';

interface DialectInfo {
  readonly label: string;
  readonly placeholder: string;
  readonly hint: string;
  readonly examples: readonly { label: string; text: string }[];
}

const DIALECTS: Readonly<Record<DialectId, DialectInfo>> = {
  cron: {
    label: 'Standard cron', placeholder: '*/15 * * * *',
    hint: 'Five fields: minute, hour, day of month, month, day of week (0 or 7 is Sunday). Also @daily, @weekly and the other nicknames.',
    examples: [
      { label: 'Every 15 minutes', text: '*/15 * * * *' }, { label: 'Weekdays 09:00', text: '0 9 * * 1-5' },
      { label: '1st and 15th', text: '30 2 1,15 * *' }, { label: 'OR rule', text: '0 0 1-7 * 1' }, { label: '@weekly', text: '@weekly' },
    ],
  },
  quartz: {
    label: 'Quartz', placeholder: '0 0/15 * * * ?',
    hint: 'Six or seven fields: second, minute, hour, day of month, month, day of week (1 is Sunday), optional year. One day field must be ?.',
    examples: [
      { label: 'Every 15 minutes', text: '0 0/15 * * * ?' }, { label: 'Last Friday', text: '0 15 10 ? * 6L' },
      { label: 'Nearest weekday', text: '0 0 12 15W * ?' }, { label: '2nd Monday', text: '0 0 9 ? * 2#2' }, { label: 'Last day', text: '0 0 18 L * ?' },
    ],
  },
  systemd: {
    label: 'systemd calendar', placeholder: 'Mon..Fri *-*-* 09:00:00',
    hint: 'An OnCalendar= value: [weekdays] [year-month-day] [hour:minute:second] [time zone], or a shorthand such as daily or weekly.',
    examples: [
      { label: 'Weekdays 09:00', text: 'Mon..Fri 09:00' }, { label: 'Every 15 minutes', text: '*:0/15' },
      { label: 'Last day', text: '*-*~01 18:00' }, { label: 'Last Monday of May', text: 'Mon *-05~07/1' }, { label: 'weekly', text: 'weekly Europe/Berlin' },
    ],
  },
};

interface Parsed {
  readonly explanation: Explanation;
  readonly pattern: CalendarPattern;
  readonly policy: DstPolicy;
  /** The expression's own zone (systemd), or null. */
  readonly zone: string | null;
}

function parse(dialect: DialectId, text: string): { ok: true; value: Parsed } | { ok: false; error: ScheduleError } {
  if (dialect === 'cron') {
    const r = parseCron(text);
    return r.ok ? { ok: true, value: { explanation: explainCron(r.value), pattern: cronPattern(r.value), policy: cronDstPolicy(r.value), zone: null } } : r;
  }
  if (dialect === 'quartz') {
    const r = parseQuartz(text);
    return r.ok ? { ok: true, value: { explanation: explainQuartz(r.value), pattern: quartzPattern(r.value), policy: QUARTZ_DST_POLICY, zone: null } } : r;
  }
  const r = parseSystemd(text);
  return r.ok ? { ok: true, value: { explanation: explainSystemd(r.value), pattern: systemdPattern(r.value), policy: SYSTEMD_DST_POLICY, zone: r.value.zone } } : r;
}

/** When a field-count error looks like the other cron dialect, offer an explicit switch (never an automatic one). */
function otherDialect(dialect: DialectId, text: string): DialectId | null {
  const n = words(text.trim()).length;
  if (dialect === 'cron' && (n === 6 || n === 7) && parseQuartz(text).ok) return 'quartz';
  if (dialect === 'quartz' && (n === 5 || text.trim().startsWith('@')) && parseCron(text).ok) return 'cron';
  return null;
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  const device = browserTimeZone();
  let dialect: DialectId = 'cron';
  let zoneChoice = DEVICE_ZONE;
  let report: ExplainReport | null = null;
  let timer = 0;

  const field = textField({ id: 'cron-input', label: 'Expression', mono: true, placeholder: DIALECTS.cron.placeholder, hint: DIALECTS.cron.hint });
  const input = field.control;
  const zoneField = selectField({ id: 'cron-zone', label: 'Time zone', groups: zoneGroups(device), value: DEVICE_ZONE, hint: 'Runs are computed and shown in this zone.' });
  const fromField = textField({ id: 'cron-from', label: 'List runs after', mono: true, placeholder: 'now', hint: 'Optional: a date and time in that zone, such as 2026-03-08 00:00, or with an offset or Z. Empty means now.' });
  const examples = h('div', { class: 'examples' });
  const result = h('div', { class: 'result-area', id: 'cron-result' });

  const dialectControl = segmented({
    label: 'Dialect', name: 'cron-dialect', value: dialect,
    choices: (Object.keys(DIALECTS) as DialectId[]).map(id => ({ value: id, label: DIALECTS[id].label })),
    onChange: value => setDialect(value as DialectId),
  });

  function setDialect(next: DialectId): void {
    dialect = next;
    dialectControl.set(next);
    input.placeholder = DIALECTS[next].placeholder;
    const hint = field.root.querySelector('.hint');
    if (hint) hint.textContent = DIALECTS[next].hint;
    renderExamples();
    update();
  }

  function renderExamples(): void {
    replaceChildren(examples, h('span', null, 'Examples:'), DIALECTS[dialect].examples.map(e =>
      h('button', { type: 'button', class: 'chip', title: e.label, onclick: () => { input.value = e.text; update(); input.focus(); } }, e.text)));
  }

  const zone = () => (zoneChoice === DEVICE_ZONE ? device : zoneChoice);
  const copy = copyButton(services, () => (report ? explainText(report) : null), 'explanation and next runs', { label: 'Copy results' });
  const csv = button({ label: 'CSV', icon: 'download', title: 'Download the next runs as CSV', onClick: () => { if (report) services.download(`schedule-${report.dialect}-runs.csv`, runsCsv(report.views, report.zone), 'text/csv'); } });
  const json = button({ label: 'JSON', icon: 'download', title: 'Download the explanation and runs as JSON', onClick: () => { if (report) services.download(`schedule-${report.dialect}.json`, toJsonText(explainJson(report)), 'application/json'); } });
  const setActions = () => { for (const b of [copy, csv, json]) b.disabled = report === null; };

  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(update, 120); };

  function update(): void {
    window.clearTimeout(timer);
    report = null;
    field.setError(null);
    fromField.setError(null);
    const text = input.value;
    if (text.trim() === '') {
      replaceChildren(result, emptyState(`Enter a ${DIALECTS[dialect].label} expression, or pick an example.`));
      setActions();
      return;
    }
    const parsed = parse(dialect, text);
    if (!parsed.ok) {
      const e = parsed.error;
      field.setError(e.message);
      const other = otherDialect(dialect, text);
      replaceChildren(result,
        e.offset !== undefined ? caretLine(text, e.offset, e.length ?? 1) : null,
        other ? h('div', { class: 'toolbar' }, button({ label: `Read as ${DIALECTS[other].label}`, id: 'cron-switch', onClick: () => setDialect(other) })) : null,
        emptyState('Fix the expression to see its meaning and next runs.'),
      );
      setActions();
      return;
    }
    const p = parsed.value;
    const evalZone = p.zone ?? zone();
    const start = readStart(fromField.control.value, evalZone, Date.now());
    if (!start.ok) {
      fromField.setError(start.message);
      replaceChildren(result, emptyState('Fix the start time to see the next runs.'));
      setActions();
      return;
    }
    const runs = nextPatternRuns(p.pattern, evalZone, start.ms, p.policy, { count: DEFAULT_RUN_COUNT });
    const views = runViews(runs, p.policy);
    const impacts = dstImpacts(w => patternWalls(p.pattern, w, p.pattern.lastYear), evalZone, start.ms);
    const stop = stopMessage(runs, DEFAULT_RUN_COUNT);
    report = { dialect, expression: text.trim(), zone: evalZone, fromMs: start.ms, explanation: p.explanation, views, stop, policy: p.policy, impacts };
    const ex = p.explanation;
    replaceChildren(result,
      h('p', { class: 'schedule-summary', id: 'cron-summary' }, ex.summary),
      ex.normalized ? h('p', { class: 'reach-note', id: 'cron-normalized' }, `${dialect === 'systemd' ? 'Normalized form' : 'Expands to'}: `, h('code', { class: 'mono' }, ex.normalized)) : null,
      warnings(ex.warnings, 'cron-warnings'),
      p.zone && p.zone !== zone() ? notice('info', h('p', null, `This expression names its own time zone, so runs are shown in ${p.zone}.`)) : null,
      start.note ? notice('info', h('p', null, start.note)) : null,
      section('Fields', dataTable(`Fields of the ${DIALECT_LABEL[dialect]} expression`, [
        { key: 'field', label: 'Field' }, { key: 'text', label: 'Written', mono: true }, { key: 'meaning', label: 'Meaning' }, { key: 'values', label: 'Matches', mono: true },
      ], ex.fields.map(f => ({ field: f.field, text: f.text, meaning: f.meaning, values: f.values })), 'cron-fields')),
      section(`Next ${DEFAULT_RUN_COUNT} runs`,
        views.length > 0 ? runTable(views, `Next runs in ${evalZone} and UTC`, evalZone, 'cron-runs') : null,
        stop ? notice(runs.found === 0 ? 'error' : 'warning', h('p', { id: 'cron-stop' }, stop)) : null,
        h('p', { class: 'source-note' }, 'These are the times the expression selects. Whether a job really starts then also depends on the scheduler running, its load, and its settings.'),
      ),
      dstSection(p.policy, impacts, evalZone, 'cron-dst'),
      dialect === 'systemd' && ex.normalized ? timerPreview(ex.normalized) : null,
      h('ul', { class: 'privacy-list notes-list', id: 'cron-notes' }, ex.notes.map(n => h('li', null, n))),
    );
    setActions();
  }

  /** A .timer unit around the expression; a template, since the explainer knows no unit name. */
  function timerPreview(onCalendar: string): HTMLElement {
    const unit = timerUnit(onCalendar, '');
    return h('details', { class: 'disclosure-inline', id: 'cron-timer-unit' },
      h('summary', null, 'Timer unit preview'),
      h('p', { class: 'reach-note' }, 'Template: an OnCalendar= expression is one setting of a .timer unit. Replace <NAME> and <DESCRIPTION>; the service it starts is yours to write. The Schedule Builder can fill in a unit name.'),
      codeBlock(unit.text, 'Timer unit preview', 'cron-timer-text'),
      h('div', { class: 'toolbar' }, copyButton(services, () => unit.text, 'timer unit', { label: 'Copy timer unit' })),
    );
  }

  input.addEventListener('input', schedule);
  fromField.control.addEventListener('input', schedule);
  zoneField.control.addEventListener('change', () => { zoneChoice = zoneField.control.value; update(); });
  renderExamples();

  host.appendChild(toolPage(meta, categoryName,
    panel('Expression', [dialectControl.root, field.root, examples, h('div', { class: 'controls-row' }, zoneField.root, fromField.root)]),
    panel('Result', [result], h('div', { class: 'toolbar' }, copy, csv, json), 'result-panel'),
  ));
  update();
  // "Now" moves on while the view is hidden; recompute when it is shown again.
  return {
    activate: update,
    share: {
      offer: () => cronOffer({ dialect, expression: input.value, zone: zoneChoice === DEVICE_ZONE ? null : zoneChoice, from: fromField.control.value }),
      apply(params) {
        const s = readCronShare(params);
        if (!s || (s.zone !== null && !hasOption(zoneField.control, s.zone))) return false;
        input.value = s.expression;
        fromField.control.value = s.from ?? '';
        zoneChoice = s.zone ?? DEVICE_ZONE;
        zoneField.control.value = zoneChoice;
        setDialect(s.dialect);
        return true;
      },
    },
  };
}
