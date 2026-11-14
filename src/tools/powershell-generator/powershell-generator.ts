/**
 * PowerShell Generator: previews of PowerShell for a network plan (Windows DHCP Server scopes with
 * exclusions, options and reservations; a read-only plan report) and a scheduled task example
 * built by the scheduling engine. Nothing is run, and nothing typed here is stored.
 */
import type { ToolMeta, ToolServices } from '../../app/registry';
import type { ExportOutput } from '../../core/infra/model';
import { dhcpScript, reportScript } from '../../core/infra/powershell';
import { taskScript, TASK_FREQUENCIES } from '../../core/infra/task';
import { FREQUENCY_LABEL, todayIn, type Frequency } from '../../core/schedule/builder';
import { checkbox, panel, segmented, selectField, textArea, textField, toolPage } from '../../ui/components';
import { h } from '../../ui/dom';
import { DEVICE_ZONE, zoneGroups } from '../../ui/zone-select';
import { debounced, outputView, planSource, PREVIEW_NOTE, scopeFields } from '../export-shared/export-view';

type Target = 'dhcp' | 'report' | 'task';

const TARGETS: readonly { value: Target; label: string }[] = [
  { value: 'dhcp', label: 'DHCP scopes' },
  { value: 'report', label: 'Plan report' },
  { value: 'task', label: 'Scheduled task' },
];
const TITLE: Readonly<Record<Target, string>> = { dhcp: 'Windows DHCP scopes', report: 'Plan report script', task: 'Scheduled task' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): void {
  let target: Target = 'dhcp';
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const view = outputView(services, 'ps');

  function generate(): void {
    const plan = source.plan();
    let out: ExportOutput | null = null;
    if (target === 'task') {
      out = taskScript({
        frequency: frequency.control.value as Frequency, time: time.control.value, weekday: weekday.control.value, every: every.control.value,
        startDate: startDate.control.value, zone: zone.control.value === DEVICE_ZONE ? deviceZone : zone.control.value,
        details: { name: taskName.control.value.trim(), program: program.control.value.trim(), arguments: args.control.value.trim() },
      });
    } else if (plan) {
      out = target === 'dhcp'
        ? dhcpScript(plan, { scope: scope.value(), computerName: computer.control.value, dnsServers: dns.control.value, dnsDomain: domain.control.value, activate: activate.input.checked, reservations: reservations.control.value })
        : reportScript(plan, scope.value());
    }
    view.show(out, TITLE[target], 'Choose a plan above to see the PowerShell preview.');
  }
  const later = debounced(generate);

  const source = planSource(services, 'ps', () => { scope.setPlan(source.plan()); generate(); });
  const scope = scopeFields('ps', generate);
  const targetChoice = segmented({ label: 'Generate', name: 'ps-target', choices: TARGETS, value: target, onChange: v => { target = v as Target; layout(); generate(); } });

  const computer = textField({ id: 'ps-computer', label: 'DHCP server name (optional)', hint: 'Written as -ComputerName. Leave empty for the server the script runs on.', mono: true });
  const dns = textField({ id: 'ps-dns', label: 'DNS servers (optional)', hint: 'IPv4 addresses, separated by commas. A plan holds no DNS servers, so none are written unless you enter them.', mono: true });
  const domain = textField({ id: 'ps-domain', label: 'DNS domain (optional)', hint: 'Option 15. Not written unless you enter it.', mono: true });
  const activate = checkbox({ id: 'ps-activate', label: 'Create scopes active (they start leasing at once). Off: scopes are created inactive.', onChange: generate });
  const reservations = textArea({ id: 'ps-reservations', label: 'Reservations (optional)', hint: 'One per line: IPv4 address, MAC address, optional name. A plan holds no MAC addresses, so reservations exist only for the lines here.', mono: true, rows: 4, placeholder: '10.10.10.5 00-11-22-33-44-55 printer-1' });
  for (const f of [computer, dns, domain, reservations]) f.control.addEventListener('input', later);

  const frequency = selectField({ id: 'ps-frequency', label: 'Schedule', groups: [{ label: null, options: TASK_FREQUENCIES.map(f => ({ value: f, label: FREQUENCY_LABEL[f] })) }], value: 'daily' });
  const time = textField({ id: 'ps-time', label: 'Time (HH:MM)', value: '02:00', mono: true });
  const weekday = selectField({ id: 'ps-weekday', label: 'Day of the week', groups: [{ label: null, options: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })) }], value: '1' });
  const every = textField({ id: 'ps-every', label: 'Every', value: '15', mono: true, hint: 'Minutes (1 to 59) or hours (1 to 23).' });
  const startDate = textField({ id: 'ps-start', label: 'Start date (YYYY-MM-DD)', value: todayIn(deviceZone, Date.now()), mono: true });
  const zone = selectField({ id: 'ps-zone', label: 'Time zone of the schedule', groups: zoneGroups(deviceZone), value: DEVICE_ZONE });
  const taskName = textField({ id: 'ps-task-name', label: 'Task name', hint: 'Left as a marked placeholder when empty.' });
  const program = textField({ id: 'ps-program', label: 'Program to run', hint: 'Left as a marked placeholder when empty. NetForge does not invent a path.', mono: true });
  const args = textField({ id: 'ps-arguments', label: 'Arguments (optional)', mono: true });
  for (const f of [time, every, startDate, taskName, program, args]) f.control.addEventListener('input', later);
  for (const f of [frequency, weekday, zone]) f.control.addEventListener('change', () => { layout(); generate(); });

  const scopeRow = h('div', { class: 'controls-row', id: 'ps-scope' }, scope.site.root, scope.vrf.root, scope.namespace.root);
  const dhcpOptions = h('div', { class: 'export-options', id: 'ps-dhcp-options' },
    h('div', { class: 'controls-row' }, computer.root, dns.root, domain.root), activate.root, reservations.root);
  const taskOptions = h('div', { class: 'export-options', id: 'ps-task-options' },
    h('div', { class: 'controls-row' }, frequency.root, time.root, weekday.root, every.root, startDate.root, zone.root),
    h('div', { class: 'controls-row' }, taskName.root, program.root, args.root),
    h('p', { class: 'hint' }, 'The schedule is validated and written by the same engine as the Schedule Builder, which also shows the next runs, monthly schedules and schtasks.exe.'));

  function layout(): void {
    source.panel.hidden = target === 'task';
    scopeRow.hidden = target === 'task';
    dhcpOptions.hidden = target !== 'dhcp';
    taskOptions.hidden = target !== 'task';
    const f = frequency.control.value;
    time.root.hidden = f === 'minutes' || f === 'hourly';
    weekday.root.hidden = f !== 'weekly';
    every.root.hidden = f !== 'minutes' && f !== 'hourly';
  }

  host.appendChild(toolPage(meta, categoryName,
    source.panel,
    panel('Export', [targetChoice.root, scopeRow, dhcpOptions, taskOptions]),
    view.status,
    view.preview,
    view.account,
    h('p', { class: 'source-note' }, `${PREVIEW_NOTE} Commands that change a DHCP server need administrator rights and say so at the top of the script.`),
  ));
  scope.setPlan(null);
  layout();
  generate();
}
