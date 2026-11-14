/**
 * chmod Calculator: Unix permission bits as check boxes, an octal mode and an "ls -l" string, kept
 * in step with each other, with chmod commands to copy and a preview of symbolic changes.
 * These are Unix mode bits; Windows NTFS access control lists are a different model.
 */
import {
  applyNumeric, applySymbolic, bit, chmodCommands, CLASS_NAME, CLASSES, explainMode, formatLs, formatOctal, formatOctal4, formatSymbolic,
  modeWarnings, parseLsMode, parseOctalMode, parseUmask, S_ISGID, S_ISUID, S_ISVTX, type PermClass,
} from '../../core/perm/chmod';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, checkbox, notice, panel, resultTable, segmented, textField, toolPage, type ResultRow } from '../../ui/components';
import { h, replaceChildren } from '../../ui/dom';
import { statusLine } from '../util-shared/util-view';

const PERMS: readonly { key: 'r' | 'w' | 'x'; label: string }[] = [
  { key: 'r', label: 'Read' }, { key: 'w', label: 'Write' }, { key: 'x', label: 'Execute' },
];
const SPECIAL: readonly { id: string; label: string; mask: number }[] = [
  { id: 'perm-suid', label: 'setuid', mask: S_ISUID },
  { id: 'perm-sgid', label: 'setgid', mask: S_ISGID },
  { id: 'perm-sticky', label: 'Sticky', mask: S_ISVTX },
];

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let mode = 0o644;
  let directory = false;

  const boxes: { mask: number; input: HTMLInputElement }[] = [];
  const toggle = (mask: number) => (checked: boolean) => { mode = checked ? mode | mask : mode & ~mask; render('boxes'); };
  const classGroup = (cls: PermClass) => h('fieldset', { class: 'check-group perm-group' },
    h('legend', { class: 'field-label' }, CLASS_NAME[cls]),
    PERMS.map(p => {
      const mask = bit(cls, p.key);
      const box = checkbox({ id: `perm-${cls}-${p.key}`, label: p.label, checked: (mode & mask) !== 0, onChange: toggle(mask) });
      boxes.push({ mask, input: box.input });
      return box.root;
    }));
  const specialGroup = h('fieldset', { class: 'check-group perm-group' },
    h('legend', { class: 'field-label' }, 'Special'),
    SPECIAL.map(s => {
      const box = checkbox({ id: s.id, label: s.label, checked: false, onChange: toggle(s.mask) });
      boxes.push({ mask: s.mask, input: box.input });
      return box.root;
    }));
  const grid = h('div', { class: 'perm-grid', id: 'perm-grid' }, CLASSES.map(classGroup), specialGroup);

  const octal = textField({ id: 'chmod-octal', label: 'Octal mode', mono: true, value: '644', hint: '3 digits, or 4 with the special bits first.' });
  const ls = textField({ id: 'chmod-ls', label: 'Permission string', mono: true, value: 'rw-r--r--', hint: 'As ls -l shows it, with or without the file type in front.' });
  const typeControl = segmented({
    label: 'Applies to', name: 'chmod-type', value: 'file',
    choices: [{ value: 'file', label: 'File' }, { value: 'directory', label: 'Directory' }],
    onChange: value => { directory = value === 'directory'; render('type'); },
  });
  const path = textField({ id: 'chmod-path', label: 'Path for the commands (optional)', mono: true, placeholder: '/srv/www/index.html', hint: 'Left empty, the commands hold a <PATH> placeholder.' });

  const status = h('div', { class: 'json-status', id: 'chmod-status', role: 'status' });
  const result = h('div', { class: 'result-section', id: 'chmod-result' });
  const warnings = h('div', { class: 'result-section', id: 'chmod-warnings' });
  const meaning = h('div', { class: 'result-section', id: 'chmod-meaning' });

  const expr = textField({ id: 'chmod-expr', label: 'Symbolic change', mono: true, placeholder: 'u+x,go-w', hint: 'chmod clauses: who (u g o a), then + - or =, then r w x X s t or one of u g o.' });
  const umask = textField({ id: 'chmod-umask', label: 'umask', mono: true, value: '022', hint: 'Only matters for clauses with no who, such as +x.' });
  const numeric = textField({ id: 'chmod-numeric', label: 'Numeric change', mono: true, placeholder: '755', hint: 'What chmod with these digits leaves, starting from the mode above.' });
  const applyResult = h('div', { class: 'result-section', id: 'chmod-apply-result', role: 'status' });
  let pending: number | null = null;
  const useButton = button({ label: 'Use this mode', id: 'chmod-use', onClick: () => {
    if (pending === null) return;
    mode = pending;
    render('apply');
    services.announce(`Mode set to ${formatOctal4(mode)}`);
  } });

  function renderApply(): void {
    expr.setError(null);
    umask.setError(null);
    numeric.setError(null);
    pending = null;
    const lines: HTMLElement[] = [];
    const exprText = expr.control.value;
    const numericText = numeric.control.value;
    if (exprText.trim() !== '') {
      const mask = parseUmask(umask.control.value);
      if (!mask.ok) umask.setError(mask.error.message);
      else {
        const r = applySymbolic(mode, exprText, { directory, umask: mask.value });
        if (!r.ok) expr.setError(r.error.message);
        else {
          pending = r.value;
          lines.push(h('p', { class: 'status-line', id: 'chmod-expr-result' }, h('span', { class: 'mono' }, `chmod ${exprText.trim()}`), ' changes ',
            h('strong', { class: 'mono' }, `${formatOctal4(mode)} ${formatLs(mode)}`), ' to ', h('strong', { class: 'mono' }, `${formatOctal4(r.value)} ${formatLs(r.value)}`),
            ` on a ${directory ? 'directory' : 'file'}${r.value === mode ? ' (no change)' : ''}.`));
        }
      }
    }
    if (numericText.trim() !== '') {
      const r = applyNumeric(mode, numericText, directory);
      if (!r.ok) numeric.setError(r.error.message);
      else {
        if (pending === null) pending = r.value;
        const kept = directory && r.value !== parseInt(numericText.trim(), 8);
        lines.push(h('p', { class: 'status-line', id: 'chmod-numeric-result' }, h('span', { class: 'mono' }, `chmod ${numericText.trim()}`), ' leaves ',
          h('strong', { class: 'mono' }, `${formatOctal4(r.value)} ${formatLs(r.value)}`), ` on a ${directory ? 'directory' : 'file'}.`,
          kept ? ' GNU chmod kept setuid or setgid on the directory because the digits did not name them.' : ''));
      }
    }
    useButton.disabled = pending === null || pending === mode;
    replaceChildren(applyResult, lines);
  }

  function render(source: 'boxes' | 'octal' | 'ls' | 'type' | 'path' | 'apply' | 'init'): void {
    for (const b of boxes) b.input.checked = (mode & b.mask) !== 0;
    if (source !== 'octal') { octal.control.value = formatOctal(mode); octal.setError(null); }
    if (source !== 'ls') { ls.control.value = formatLs(mode); ls.setError(null); }
    path.setError(null);
    const commands = chmodCommands(mode, path.control.value, directory);
    const typeChar = directory ? 'd' : '-';
    const rows: ResultRow[] = [
      { key: 'octal', label: 'Octal', value: formatOctal4(mode), note: mode > 0o777 ? 'special bits, owner, group, others' : 'leading 0: no special bits' },
      { key: 'ls', label: 'ls -l shows', value: typeChar + formatLs(mode), note: directory ? 'd marks a directory' : '- marks a regular file' },
      { key: 'symbolic', label: 'Symbolic', value: formatSymbolic(mode, directory) },
    ];
    if (commands.ok) {
      rows.push(
        { key: 'command-octal', label: 'Command, octal', value: commands.value.octal },
        { key: 'command-symbolic', label: 'Command, symbolic', value: commands.value.symbolic },
      );
    } else {
      path.setError(commands.error.message);
    }
    replaceChildren(status, statusLine('ok', `${formatOctal4(mode)} ${typeChar}${formatLs(mode)}`, directory ? 'directory' : 'regular file'));
    replaceChildren(result,
      resultTable('The mode in each notation', rows, services),
      commands.ok && commands.value.template ? h('p', { class: 'source-note' }, 'Replace <PATH> with the file or directory. NetForge never runs a command.') : null,
      directory ? h('p', { class: 'source-note', id: 'chmod-dir-note' }, 'On a directory, GNU chmod keeps setuid and setgid that are already set unless the mode names them: the octal command above does not clear them, and neither does u=rwx alone. The symbolic command adds a -s clause where one is needed, so it sets exactly this mode. With GNU chmod, five octal digits (chmod 00755) also clear them.') : null,
    );
    const found = modeWarnings(mode, directory);
    replaceChildren(warnings, found.map(w => notice('warning', w.message)));
    replaceChildren(meaning, h('table', { class: 'result-table perm-meaning' },
      h('caption', { class: 'visually-hidden' }, `What each bit means for a ${directory ? 'directory' : 'regular file'}`),
      h('tbody', null, explainMode(mode, directory).map(e => h('tr', null,
        h('th', { scope: 'row' }, e.label),
        h('td', { class: 'result-value' }, h('span', { class: `badge ${e.set ? 'badge-ok' : 'badge-info'}` }, e.set ? 'set' : 'not set'), ' ', e.meaning),
      )))));
    renderApply();
  }

  octal.control.addEventListener('input', () => {
    const r = parseOctalMode(octal.control.value);
    if (!r.ok) { octal.setError(r.error.message); return; }
    octal.setError(null);
    mode = r.value;
    render('octal');
  });
  ls.control.addEventListener('input', () => {
    const r = parseLsMode(ls.control.value);
    if (!r.ok) { ls.setError(r.error.message); return; }
    ls.setError(null);
    mode = r.value.mode;
    if (r.value.type === 'd' && !directory) { directory = true; typeControl.set('directory'); }
    else if (r.value.type === '-' && directory) { directory = false; typeControl.set('file'); }
    render('ls');
  });
  path.control.addEventListener('input', () => render('path'));
  for (const field of [expr, umask, numeric]) field.control.addEventListener('input', renderApply);

  const presets: readonly [string, number][] = [['644', 0o644], ['755', 0o755], ['600', 0o600], ['700', 0o700], ['664', 0o664], ['775', 0o775], ['2775', 0o2775], ['1777', 0o1777]];
  const presetBar = h('div', { class: 'toolbar', role: 'group', 'aria-label': 'Common modes' },
    presets.map(([label, value]) => button({ label, variant: 'ghost', onClick: () => { mode = value; render('init'); } })));

  host.appendChild(toolPage(meta, categoryName,
    panel('Permissions', [
      grid,
      h('div', { class: 'controls-row' }, octal.root, ls.root, typeControl.root),
      presetBar,
    ]),
    status,
    panel('Mode and commands', [path.root, result, warnings], undefined, 'result-panel'),
    panel('What the bits mean', [meaning]),
    panel('Preview a change', [
      h('div', { class: 'controls-row' }, expr.root, umask.root, numeric.root),
      applyResult,
      h('div', { class: 'toolbar' }, useButton),
      h('p', { class: 'source-note' }, 'Symbolic and numeric changes follow GNU coreutils chmod, which implements POSIX. A capital X adds execute only to directories and to files that already have an execute bit.'),
    ]),
    panel('Not Windows permissions', [
      h('p', { class: 'source-note', id: 'chmod-ntfs-note' }, 'These twelve bits are the Unix permission model: one owner, one group and everyone else. Windows NTFS uses access control lists: any number of entries, each allowing or denying specific rights to a user or group, with inheritance from parent folders. Neither model can express the other without loss, so there is no chmod value that equals an NTFS ACL, and NetForge does not convert between them. Tools that show a mode for Windows files (Git Bash, WSL on a Windows drive, Samba) are approximating.'),
    ]),
  ));
  render('init');
}
