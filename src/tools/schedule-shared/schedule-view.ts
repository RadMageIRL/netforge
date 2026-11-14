/** Display pieces shared by the Cron Explainer and the Schedule Builder. */
import type { DstImpact } from '../../core/schedule/dst';
import type { DstPolicy } from '../../core/schedule/model';
import { impactText, type RunView } from '../../core/schedule/reports';
import { parseTimestamp, resolveTimestamp } from '../../core/time/timestamp';
import { h, type Child } from '../../ui/dom';
import { notice } from '../../ui/components';

const STATUS_BADGE: Readonly<Record<RunView['status'], string>> = {
  scheduled: 'badge badge-ok',
  uncertain: 'badge badge-warning',
  nonexistent: 'badge badge-warning',
  skipped: 'badge badge-info',
};

/**
 * The next-runs table: local time with the zone's abbreviation and offset (so the two passes of a
 * repeated hour are told apart), UTC, and a status for times a DST change skips or repeats.
 */
export function runTable(views: readonly RunView[], caption: string, zone: string, id: string): HTMLElement {
  return h('div', { class: 'table-scroll run-table-wrap', role: 'region', 'aria-label': caption, tabindex: '0', id },
    h('table', { class: 'data-table run-table' },
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: 'num' }, '#'),
        h('th', { scope: 'col' }, `Local time (${zone})`),
        h('th', { scope: 'col' }, 'Zone'),
        h('th', { scope: 'col' }, 'UTC'),
        h('th', { scope: 'col' }, 'Status'),
      )),
      h('tbody', null, views.map(v => h('tr', { class: v.status === 'scheduled' ? undefined : `run-${v.status}`, 'data-status': v.status },
        h('td', { class: 'num' }, v.index),
        h('td', { class: 'mono' }, v.local),
        h('td', { class: 'mono' }, [v.abbreviation === 'UTC' ? '' : v.abbreviation, v.offset ? `UTC${v.offset}` : ''].filter(Boolean).join(' ')),
        h('td', { class: 'mono' }, v.utc || 'none'),
        h('td', { class: 'status-col' },
          h('span', { class: STATUS_BADGE[v.status] }, v.statusLabel),
          v.note ? h('span', { class: 'run-note' }, v.note) : null,
        ),
      ))),
    ),
  );
}

export function dstSection(policy: DstPolicy, impacts: readonly DstImpact[], zone: string, id: string): HTMLElement {
  return h('div', { class: 'dst-section', id },
    h('h3', { class: 'sub-title' }, 'DST changes'),
    impacts.length === 0
      ? h('p', { class: 'reach-note' }, `No DST change in ${zone} in the next 12 months skips or repeats a scheduled time.`)
      : h('ul', { class: 'warning-list' }, impacts.map(i => h('li', null, impactText(i)))),
    h('p', { class: 'source-note' }, `How this scheduler handles them: ${policy.basis}. ${policy.nonexistentNote} ${policy.repeatedNote}`),
  );
}

/** Generated text in a scroll region of its own, so long lines never widen the page. */
export function codeBlock(text: string, label: string, id?: string): HTMLElement {
  return h('pre', { class: 'code-block', tabindex: '0', role: 'region', 'aria-label': label, id }, h('code', null, text.replace(/\n$/, '')));
}

export function bulletList(items: readonly string[], className = 'warning-list'): HTMLElement | null {
  return items.length === 0 ? null : h('ul', { class: className }, items.map(i => h('li', null, i)));
}

export function warnings(items: readonly string[], id: string): HTMLElement | null {
  if (items.length === 0) return null;
  return h('div', { id }, notice('warning', h('p', null, h('strong', null, items.length === 1 ? 'Check this:' : 'Check these:')), bulletList(items)));
}

/**
 * Reads the "runs after" field: empty means now; otherwise an ISO 8601 date and time, read in
 * `zone` when it has no offset. A time a DST change skips is refused; a repeated one uses its
 * first occurrence.
 */
export function readStart(text: string, zone: string, nowMs: number): { ok: true; ms: number; note: string | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, ms: nowMs, note: null };
  const p = parseTimestamp(text, 'iso');
  if (!p.ok) return { ok: false, message: p.error.message };
  const r = resolveTimestamp(p.value, zone);
  if (!r.ok) return { ok: false, message: r.error.message };
  const v = r.value;
  if (v.kind === 'instant') return { ok: true, ms: v.epochMs, note: null };
  if (v.kind === 'exact') return { ok: true, ms: v.instant.epochMs, note: null };
  if (v.kind === 'ambiguous') return { ok: true, ms: v.earlier.epochMs, note: `That local time happens twice in ${zone}; the first occurrence is used.` };
  return { ok: false, message: `That local time does not exist in ${zone} (clocks jump over it). Enter a time before or after the change.` };
}

export function caretLine(source: string, offset: number, length: number): HTMLElement {
  const start = Math.max(0, Math.min(offset, source.length));
  const end = Math.max(start + 1, Math.min(source.length, start + Math.max(1, length)));
  return h('pre', { class: 'caret-block', 'aria-hidden': 'true' },
    h('span', null, source),
    '\n',
    h('span', { class: 'caret' }, `${' '.repeat(start)}${'^'.repeat(end - start)}`),
  );
}

export function section(title: string, ...body: Child[]): HTMLElement {
  return h('div', { class: 'result-section' }, h('h3', { class: 'sub-title' }, title), ...body);
}
