/**
 * Regex Tester: JavaScript regular expressions against sample text, with matches highlighted,
 * capture groups listed and a replacement preview.
 *
 * The pattern never runs on the page's own thread. It runs in a Web Worker under a real time
 * limit: when the limit passes, the worker is terminated and replaced, so a pattern that would
 * run for hours cannot freeze the page.
 */
import { toJsonText } from '../../core/export/files';
import { REGEX_FLAGS, REGEX_LIMITS, type RegexRequest, type RegexResponse } from '../../core/regex/run';
import { formatInteger } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, copyButton, emptyState, notice, panel, textArea, textField, toolPage } from '../../ui/components';
import { h, replaceChildren, type Child } from '../../ui/dom';
import { createRunner, failureText } from '../util-shared/worker-client';
import { plural, section, statusLine } from '../util-shared/util-view';

const FLAG_LABELS: Readonly<Record<string, string>> = {
  g: 'g: all matches (global)',
  i: 'i: ignore case',
  m: 'm: ^ and $ match at line breaks',
  s: 's: dot matches line breaks',
  u: 'u: Unicode',
  v: 'v: Unicode sets',
  y: 'y: sticky (match only at the current position)',
};
const SHOWN_FLAGS = REGEX_FLAGS.filter(f => f !== 'd');

/** Highlighting more than this would make the page slow; the rest of the text is shown plain. */
const HIGHLIGHT_CHARS = 200_000;
const HIGHLIGHT_MARKS = 5_000;
const TABLE_ROWS = 500;

const SAMPLE_PATTERN = '(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})';
const SAMPLE_TEXT = 'Backups ran on 2026-11-14 and 2026-11-15.\nThe next audit is 2027-01-08; the last was 2025-12-01.';

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  const flags = new Set<string>(['g']);
  let response: RegexResponse | null = null;
  let lastText = '';
  let timer = 0;
  const runner = createRunner<RegexRequest, RegexResponse>(() => new Worker(new URL('./regex.worker.ts', import.meta.url), { type: 'module' }), REGEX_LIMITS.timeoutMs);

  const patternField = textField({ id: 'regex-pattern', label: 'Pattern', mono: true, placeholder: 'A JavaScript regular expression, without the surrounding slashes' });
  const pattern = patternField.control;
  const textInput = textArea({ id: 'regex-text', label: 'Test text', hideLabel: true, mono: true, rows: 9, placeholder: 'Text to search' });
  textInput.control.setAttribute('wrap', 'soft');
  const replacementField = textField({ id: 'regex-replacement', label: 'Replace matches with', mono: true, placeholder: 'For example: $<day>/$<month>/$<year>',
    hint: '$1 to $99 and $<name> insert groups, $& the match, $` and $\' the text before and after, $$ a dollar sign.' });
  const withReplacement = checkbox({ id: 'regex-replace-on', label: 'Preview a replacement', onChange: on => { replacementField.root.hidden = !on; schedule(0); } });
  replacementField.root.hidden = true;

  const flagBoxes = SHOWN_FLAGS.map(f => checkbox({
    id: `regex-flag-${f}`, label: FLAG_LABELS[f], checked: flags.has(f),
    onChange: on => { if (on) flags.add(f); else flags.delete(f); schedule(0); },
  }));
  const status = h('div', { class: 'json-status', id: 'regex-status', role: 'status' });
  const results = h('div', { class: 'result-area', id: 'regex-results' });

  const flagText = () => SHOWN_FLAGS.filter(f => flags.has(f)).join('');

  function highlighted(text: string, spans: readonly number[]): HTMLElement {
    const shown = text.length > HIGHLIGHT_CHARS ? text.slice(0, HIGHLIGHT_CHARS) : text;
    const children: Child[] = [];
    let cursor = 0;
    let marks = 0;
    for (let i = 0; i + 1 < spans.length && marks < HIGHLIGHT_MARKS; i += 2) {
      const start = spans[i];
      const end = spans[i + 1];
      if (start > shown.length || (start === shown.length && end > start)) break;
      if (start > cursor) children.push(shown.slice(cursor, start));
      if (end > start) children.push(h('mark', { class: marks % 2 === 0 ? 'match-a' : 'match-b' }, shown.slice(start, Math.min(end, shown.length))));
      else children.push(h('mark', { class: 'match-empty', title: `Zero-length match at position ${start}` }));
      cursor = Math.max(cursor, Math.min(end, shown.length));
      marks++;
    }
    if (cursor < shown.length) children.push(shown.slice(cursor));
    return h('pre', { class: 'code-block code-wrap match-view', tabindex: '0', role: 'region', 'aria-label': 'Test text with matches highlighted', id: 'regex-highlight' }, h('code', null, children));
  }

  function matchTable(r: Extract<RegexResponse, { ok: true }>): HTMLElement {
    const rows = r.matches.slice(0, TABLE_ROWS);
    return h('div', { class: 'table-scroll match-table-wrap', role: 'region', tabindex: '0', 'aria-label': 'Matches', id: 'regex-matches' },
      h('table', { class: 'data-table match-table' },
        h('caption', { class: 'visually-hidden' }, 'Matches'),
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'num' }, '#'), h('th', { scope: 'col', class: 'num' }, 'Start'), h('th', { scope: 'col', class: 'num' }, 'End'),
          h('th', { scope: 'col' }, 'Match'), r.groupCount > 0 ? h('th', { scope: 'col' }, 'Groups') : null,
        )),
        h('tbody', null, rows.map((m, i) => h('tr', null,
          h('td', { class: 'num' }, i + 1), h('td', { class: 'num mono' }, m.start), h('td', { class: 'num mono' }, m.end),
          h('td', { class: 'mono match-cell' }, m.value.length === 0 ? h('span', { class: 'muted' }, '(empty)') : m.value.text,
            m.value.length > m.value.text.length ? h('span', { class: 'value-note' }, `first ${formatInteger(m.value.text.length)} of ${formatInteger(m.value.length)} characters`) : null),
          r.groupCount > 0 ? h('td', null, h('ul', { class: 'group-list' }, m.groups.map(g => h('li', null,
            h('span', { class: 'group-name mono' }, g.name ? `${g.number} ${g.name}` : String(g.number)),
            g.value === null ? h('span', { class: 'muted' }, 'did not take part')
              : h('span', { class: 'mono' }, g.value.length === 0 ? h('span', { class: 'muted' }, '(empty)') : g.value.text,
                  g.value.length > g.value.text.length ? h('span', { class: 'value-note' }, `first ${formatInteger(g.value.text.length)} of ${formatInteger(g.value.length)} characters`) : null),
          )))) : null,
        ))),
      ),
    );
  }

  function render(elapsedMs: number | null): void {
    const r = response;
    patternField.setError(null);
    if (!r) {
      replaceChildren(status);
      replaceChildren(results, emptyState('Enter a pattern and some text.'));
      return;
    }
    if (!r.ok) {
      if (r.code === 'too-large') replaceChildren(status, notice('error', h('p', { id: 'regex-error' }, r.message)));
      else { replaceChildren(status); patternField.setError(r.message); }
      replaceChildren(results, emptyState('Fix the pattern to see matches.'));
      return;
    }
    const text = lastText;
    const detail = [
      r.zeroLength > 0 ? `${plural(r.zeroLength, 'zero-length match', 'zero-length matches')}` : '',
      r.groupCount > 0 ? `${plural(r.groupCount, 'capture group')}${r.groupNames.length > 0 ? ` (named: ${r.groupNames.join(', ')})` : ''}` : '',
      elapsedMs !== null ? `${elapsedMs} ms` : '',
    ].filter(Boolean).join(', ');
    replaceChildren(status,
      statusLine(r.total > 0 ? 'ok' : 'error', r.total === 0 ? 'No match' : plural(r.total, 'match', 'matches'), detail),
      !flags.has('g') && r.total === 1 ? h('p', { class: 'reach-note', id: 'regex-global-note' }, 'Without the g flag a pattern stops at its first match.') : null,
    );
    const limitNotes: string[] = [];
    if (r.detailLimit) limitNotes.push(r.detailLimit);
    if (r.matches.length > TABLE_ROWS) limitNotes.push(`The table shows the first ${TABLE_ROWS} matches. Copy as JSON includes all ${formatInteger(r.matches.length)} listed in detail.`);
    if (text.length > HIGHLIGHT_CHARS) limitNotes.push(`Highlighting covers the first ${formatInteger(HIGHLIGHT_CHARS)} characters of the text; matches after that are still counted and listed.`);
    else if (r.total > HIGHLIGHT_MARKS) limitNotes.push(`Highlighting covers the first ${formatInteger(HIGHLIGHT_MARKS)} matches; the rest are still counted.`);
    const allMatches = () => {
      const out: string[] = [];
      for (let i = 0; i + 1 < r.spans.length; i += 2) out.push(text.slice(r.spans[i], r.spans[i + 1]));
      return out.join('\n');
    };
    replaceChildren(results,
      limitNotes.length > 0 ? notice('info', h('ul', { class: 'warning-list', id: 'regex-limits' }, limitNotes.map(n => h('li', null, n)))) : null,
      section('Highlighted text', 'regex-highlight-section', highlighted(text, r.spans)),
      r.total > 0 ? section('Matches', 'regex-match-section', matchTable(r),
        h('div', { class: 'toolbar' },
          copyButton(services, allMatches, 'matches, one per line', { label: 'Copy matches' }),
          copyButton(services, () => toJsonText({ pattern: pattern.value, flags: flagText(), total: r.total, matches: r.matches }), 'matches as JSON', { label: 'Copy as JSON' }),
        )) : null,
      withReplacement.input.checked ? section('Replacement result', 'regex-replaced-section',
        r.replaced !== null
          ? [h('pre', { class: 'code-block code-wrap', tabindex: '0', role: 'region', 'aria-label': 'Text after replacement', id: 'regex-replaced' }, h('code', null, r.replaced)),
             h('div', { class: 'toolbar' }, copyButton(services, () => r.replaced, 'replacement result', { label: 'Copy result' }),
               button({ label: 'Download', icon: 'download', onClick: () => services.download('replaced.txt', r.replaced!, 'text/plain') }))]
          : notice('warning', h('p', { id: 'regex-replaced-note' }, r.replacedNote ?? 'No replacement result.')),
      ) : null,
    );
  }

  async function run(): Promise<void> {
    const request: RegexRequest = { pattern: pattern.value, flags: flagText(), text: textInput.control.value, replacement: withReplacement.input.checked ? replacementField.control.value : null };
    if (request.pattern === '') { response = null; render(null); return; }
    lastText = request.text;
    const outcome = await runner.run(request);
    if (outcome.status === 'superseded') return;
    if (outcome.status === 'done' && outcome.value.ok) {
      response = outcome.value.value;
      render(outcome.elapsedMs);
      return;
    }
    response = null;
    patternField.setError(null);
    const message = outcome.status === 'done'
      ? `The pattern could not be run: ${(outcome.value as { message: string }).message}`
      : outcome.status === 'timeout'
        ? `Stopped after ${outcome.limitMs / 1000} seconds. The pattern was still running, which usually means catastrophic backtracking: nested or overlapping repetition such as (a+)+ or (a|a)* that can try an enormous number of ways to match. The worker running it was terminated and replaced; the page was never blocked.`
        : failureText(outcome, 'the pattern');
    replaceChildren(status, notice('error', h('p', { id: 'regex-error', 'data-outcome': outcome.status }, message)));
    replaceChildren(results, emptyState('No result.'));
  }

  function schedule(delay: number): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void run(); }, delay);
  }

  pattern.addEventListener('input', () => schedule(150));
  textInput.control.addEventListener('input', () => schedule(textInput.control.value.length > 100_000 ? 400 : 150));
  replacementField.control.addEventListener('input', () => schedule(150));

  const sample = button({
    label: 'Example', variant: 'ghost', onClick: () => {
      pattern.value = SAMPLE_PATTERN;
      textInput.control.value = SAMPLE_TEXT;
      replacementField.control.value = '$<day>/$<month>/$<year>';
      schedule(0);
      pattern.focus();
    },
  });
  const clear = button({ label: 'Clear', variant: 'ghost', onClick: () => { pattern.value = ''; textInput.control.value = ''; replacementField.control.value = ''; schedule(0); pattern.focus(); } });

  host.appendChild(toolPage(meta, categoryName,
    notice('info', h('p', { id: 'regex-engine-note' }, h('strong', null, 'JavaScript regular expressions. '),
      'Patterns are run by this browser\'s own ECMAScript engine. This is not PCRE, .NET, Python, Java or RE2: a pattern copied from grep, C# or Go may be rejected here or match differently.')),
    panel('Pattern', [
      patternField.root,
      h('fieldset', { class: 'check-group', id: 'regex-flags' }, h('legend', { class: 'field-label' }, 'Flags'), h('div', { class: 'check-list' }, flagBoxes.map(b => b.root))),
      withReplacement.root, replacementField.root,
    ], [sample, clear]),
    panel('Test text', [textInput.root]),
    status,
    panel('Result', [results], undefined, 'result-panel'),
    h('p', { class: 'source-note', id: 'regex-limits-note' },
      `Limits: a run is stopped after ${REGEX_LIMITS.timeoutMs / 1000} seconds; the text may be up to ${formatInteger(REGEX_LIMITS.textChars)} characters and the pattern ${formatInteger(REGEX_LIMITS.patternChars)}; every match is counted, and the first ${formatInteger(REGEX_LIMITS.matches)} are listed in detail.`),
  ));
  render(null);
}
