/** Timestamp Converter: Unix seconds, milliseconds and ISO 8601, in UTC and an explicit time zone. */
import { formatInteger } from '../../core/format';
import {
  AUTO_MS_THRESHOLD, formatIsoInZone, formatIsoUtc, formatReadable, formatRelative, formatUnixSeconds,
  formatWallIso, parseTimestamp, resolveTimestamp, type ParsedTimestamp, type TimestampMode,
} from '../../core/time/timestamp';
import { browserTimeZone, formatOffset, offsetAt, wallFromUtc, type ZonedInstant } from '../../core/time/zones';
import type { ToolInstance, ToolMeta, ToolServices } from '../../app/registry';
import { readTimestampShare, timestampOffer } from './timestamp-share';
import { button, emptyState, notice, panel, resultTable, segmented, selectField, textField, toolPage, type ResultRow } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { DEVICE_ZONE, hasOption, zoneGroups } from '../../ui/zone-select';

const DEVICE = DEVICE_ZONE;

/** Clock time of a wall reading, for describing DST transitions: 02:00, or 02:00:30 when seconds matter. */
function clockTime(epochMsAsWall: number): string {
  const w = wallFromUtc(epochMsAsWall);
  const hm = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
  return w.second === 0 ? hm : `${hm}:${String(w.second).padStart(2, '0')}`;
}

function interpretation(parsed: ParsedTimestamp, zone: string): string {
  if (parsed.kind === 'wall') {
    return parsed.dateOnly
      ? `Read as midnight at the start of that day in ${zone}, because a date on its own has no time or offset.`
      : `Read as wall-clock time in ${zone}, because the input has no Z or offset.`;
  }
  if (parsed.source === 'iso') return `Read as ISO 8601 with offset ${formatOffset(parsed.writtenOffsetMs ?? 0)}.`;
  const unit = parsed.source === 'seconds' ? 'Unix seconds' : 'Unix milliseconds';
  if (!parsed.autoDetected) return `Read as ${unit}.`;
  const limit = formatInteger(AUTO_MS_THRESHOLD);
  return parsed.source === 'seconds'
    ? `Read as ${unit}: Auto treats numbers below ${limit} as seconds. Choose Milliseconds if this is a millisecond value.`
    : `Read as ${unit}: Auto treats numbers of ${limit} and above as milliseconds. Choose Seconds if this is a second value.`;
}

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance {
  const device = browserTimeZone();
  let mode: TimestampMode = 'auto';
  let zoneChoice = services.prefs.get('timeZone');
  let pick: 'earlier' | 'later' = 'earlier';

  const field = textField({ id: 'timestamp-input', label: 'Timestamp or date', placeholder: '1700000000 or 2026-11-14T08:30:00Z', mono: true,
    hint: 'Unix seconds, Unix milliseconds, or ISO 8601 / RFC 3339 such as 2026-11-14T08:30:00Z or 2026-11-14 08:30 (read in the time zone below).' });
  const input = field.control;
  const zoneField = selectField({ id: 'timestamp-zone', label: 'Time zone', groups: zoneGroups(device), value: zoneChoice });
  const result = h('div', { class: 'result-area', id: 'timestamp-result' });

  const modeControl = segmented({
    label: 'Read input as', name: 'timestamp-mode', value: mode,
    choices: [{ value: 'auto', label: 'Auto' }, { value: 'seconds', label: 'Seconds' }, { value: 'milliseconds', label: 'Milliseconds' }, { value: 'iso', label: 'ISO 8601' }],
    onChange: value => { mode = value as TimestampMode; update(); },
  });

  const nowButton = button({
    label: 'Now', icon: 'clock', onClick: () => {
      const now = Date.now();
      input.value = mode === 'milliseconds' ? String(now) : mode === 'iso' ? formatIsoUtc(now) : String(Math.floor(now / 1000));
      update();
      input.focus();
    },
  });

  const zone = () => (zoneChoice === DEVICE ? device : zoneChoice);

  function rows(epochMs: number): ResultRow[] {
    const z = zone();
    return [
      { key: 'seconds', label: 'Unix seconds', value: formatUnixSeconds(epochMs) },
      { key: 'milliseconds', label: 'Unix milliseconds', value: String(epochMs) },
      { key: 'iso-utc', label: 'ISO 8601 (UTC)', value: formatIsoUtc(epochMs) },
      { key: 'iso-zone', label: `ISO 8601 (${z})`, value: formatIsoInZone(epochMs, z) },
      { key: 'readable-utc', label: 'UTC', value: formatReadable(epochMs, 'UTC') },
      { key: 'readable-zone', label: z, value: formatReadable(epochMs, z) },
      { key: 'offset', label: `UTC offset in ${z}`, value: formatOffset(offsetAt(epochMs, z)) },
      { key: 'relative', label: 'Relative to now', value: formatRelative(epochMs, Date.now()), copy: null },
    ];
  }

  function table(epochMs: number): HTMLTableElement {
    return resultTable('Converted times', rows(epochMs), services);
  }

  function update(): void {
    const text = input.value;
    if (text.trim() === '') {
      field.setError(null);
      replaceChildren(result, emptyState('Enter a timestamp or date, or press Now.'));
      return;
    }
    const parsed = parseTimestamp(text, mode);
    if (!parsed.ok) {
      field.setError(parsed.error.message);
      replaceChildren(result, emptyState('Fix the input to see results.'));
      return;
    }
    field.setError(null);
    const z = zone();
    const resolved = resolveTimestamp(parsed.value, z);
    if (!resolved.ok) {
      field.setError(resolved.error.message);
      replaceChildren(result, emptyState('Fix the input to see results.'));
      return;
    }
    const r = resolved.value;
    const warnings = parsed.value.warnings.map(w => notice('warning', w));
    const intro = notice('info', interpretation(parsed.value, z));

    if (r.kind === 'instant' || r.kind === 'exact') {
      const epochMs = r.kind === 'instant' ? r.epochMs : r.instant.epochMs;
      replaceChildren(result, intro, warnings, table(epochMs));
    } else if (r.kind === 'gap') {
      const wall = parsed.value.kind === 'wall' ? formatWallIso(parsed.value.wall).replace('T', ' ') : text;
      replaceChildren(result, intro, warnings, notice('error',
        h('p', null, h('strong', null, `${wall} does not exist in ${z}. `),
          `Clocks jumped forward from ${clockTime(r.transitionMs + r.offsetBeforeMs)} to ${clockTime(r.transitionMs + r.offsetAfterMs)} (UTC offset ${formatOffset(r.offsetBeforeMs)} to ${formatOffset(r.offsetAfterMs)}) at ${formatIsoUtc(r.transitionMs)}.`),
        h('p', null, 'Enter a time before or after the jump, or add an explicit offset.'),
      ));
    } else {
      const chosen: ZonedInstant = pick === 'earlier' ? r.earlier : r.later;
      const wall = parsed.value.kind === 'wall' ? formatWallIso(parsed.value.wall).replace('T', ' ') : text;
      const choice = segmented({
        label: 'Which occurrence', name: 'timestamp-occurrence', value: pick,
        choices: [
          { value: 'earlier', label: `Earlier (${formatOffset(r.earlier.offsetMs)})` },
          { value: 'later', label: `Later (${formatOffset(r.later.offsetMs)})` },
        ],
        onChange: value => { pick = value as 'earlier' | 'later'; update(); },
      });
      replaceChildren(result, intro, warnings, notice('warning',
        h('p', null, h('strong', null, `${wall} happens twice in ${z}. `),
          `Clocks went back from ${clockTime(r.transitionMs + r.earlier.offsetMs)} to ${clockTime(r.transitionMs + r.later.offsetMs)} at ${formatIsoUtc(r.transitionMs)}, so this time occurs once at UTC offset ${formatOffset(r.earlier.offsetMs)} and again at ${formatOffset(r.later.offsetMs)}.`),
      ), choice.root, table(chosen.epochMs));
    }
  }

  input.addEventListener('input', () => { pick = 'earlier'; update(); });
  // A saved zone this browser does not list falls back to the device zone.
  if (zoneField.control.value !== zoneChoice) {
    zoneChoice = DEVICE;
    zoneField.control.value = DEVICE;
  }
  zoneField.control.addEventListener('change', () => {
    zoneChoice = zoneField.control.value;
    if (zoneChoice === DEVICE) services.prefs.reset('timeZone');
    else services.prefs.set('timeZone', zoneChoice);
    update();
  });

  host.appendChild(toolPage(meta, categoryName,
    panel('Input', [
      field.root,
      h('div', { class: 'controls-row' }, modeControl.root, zoneField.root),
    ], nowButton),
    panel('Result', [result], undefined, 'result-panel'),
  ));
  update();
  // "Relative to now" goes stale while the view is hidden; refresh it on return.
  return {
    activate: update,
    share: {
      offer: () => timestampOffer({ text: input.value, mode, zone: zoneChoice === DEVICE ? null : zoneChoice, pick }),
      // A zone from a link is used for this visit only; it is not saved as a preference.
      apply(params) {
        const s = readTimestampShare(params);
        if (!s || (s.zone !== null && !hasOption(zoneField.control, s.zone))) return false;
        input.value = s.text;
        mode = s.mode;
        modeControl.set(s.mode);
        zoneChoice = s.zone ?? DEVICE;
        zoneField.control.value = zoneChoice;
        pick = s.pick;
        update();
        return true;
      },
    },
  };
}
