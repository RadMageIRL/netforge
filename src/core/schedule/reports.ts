/**
 * Display rows, copied text, CSV and JSON for ScheduleForge. One row model feeds the on-screen
 * table and every export, so they cannot disagree.
 */
import { toCsv } from '../export/csv';
import { WEEKDAY_SHORT, formatClock, weekday } from './calendar';
import type { BuilderResult } from './builder';
import type { DstImpact } from './dst';
import { DIALECT_LABEL, type DstPolicy, type Explanation, type ScheduleModelId } from './model';
import type { NextRuns, ScheduleRow, StopReason } from './search';
import type { Transition } from './zone-timeline';
import { formatIsoUtc } from '../time/timestamp';
import { formatOffset, wallFromUtc } from '../time/zones';

export type RunStatus = 'scheduled' | 'uncertain' | 'skipped' | 'nonexistent';

export interface RunView {
  /** Position among counted runs, or '' for rows that do not count. */
  readonly index: string;
  /** "Mon 2026-11-16 09:00:00" (a range for collapsed rows). */
  readonly local: string;
  /** ISO 8601 with offset, or '' when the local time does not exist. */
  readonly localIso: string;
  readonly offset: string;
  /** "EST", or '' when the zone has no alphabetic abbreviation. */
  readonly abbreviation: string;
  readonly utc: string;
  readonly unixSeconds: string;
  readonly status: RunStatus;
  readonly statusLabel: string;
  readonly note: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function wallText(wallMs: number, withWeekday = true): string {
  const w = wallFromUtc(wallMs);
  const date = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
  const time = formatClock(w.hour, w.minute, w.second);
  return withWeekday ? `${WEEKDAY_SHORT[weekday(w.year, w.month, w.day)]} ${date} ${time}` : `${date} ${time}`;
}

function wallIso(wallMs: number, offsetMs: number): string {
  const w = wallFromUtc(wallMs);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${formatClock(w.hour, w.minute, w.second)}${formatOffset(offsetMs)}`;
}

const abbreviations = new Map<string, Intl.DateTimeFormat>();

/** The zone's short name at an instant when it is alphabetic (EST, CEST), else ''. */
export function zoneAbbreviation(epochMs: number, zone: string): string {
  let f = abbreviations.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' });
    abbreviations.set(zone, f);
  }
  const name = f.formatToParts(new Date(epochMs)).find(p => p.type === 'timeZoneName')?.value ?? '';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  return /^[A-Z]{2,5}$/.test(name) ? name : '';
}

function transitionText(t: Transition): string {
  const before = wallFromUtc(t.at + t.before);
  const after = wallFromUtc(t.at + t.after);
  const verb = t.after > t.before ? 'jump forward' : 'go back';
  return `Clocks ${verb} from ${formatClock(before.hour, before.minute)} to ${formatClock(after.hour, after.minute)} (UTC${formatOffset(t.before)} to UTC${formatOffset(t.after)}) at ${formatIsoUtc(t.at)}.`;
}

function view(row: ScheduleRow, zone: string, policy: DstPolicy): RunView {
  if (row.type === 'run') {
    const status: RunStatus = row.outcome === 'runs' ? 'scheduled' : row.outcome;
    let statusLabel = status === 'scheduled' ? 'Scheduled' : status === 'uncertain' ? 'Uncertain' : 'Skipped';
    let note = '';
    if (row.kind !== 'normal' && row.transition) {
      statusLabel += row.kind === 'repeated-first' ? ' (1st of 2)' : ' (2nd of 2)';
      const fromInside = row.kind === 'repeated-second' && row.outcome !== policy.repeatedSecond && policy.repeatedFromInsideNote;
      note = `${transitionText(row.transition)} ${fromInside || policy.repeatedNote}`;
    }
    return {
      index: row.index === null ? '' : String(row.index),
      local: wallText(row.wallMs),
      localIso: wallIso(row.wallMs, row.offsetMs),
      offset: formatOffset(row.offsetMs),
      abbreviation: zoneAbbreviation(row.epochMs, zone),
      utc: formatIsoUtc(row.epochMs),
      unixSeconds: String(Math.floor(row.epochMs / 1000)),
      status, statusLabel, note,
    };
  }
  const many = row.count > 1;
  const local = many ? `${wallText(row.firstWallMs)} to ${wallText(row.lastWallMs, false).slice(11)} (${row.count} times)` : wallText(row.firstWallMs);
  if (row.kind === 'nonexistent') {
    return {
      index: '', local, localIso: '', offset: '', abbreviation: '', utc: '', unixSeconds: '',
      status: row.outcome === 'skipped' ? 'skipped' : 'nonexistent',
      statusLabel: row.outcome === 'skipped' ? 'Skipped (does not exist)' : 'Does not exist',
      note: `${transitionText(row.transition)} ${policy.nonexistentNote}`,
    };
  }
  return {
    index: '', local, localIso: '', offset: formatOffset(row.transition.after), abbreviation: '', utc: '', unixSeconds: '',
    status: 'skipped', statusLabel: 'Skipped (repeat)',
    note: `${transitionText(row.transition)} ${policy.repeatedNote}`,
  };
}

export function runViews(runs: NextRuns, policy: DstPolicy): RunView[] {
  return runs.rows.map(r => view(r, runs.zone, policy));
}

export function stopMessage(runs: NextRuns, count: number): string | null {
  const s: StopReason | null = runs.stop;
  if (!s) return null;
  const n = runs.found;
  const runsWord = (k: number) => `${k} run${k === 1 ? '' : 's'}`;
  switch (s.kind) {
    case 'never': return 'This schedule never runs: no date matches all of its fields.';
    case 'past': return 'No runs after the start time: every date this expression allows is earlier.';
    case 'last-year': return n === 0 ? `No runs before the end of ${s.year}, the last year this scheduler supports.` : `Only ${runsWord(n)} before the end of ${s.year}, the last year this scheduler supports.`;
    case 'horizon': return `Only ${runsWord(n)} in the next ${s.years} years (the search limit).`;
    case 'limit': return `The search stopped after checking ${s.examined.toLocaleString('en-US')} candidate times, with ${runsWord(n)} found of ${count}.`;
    case 'ended': return n === 0 ? 'This one-time trigger has no runs after the start time.' : `This one-time trigger has only ${runsWord(n)} after the start time.`;
  }
}

export function impactText(i: DstImpact): string {
  const what = i.kind === 'nonexistent'
    ? `${i.count === 1 ? 'the scheduled time' : `${i.count} scheduled times`} ${wallText(i.firstWallMs)}${i.count > 1 ? ` to ${wallText(i.lastWallMs, false).slice(11)}` : ''} ${i.count === 1 ? 'does' : 'do'} not exist`
    : `${i.count === 1 ? 'the scheduled time' : `${i.count} scheduled times`} ${wallText(i.firstWallMs)}${i.count > 1 ? ` to ${wallText(i.lastWallMs, false).slice(11)}` : ''} ${i.count === 1 ? 'happens' : 'happen'} twice`;
  return `${transitionText(i.transition)} On that day ${what}.`;
}

export function dstPolicyJson(p: DstPolicy): Record<string, string> {
  return { basis: p.basis, nonexistent: p.nonexistent, repeatedFirst: p.repeatedFirst, repeatedSecond: p.repeatedSecond };
}

const RUN_HEADER = ['#', 'Local time', 'Local ISO 8601', 'Time zone', 'UTC offset', 'Abbreviation', 'UTC', 'Unix seconds', 'Status', 'Note'];

export function runsCsv(views: readonly RunView[], zone: string): string {
  return toCsv([RUN_HEADER, ...views.map(v => [v.index, v.local, v.localIso, zone, v.offset, v.abbreviation, v.utc, v.unixSeconds, v.statusLabel, v.note])]);
}

function runJson(v: RunView): Record<string, string | number | null> {
  return {
    index: v.index === '' ? null : Number(v.index), local: v.local, localIso: v.localIso || null, offset: v.offset || null,
    abbreviation: v.abbreviation || null, utc: v.utc || null, unixSeconds: v.unixSeconds === '' ? null : Number(v.unixSeconds),
    status: v.status, statusLabel: v.statusLabel, note: v.note || null,
  };
}

export interface ExplainReport {
  readonly dialect: ScheduleModelId;
  readonly expression: string;
  readonly zone: string;
  readonly fromMs: number;
  readonly explanation: Explanation;
  readonly views: readonly RunView[];
  readonly stop: string | null;
  readonly policy: DstPolicy;
  readonly impacts: readonly DstImpact[];
}

export function explainJson(r: ExplainReport): unknown {
  return {
    format: 'netforge-schedule-explanation', version: 1,
    dialect: r.dialect, dialectName: DIALECT_LABEL[r.dialect], expression: r.expression, normalized: r.explanation.normalized,
    timeZone: r.zone, runsAfter: formatIsoUtc(r.fromMs),
    summary: r.explanation.summary, fields: r.explanation.fields, warnings: r.explanation.warnings, notes: r.explanation.notes,
    dst: dstPolicyJson(r.policy), dstChangesAhead: r.impacts.map(impactText),
    runs: r.views.map(runJson), searchStopped: r.stop,
  };
}

export function explainText(r: ExplainReport): string {
  const lines = [
    `${DIALECT_LABEL[r.dialect]}: ${r.expression}`,
    ...(r.explanation.normalized ? [`Normalized: ${r.explanation.normalized}`] : []),
    `Meaning: ${r.explanation.summary}`,
    `Time zone: ${r.zone}`,
    '',
    `Next runs after ${formatIsoUtc(r.fromMs)}:`,
    ...r.views.map(v => `${v.index.padStart(3)}  ${v.local}${v.abbreviation ? ` ${v.abbreviation}` : ''}${v.offset ? ` (${v.offset})` : ''}${v.utc ? `  =  ${v.utc}` : ''}${v.status === 'scheduled' ? '' : `  [${v.statusLabel}]`}`),
  ];
  if (r.stop) lines.push(r.stop);
  if (r.explanation.warnings.length) lines.push('', 'Warnings:', ...r.explanation.warnings.map(w => `- ${w}`));
  if (r.impacts.length) lines.push('', 'DST changes in the next year:', ...r.impacts.map(i => `- ${impactText(i)}`));
  lines.push('', `DST handling: ${r.policy.basis}.`);
  return `${lines.join('\n')}\n`;
}

export function builderJson(r: BuilderResult, views: readonly RunView[], fromMs: number): unknown {
  return {
    format: 'netforge-schedule-builder', version: 1,
    schedule: r.description, timeZone: r.spec.zone, spec: r.spec, runsAfter: formatIsoUtc(fromMs),
    outputs: r.translations.map(t => ({
      target: t.target, label: t.label, fidelity: t.fidelity, text: t.text || null, template: t.template,
      differences: t.differences, conditions: t.conditions, notes: t.notes, dst: dstPolicyJson(t.dst),
    })),
    timerUnit: r.timerUnit?.text ?? null,
    runs: views.map(runJson),
  };
}

export function builderText(r: BuilderResult): string {
  const lines = [`Schedule: ${r.description}`, ''];
  for (const t of r.translations) {
    lines.push(`${t.label} [${t.fidelity}${t.template ? ', template' : ''}]`);
    if (t.text) lines.push(...t.text.replace(/\n$/, '').split('\n').map(l => `  ${l}`));
    for (const d of t.differences) lines.push(`  ${t.fidelity === 'unsupported' ? 'Why' : 'Differs'}: ${d}`);
    for (const c of t.conditions) lines.push(`  Condition: ${c}`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}
