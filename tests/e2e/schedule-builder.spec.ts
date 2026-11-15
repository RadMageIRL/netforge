import { expect, test, type Page } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

// The browser runs in America/New_York with the clock fixed at Saturday 2026-11-14 12:00 EST
// (17:00 UTC), so "next runs" and the default start date are known. Expected outputs were worked
// out by hand from each format's rules.
const NOW = new Date('2026-11-14T17:00:00Z');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await openTool(page, 'schedule-builder', 'Schedule Builder');
});

type Target = 'cron' | 'quartz' | 'systemd' | 'powershell' | 'schtasks';
const card = (page: Page, t: Target) => page.locator(`[data-target="${t}"]`);
const fidelity = (page: Page, t: Target) => card(page, t).locator('.fidelity');
const text = (page: Page, t: Target) => page.locator(`#builder-text-${t}`);
/** Exact multi-line text of a code block (toHaveText would collapse whitespace). */
const code = (page: Page, t: Target) => expect.poll(() => text(page, t).textContent());

async function labels(page: Page): Promise<string[]> {
  return Promise.all((['cron', 'quartz', 'systemd', 'powershell', 'schtasks'] as const).map(t => fidelity(page, t).innerText()));
}

test.describe('choices', () => {
  test('starts with a daily schedule at 09:00, today, in the device zone', async ({ page }) => {
    const errors = watchErrors(page);
    await expect(page.locator('#builder-frequency')).toHaveValue('daily');
    await expect(page.locator('#builder-time')).toHaveValue('09:00');
    await expect(page.locator('#builder-start')).toHaveValue('2026-11-14');
    await expect(page.locator('#builder-zone option:checked')).toHaveText('This device (America/New_York)');
    await expect(page.locator('#builder-description')).toHaveText('Every day at 09:00, America/New_York time.');
    expect(errors).toEqual([]);
  });

  test('each frequency shows only its own fields', async ({ page }) => {
    const visible = async (ids: string[], hidden: string[]) => {
      for (const id of ids) await expect(page.locator(`#${id}`)).toBeVisible();
      for (const id of hidden) await expect(page.locator(`#${id}`)).toBeHidden();
    };
    await page.selectOption('#builder-frequency', 'minutes');
    await visible(['builder-every-minutes'], ['builder-time', 'builder-every-hours', 'builder-weekday', 'builder-days', 'builder-month-day']);
    await page.selectOption('#builder-frequency', 'hourly');
    await visible(['builder-every-hours', 'builder-minute'], ['builder-time', 'builder-every-minutes']);
    await page.selectOption('#builder-frequency', 'daily');
    await visible(['builder-time'], ['builder-weekday', 'builder-every-weeks', 'builder-days', 'builder-minute']);
    await page.selectOption('#builder-frequency', 'weekdays');
    await visible(['builder-time'], ['builder-weekday', 'builder-days']);
    await page.selectOption('#builder-frequency', 'weekly');
    await visible(['builder-time', 'builder-weekday', 'builder-every-weeks'], ['builder-days']);
    await page.selectOption('#builder-frequency', 'days');
    await visible(['builder-time', 'builder-days', 'builder-day-1'], ['builder-weekday']);
    await page.selectOption('#builder-frequency', 'monthly');
    await visible(['builder-time', 'builder-month-day'], ['builder-nth', 'builder-nth-weekday', 'builder-days']);
    await page.getByRole('radio', { name: 'Weekday of the month', exact: true }).check();
    await visible(['builder-nth', 'builder-nth-weekday'], ['builder-month-day']);
    await page.getByRole('radio', { name: 'Last day', exact: true }).check();
    await visible([], ['builder-nth', 'builder-nth-weekday', 'builder-month-day']);
  });

  test('invalid choices are explained at the field and produce no outputs', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'minutes');
    await page.fill('#builder-every-minutes', '0');
    await expect(page.locator('#builder-every-minutes-error')).toHaveText('Enter a whole number of minutes from 1 to 59.');
    await expect(page.locator('#builder-every-minutes')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#builder-summary')).toHaveText('Fix the highlighted choices to see the schedule.');
    await expect(page.locator('#builder-outputs > *')).toHaveCount(0);
    for (const name of ['Copy all', 'CSV', 'JSON']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await page.fill('#builder-every-minutes', '20');
    await expect(page.locator('#builder-every-minutes')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#builder-outputs > *')).toHaveCount(5);

    await page.selectOption('#builder-frequency', 'daily');
    await page.fill('#builder-time', '');
    await expect(page.locator('#builder-time-error')).toHaveText('Enter a time of day as HH:MM, 00:00 to 23:59.');
    await page.fill('#builder-time', '18:45');
    await expect(page.locator('#builder-description')).toHaveText('Every day at 18:45, America/New_York time.');

    await page.selectOption('#builder-frequency', 'days');
    for (const d of [1, 3, 5]) await page.locator(`#builder-day-${d}`).uncheck();
    await expect(page.locator('#builder-days-error')).toHaveText('Choose at least one day of the week.');
    await expect(page.locator('#builder-outputs > *')).toHaveCount(0);
    await page.locator('#builder-day-2').check();
    await expect(page.locator('#builder-days-error')).toBeHidden();
    await expect(text(page, 'cron')).toHaveText('45 18 * * 2');
  });
});

test.describe('translations', () => {
  test('daily: every format is exact', async ({ page }) => {
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Exact', 'Exact']);
    await expect(text(page, 'cron')).toHaveText('0 9 * * *');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 * * ?');
    await expect(text(page, 'systemd')).toHaveText('*-*-* 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 09:00');
    await code(page, 'powershell').toBe([
      "# At 09:00 every day, starting 2026-11-14. Times are the computer's local time.",
      "$trigger = New-ScheduledTaskTrigger -Daily -At '2026-11-14T09:00:00'",
      '# New-ScheduledTaskTrigger stores -At as UTC, which pins the trigger to UTC and moves it by an hour across DST changes.',
      '# Writing the start boundary without an offset keeps it at the same local time all year.',
      "$trigger.StartBoundary = '2026-11-14T09:00:00'",
      '',
      '# Template: replace the values in angle brackets, review, then run these lines yourself.',
      '# Registering a task for yourself needs no elevation; NetForge adds no credentials or run level.',
      "$action = New-ScheduledTaskAction -Execute '<PROGRAM>'",
      "Register-ScheduledTask -TaskName '<TASK NAME>' -Trigger $trigger -Action $action",
    ].join('\n'));
    await expect(card(page, 'powershell').locator('.badge', { hasText: 'Template' })).toBeVisible();
    await expect(card(page, 'schtasks').locator('.badge', { hasText: 'Template' })).toBeVisible();
    await expect(card(page, 'cron').locator('.badge', { hasText: 'Template' })).toHaveCount(0);
    await expect(card(page, 'cron')).toContainText('CRON_TZ=America/New_York');
    await expect(card(page, 'quartz')).toContainText('inTimeZone(TimeZone.getTimeZone("America/New_York"))');
    await expect(card(page, 'schtasks')).toContainText('adds no /RU, /RP or /RL HIGHEST');
  });

  test('every 15 minutes: exact everywhere, with the repetition copied into the daily trigger', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'minutes');
    await page.fill('#builder-every-minutes', '15');
    await expect(text(page, 'cron')).toHaveText('*/15 * * * *');
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Exact', 'Exact']);
    await expect(text(page, 'quartz')).toHaveText('0 0/15 * * * ?');
    await expect(text(page, 'systemd')).toHaveText('*-*-* *:00/15:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 00:00 /RI 15 /DU 0024:00');
    const ps = (await text(page, 'powershell').textContent())!.split('\n');
    expect(ps).toContain("$trigger = New-ScheduledTaskTrigger -Daily -At '2026-11-14T00:00:00'");
    expect(ps).toContain("$trigger.StartBoundary = '2026-11-14T00:00:00'");
    expect(ps).toContain("$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '2026-11-14T00:00:00' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition");
    expect(ps).toContain('$trigger.Repetition.StopAtDurationEnd = $false');
    await expect(page.locator('#builder-runs tbody tr').first().locator('td')).toHaveText(['1', 'Sat 2026-11-14 12:15:00', 'EST UTC-05:00', '2026-11-14T17:15:00Z', 'Scheduled']);
  });

  test('every 7 minutes: Windows is approximate and says how it differs', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'minutes');
    await page.fill('#builder-every-minutes', '7');
    await expect(text(page, 'cron')).toHaveText('*/7 * * * *');
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Approximate', 'Approximate']);
    await expect(page.locator('#builder-warnings')).toContainText('Every 7 minutes restarts at minute 0 each hour: after minute 56 the next run is 4 minutes later.');
    for (const t of ['powershell', 'schtasks'] as const) {
      await expect(card(page, t)).toContainText('How it differs from the schedule');
      await expect(card(page, t)).toContainText('Task Scheduler repeats every 7 minutes through the whole day from 00:00 (... 00:56, 01:03, ...)');
    }
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 00:00 /RI 7 /DU 0024:00');
    const windows = card(page, 'schtasks').locator('details', { hasText: 'Next runs by these rules' });
    await expect(windows.locator('summary')).toHaveText('Next runs by these rules (they differ)');
    await windows.locator('summary').click();
    await expect(windows.locator('.compare-differs')).toHaveText('Differs from the schedule at run 1: 2026-11-14T17:01:00Z instead of 2026-11-14T17:07:00Z.');
    await expect(page.locator('#builder-runs-schtasks tbody tr').first().locator('td').nth(1)).toHaveText('Sat 2026-11-14 12:01:00');
    const cron = card(page, 'cron').locator('details', { hasText: 'Next runs by these rules' });
    await expect(cron.locator('summary')).toHaveText('Next runs by these rules');
    await cron.locator('summary').click();
    await expect(cron.locator('.compare-same')).toHaveText("The same as the schedule's next 10 runs.");
    await expect(page.locator('#builder-runs-cron tbody tr')).toHaveCount(10);
  });

  test('hourly at minute 30: exact everywhere', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'hourly');
    await page.fill('#builder-minute', '30');
    await expect(text(page, 'cron')).toHaveText('30 * * * *');
    await expect(text(page, 'quartz')).toHaveText('0 30 * * * ?');
    await expect(text(page, 'systemd')).toHaveText('*-*-* *:30:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 00:30 /RI 60 /DU 0024:00');
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Exact', 'Exact']);
    await page.fill('#builder-every-hours', '5');
    await expect(text(page, 'cron')).toHaveText('30 */5 * * *');
    await expect(page.locator('#builder-warnings')).toContainText('Every 5 hours restarts at midnight');
  });

  test('weekdays and specific weekdays', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'weekdays');
    await expect(text(page, 'cron')).toHaveText('0 9 * * 1-5');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 ? * MON-FRI');
    await expect(text(page, 'systemd')).toHaveText('Mon..Fri *-*-* 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:00');
    await expect(text(page, 'powershell')).toContainText("$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '2026-11-14T09:00:00'");
    await page.selectOption('#builder-frequency', 'days');
    await expect(text(page, 'cron')).toHaveText('0 9 * * 1,3,5');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 ? * MON,WED,FRI');
    await expect(text(page, 'systemd')).toHaveText('Mon,Wed,Fri *-*-* 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /D MON,WED,FRI /ST 09:00');
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Exact', 'Exact']);
  });

  test('every 2 weeks: only Windows can count weeks', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'weekly');
    await page.fill('#builder-every-weeks', '2');
    await expect(page.locator('#builder-description')).toHaveText('Every 2 weeks on Monday at 09:00, counting from the week of 2026-11-14, America/New_York time.');
    expect(await labels(page)).toEqual(['Unsupported', 'Unsupported', 'Unsupported', 'Exact', 'Exact']);
    await expect(card(page, 'cron')).toContainText('Standard cron has no week counter, so it cannot run every 2 weeks');
    await expect(card(page, 'quartz')).toContainText('CalendarIntervalTrigger');
    await expect(card(page, 'systemd')).toContainText('OnUnitActiveSec=2w');
    await expect(card(page, 'systemd')).toContainText('monotonic timer');
    for (const t of ['cron', 'quartz', 'systemd'] as const) {
      await expect(text(page, t)).toHaveCount(0);
      await expect(card(page, t).getByRole('button', { name: 'Copy' })).toHaveCount(0);
    }
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /MO 2 /D MON /SD 11/14/2026 /ST 09:00');
    await expect(text(page, 'powershell')).toContainText("New-ScheduledTaskTrigger -Weekly -WeeksInterval 2 -DaysOfWeek Monday -At '2026-11-14T09:00:00'");
    // Weeks start on the Sunday before 2026-11-14 (November 8): Monday November 9 is before the start, so November 23.
    await expect(page.locator('#builder-runs tbody tr').locator('td:nth-child(2)')).toHaveText([
      'Mon 2026-11-23 09:00:00', 'Mon 2026-12-07 09:00:00', 'Mon 2026-12-21 09:00:00', 'Mon 2027-01-04 09:00:00', 'Mon 2027-01-18 09:00:00',
      'Mon 2027-02-01 09:00:00', 'Mon 2027-02-15 09:00:00', 'Mon 2027-03-01 09:00:00', 'Mon 2027-03-15 09:00:00', 'Mon 2027-03-29 09:00:00',
    ]);
  });

  test('every 2 weeks on Sunday: Windows becomes approximate, because its week start is undocumented', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'weekly');
    await page.fill('#builder-every-weeks', '2');
    await page.selectOption('#builder-weekday', '0');
    await expect(page.locator('#builder-description')).toContainText('Every 2 weeks on Sunday');
    expect(await labels(page)).toEqual(['Unsupported', 'Unsupported', 'Unsupported', 'Approximate', 'Approximate']);
    await expect(card(page, 'schtasks')).toContainText('Task Scheduler does not document whether its weeks start on Sunday or Monday');
  });

  test('last day of the month: no standard cron, no PowerShell trigger', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'monthly');
    await page.getByRole('radio', { name: 'Last day', exact: true }).check();
    await expect(page.locator('#builder-description')).toHaveText('On the last day of every month at 09:00, America/New_York time.');
    expect(await labels(page)).toEqual(['Unsupported', 'Exact', 'Exact', 'Unsupported', 'Exact']);
    await expect(card(page, 'cron')).toContainText('Why it cannot be expressed');
    await expect(card(page, 'cron')).toContainText('Standard cron has no "last day of the month"');
    await expect(card(page, 'powershell')).toContainText('New-ScheduledTaskTrigger has no monthly trigger');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 L * ?');
    await expect(text(page, 'systemd')).toHaveText('*-*~01 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO LASTDAY /M * /ST 09:00');
    await expect(page.locator('#builder-runs tbody tr').first().locator('td').nth(1)).toHaveText('Mon 2026-11-30 09:00:00');
  });

  test('last Friday of the month', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'monthly');
    await page.getByRole('radio', { name: 'Weekday of the month', exact: true }).check();
    await page.selectOption('#builder-nth', 'last');
    await page.selectOption('#builder-nth-weekday', '5');
    await expect(page.locator('#builder-description')).toHaveText('On the last Friday of every month at 09:00, America/New_York time.');
    expect(await labels(page)).toEqual(['Unsupported', 'Exact', 'Exact', 'Unsupported', 'Exact']);
    await expect(card(page, 'cron')).toContainText('would run on days 1 to 7 and on every Friday');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 ? * 6L');
    await expect(text(page, 'systemd')).toHaveText('Fri *-*~07/1 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO LAST /D FRI /ST 09:00');
    await expect(page.locator('#builder-runs tbody tr').locator('td:nth-child(2)').first()).toHaveText('Fri 2026-11-27 09:00:00');
    await page.selectOption('#builder-nth', '2');
    await page.selectOption('#builder-nth-weekday', '1');
    await expect(text(page, 'quartz')).toHaveText('0 0 9 ? * 2#2');
    await expect(text(page, 'systemd')).toHaveText('Mon *-*-08..14 09:00:00 America/New_York');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO SECOND /D MON /ST 09:00');
  });

  test('day 31: months without it are skipped, and Windows does not document that case', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'monthly');
    await page.fill('#builder-month-day', '31');
    await expect(text(page, 'cron')).toHaveText('0 9 31 * *');
    expect(await labels(page)).toEqual(['Exact', 'Exact', 'Exact', 'Unsupported', 'Approximate']);
    await expect(page.locator('#builder-warnings')).toContainText('Day 31 does not exist in every month');
    await expect(card(page, 'schtasks')).toContainText('Task Scheduler does not document what a monthly trigger on day 31 does in months without that day');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /D 31 /ST 09:00');
    await expect(page.locator('#builder-runs tbody tr').locator('td:nth-child(2)')).toHaveText([
      'Thu 2026-12-31 09:00:00', 'Sun 2027-01-31 09:00:00', 'Wed 2027-03-31 09:00:00', 'Mon 2027-05-31 09:00:00', 'Sat 2027-07-31 09:00:00',
      'Tue 2027-08-31 09:00:00', 'Sun 2027-10-31 09:00:00', 'Fri 2027-12-31 09:00:00', 'Mon 2028-01-31 09:00:00', 'Fri 2028-03-31 09:00:00',
    ]);
  });
});

test.describe('names and commands', () => {
  test('entered names replace the placeholders, safely quoted', async ({ page }) => {
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', "Nightly 'backup'");
    await page.fill('#builder-program', 'C:\\Tools\\backup.exe');
    await page.fill('#builder-arguments', '--quiet');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "Nightly \'backup\'" /TR "C:\\Tools\\backup.exe --quiet" /SC DAILY /ST 09:00');
    const ps = (await text(page, 'powershell').textContent())!.split('\n');
    expect(ps).toContain("$action = New-ScheduledTaskAction -Execute 'C:\\Tools\\backup.exe' -Argument '--quiet'");
    expect(ps).toContain("Register-ScheduledTask -TaskName 'Nightly ''backup''' -Trigger $trigger -Action $action");
    expect(ps).toContain('# Review these lines before you run them yourself.');
    expect(ps.some(l => l.includes('<'))).toBe(false);
    await expect(card(page, 'powershell').locator('.badge', { hasText: 'Template' })).toHaveCount(0);
    await expect(card(page, 'schtasks').locator('.badge', { hasText: 'Template' })).toHaveCount(0);
  });

  test('a program path with spaces is wrapped in escaped quotes inside /TR', async ({ page }) => {
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'Backup');
    await page.fill('#builder-program', 'C:\\Program Files\\Backup\\run.exe');
    await page.fill('#builder-arguments', '--full');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "Backup" /TR "\\"C:\\Program Files\\Backup\\run.exe\\" --full" /SC DAILY /ST 09:00');
    await expect(text(page, 'powershell')).toContainText("-Execute 'C:\\Program Files\\Backup\\run.exe' -Argument '--full'");
  });

  test('characters Command Prompt cannot take safely keep the placeholder and say why', async ({ page }) => {
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'Backup & Sync');
    await page.fill('#builder-program', 'C:\\Tools\\sync.exe');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "C:\\Tools\\sync.exe" /SC DAILY /ST 09:00');
    await expect(card(page, 'schtasks')).toContainText('Task name: The character & cannot be passed safely through Command Prompt; use the PowerShell output instead. A placeholder is used instead.');
    await expect(card(page, 'schtasks').locator('.badge', { hasText: 'Template' })).toBeVisible();
    await expect(text(page, 'powershell')).toContainText("Register-ScheduledTask -TaskName 'Backup & Sync' -Trigger $trigger -Action $action");
    await page.fill('#builder-arguments', '100%');
    await expect(card(page, 'schtasks')).toContainText('Command: The character % cannot be passed safely');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 09:00');
    await expect(text(page, 'powershell')).toContainText("-Argument '100%'");
  });

  test('the schtasks start date follows the chosen date format', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'weekly');
    await page.fill('#builder-every-weeks', '3');
    await page.locator('#builder-details summary').click();
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /MO 3 /D MON /SD 11/14/2026 /ST 09:00');
    await page.selectOption('#builder-date-format', 'DMY');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /MO 3 /D MON /SD 14/11/2026 /ST 09:00');
    await page.selectOption('#builder-date-format', 'YMD');
    await expect(text(page, 'schtasks')).toContainText('/SD 2026/11/14');
    await expect(card(page, 'schtasks')).toContainText("schtasks reads it in the computer's short date format");
  });

  test('the timer unit preview keeps placeholders until a unit name is given', async ({ page }) => {
    const preview = page.locator('#builder-timer-unit');
    await preview.locator('summary').click();
    const unit = () => expect.poll(() => page.locator('#builder-timer-text').textContent());
    await unit().toBe([
      '# <NAME>.timer',
      '# Starts <NAME>.service, which you write yourself; NetForge does not generate the service.',
      '# Template: replace <NAME> and <DESCRIPTION>, review, then install it with your usual procedure.',
      '[Unit]',
      'Description=<DESCRIPTION>',
      '',
      '[Timer]',
      'OnCalendar=*-*-* 09:00:00 America/New_York',
      '# Optional: Persistent=true runs a missed activation after the next boot.',
      '# AccuracySec= defaults to 1min: the timer may elapse up to that long after the calendar time.',
      '',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n'));
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'nightly-backup');
    await expect(page.locator('#builder-timer-text')).toContainText('# nightly-backup.timer');
    await expect(page.locator('#builder-timer-text')).toContainText('Description=Timer for nightly-backup.service');
    // The preview stays open while the name is typed.
    await expect(preview).toHaveAttribute('open', '');
    await page.fill('#builder-name', 'Nightly backup');
    await expect(preview).toHaveAttribute('open', '');
    await expect(page.locator('#builder-timer-unit')).toContainText('Unit name: A unit name uses letters, digits and : _ . - only. A placeholder is used instead.');
    await expect(page.locator('#builder-timer-text')).toContainText('# <NAME>.timer');
  });
});

test.describe('zone and start date', () => {
  test('changing the zone changes the systemd zone and the runs', async ({ page }) => {
    await page.selectOption('#builder-zone', 'UTC');
    await expect(page.locator('#builder-description')).toHaveText('Every day at 09:00, UTC time.');
    await expect(text(page, 'systemd')).toHaveText('*-*-* 09:00:00 UTC');
    await expect(card(page, 'cron')).toContainText('CRON_TZ=UTC');
    await expect(page.locator('#builder-runs thead th').nth(1)).toHaveText('Local time (UTC)');
    await expect(page.locator('#builder-runs tbody tr').first().locator('td')).toHaveText(['1', 'Sun 2026-11-15 09:00:00', 'UTC+00:00', '2026-11-15T09:00:00Z', 'Scheduled']);
    await page.selectOption('#builder-zone', 'Asia/Kolkata');
    await expect(text(page, 'systemd')).toHaveText('*-*-* 09:00:00 Asia/Kolkata');
    // 17:00 UTC is 22:30 in Kolkata, so the next 09:00 there is on the 15th.
    await expect(page.locator('#builder-runs tbody tr').first().locator('td')).toHaveText(['1', 'Sun 2026-11-15 09:00:00', 'UTC+05:30', '2026-11-15T03:30:00Z', 'Scheduled']);
  });

  test('the start date anchors every-N-weeks schedules and the Windows start boundary', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'weekly');
    await page.fill('#builder-every-weeks', '2');
    await page.fill('#builder-start', '2026-11-16');
    await expect(text(page, 'schtasks')).toHaveText('schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC WEEKLY /MO 2 /D MON /SD 11/16/2026 /ST 09:00');
    await expect(text(page, 'powershell')).toContainText("$trigger.StartBoundary = '2026-11-16T09:00:00'");
    await expect(page.locator('#builder-runs tbody tr').locator('td:nth-child(2)').first()).toHaveText('Mon 2026-11-16 09:00:00');
    await expect(page.locator('#builder-runs tbody tr').locator('td:nth-child(2)').nth(1)).toHaveText('Mon 2026-11-30 09:00:00');
  });

  test('the summary lists DST changes that hit the schedule within a year', async ({ page }) => {
    await page.fill('#builder-time', '02:30');
    await expect(page.locator('#builder-dst')).toContainText('Clocks jump forward from 02:00 to 03:00 (UTC-05:00 to UTC-04:00) at 2027-03-14T07:00:00Z. On that day the scheduled time Sun 2027-03-14 02:30:00 does not exist.');
    await expect(card(page, 'systemd')).toContainText('DST changes: observed with systemd 257');
    await expect(card(page, 'schtasks')).toContainText('DST changes: Microsoft does not document how Task Scheduler handles DST changes.');
  });
});

test.describe('copy and export', () => {
  test('copies every output as text', async ({ page, context }) => {
    await grantClipboard(context);
    await expect(text(page, 'cron')).toHaveText('0 9 * * *');
    await page.getByRole('button', { name: 'Copy all', exact: true }).click();
    await expect.poll(() => readClipboard(page)).toContain('Schedule: Every day at 09:00, America/New_York time.');
    const lines = (await readClipboard(page)).split('\n');
    expect(lines.slice(0, 4)).toEqual(['Schedule: Every day at 09:00, America/New_York time.', '', 'Standard cron [exact]', '  0 9 * * *']);
    expect(lines).toContain('Windows: PowerShell (ScheduledTasks) [exact, template]');
    expect(lines).toContain('  schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC DAILY /ST 09:00');
  });

  test('copies one output', async ({ page, context }) => {
    await grantClipboard(context);
    await card(page, 'quartz').getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => readClipboard(page)).toBe('0 0 9 * * ?');
  });

  test('downloads every output and the runs as JSON', async ({ page }) => {
    await page.selectOption('#builder-frequency', 'monthly');
    await page.getByRole('radio', { name: 'Last day', exact: true }).check();
    await expect(text(page, 'quartz')).toHaveText('0 0 9 L * ?');
    const file = await download(page, () => page.getByRole('button', { name: 'JSON', exact: true }).click());
    expect(file.name).toBe('schedule-builder.json');
    const json = JSON.parse(file.text);
    expect(json).toMatchObject({
      format: 'netforge-schedule-builder', version: 1, schedule: 'On the last day of every month at 09:00, America/New_York time.',
      timeZone: 'America/New_York', runsAfter: '2026-11-14T17:00:00Z',
    });
    expect(json.outputs.map((o: { target: string; fidelity: string }) => [o.target, o.fidelity])).toEqual([
      ['cron', 'unsupported'], ['quartz', 'exact'], ['systemd', 'exact'], ['powershell', 'unsupported'], ['schtasks', 'exact'],
    ]);
    expect(json.outputs[0].text).toBeNull();
    expect(json.outputs[0].differences[0]).toContain('last day of the month');
    expect(json.outputs[4]).toMatchObject({ text: 'schtasks /Create /TN "<TASK NAME>" /TR "<COMMAND>" /SC MONTHLY /MO LASTDAY /M * /ST 09:00\n', template: true });
    expect(json.timerUnit).toContain('OnCalendar=*-*~01 09:00:00 America/New_York');
    expect(json.runs).toHaveLength(10);
    expect(json.runs[0]).toMatchObject({ index: 1, local: 'Mon 2026-11-30 09:00:00', utc: '2026-11-30T14:00:00Z', status: 'scheduled' });
  });

  test('downloads the runs as CSV', async ({ page }) => {
    await expect(text(page, 'cron')).toHaveText('0 9 * * *');
    const file = await download(page, () => page.getByRole('button', { name: 'CSV', exact: true }).click());
    expect(file.name).toBe('schedule-builder-runs.csv');
    const rows = file.text.split('\r\n');
    expect(rows[0]).toBe('#,Local time,Local ISO 8601,Time zone,UTC offset,Abbreviation,UTC,Unix seconds,Status,Note');
    expect(rows[1]).toBe("1,Sun 2026-11-15 09:00:00,2026-11-15T09:00:00-05:00,America/New_York,'-05:00,EST,2026-11-15T14:00:00Z,1794751200,Scheduled,");
    expect(rows).toHaveLength(12);
  });
});

test('nothing is run: the page offers commands as text only', async ({ page }) => {
  await expect(page.locator('#builder-outputs a[href], #builder-outputs form')).toHaveCount(0);
  const buttons = await page.locator('#builder-outputs button').evaluateAll(list => list.map(b => b.textContent ?? ''));
  expect(buttons.length).toBeGreaterThan(0);
  for (const label of buttons) expect(label).toMatch(/^Copy/);
  await expect(page.getByText('Generated commands are text to review: NetForge never runs them.')).toBeVisible();
});

test.describe('the PowerShell stop-parsing token', () => {
  test('--% typed as a name, program or arguments never ends parsing of the command', async ({ page }) => {
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'Report');
    await page.fill('#builder-program', '--%');
    await page.fill('#builder-arguments', 'x | Stop-Computer -Force #');
    await expect(text(page, 'powershell')).toContainText("New-ScheduledTaskAction -Execute ('--%') -Argument 'x | Stop-Computer -Force #'");
    await page.fill('#builder-program', 'C:\\Tools\\x.exe');
    await page.fill('#builder-arguments', '--%');
    await expect(text(page, 'powershell')).toContainText("-Execute 'C:\\Tools\\x.exe' -Argument ('--%')");
    await page.fill('#builder-name', '--%');
    await expect(text(page, 'powershell')).toContainText("Register-ScheduledTask -TaskName ('--%') -Trigger $trigger -Action $action");
    const script = (await text(page, 'powershell').textContent())!;
    expect(script).not.toMatch(/ '--%'/);
    expect(script).not.toMatch(/ --%/);
    // Command Prompt would expand the percent sign, so schtasks keeps its placeholders and says why.
    await expect(text(page, 'schtasks')).toContainText('"<TASK NAME>"');
    await expect(card(page, 'schtasks')).toContainText('cannot be passed safely through Command Prompt');
    // Longer values that merely contain the token are ordinary strings.
    await page.fill('#builder-arguments', '--% | calc');
    await expect(text(page, 'powershell')).toContainText("-Argument '--% | calc'");
  });
});
