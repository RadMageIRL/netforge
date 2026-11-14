import { expect, test, type Page } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

// playwright.config.ts runs the browser in America/New_York. Expected values were worked out by
// hand from the calendar (2026-11-14 is a Saturday; US DST in 2026 starts March 8 and ends
// November 1 at 02:00 local) and the dialects' documented rules.

test.beforeEach(async ({ page }) => {
  await openTool(page, 'cron-explainer', 'Cron Explainer');
});

const runs = (page: Page) => page.locator('#cron-runs tbody tr');
/** The caret block's exact text (toHaveText would collapse the spaces that position the caret). */
const caret = (page: Page) => expect.poll(() => page.locator('#cron-result .caret-block').textContent());
const cells = (page: Page, row: number) => runs(page).nth(row).locator('td');

async function explain(page: Page, expression: string, from = ''): Promise<void> {
  await page.fill('#cron-from', from);
  await page.fill('#cron-input', expression);
}

async function dialect(page: Page, name: 'Standard cron' | 'Quartz' | 'systemd calendar'): Promise<void> {
  await page.getByRole('radio', { name, exact: true }).check();
}

test.describe('dialects', () => {
  test('switching dialect changes the hint and examples', async ({ page }) => {
    const hint = page.locator('#cron-input-hint');
    await expect(hint).toContainText('Five fields: minute, hour, day of month, month, day of week');
    await expect(page.locator('.examples .chip').first()).toHaveText('*/15 * * * *');
    await dialect(page, 'Quartz');
    await expect(hint).toContainText('Six or seven fields: second, minute, hour');
    await expect(page.locator('.examples .chip').first()).toHaveText('0 0/15 * * * ?');
    await expect(page.locator('#cron-input')).toHaveAttribute('placeholder', '0 0/15 * * * ?');
    await dialect(page, 'systemd calendar');
    await expect(hint).toContainText('An OnCalendar= value');
    await expect(page.locator('.examples .chip').first()).toHaveText('Mon..Fri 09:00');
  });

  test('an example fills the input and is explained', async ({ page }) => {
    await page.locator('.examples .chip', { hasText: '0 9 * * 1-5' }).click();
    await expect(page.locator('#cron-input')).toHaveValue('0 9 * * 1-5');
    await expect(page.locator('#cron-summary')).toHaveText('At 09:00, on Monday through Friday.');
  });

  test('a Quartz expression is never read as cron on its own: switching is explicit', async ({ page }) => {
    const errors = watchErrors(page);
    await explain(page, '0 0 12 * * ?');
    await expect(page.locator('#cron-input-error')).toContainText('Standard cron has exactly 5 fields; this has 6.');
    await expect(page.locator('#cron-summary')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Standard cron', exact: true })).toBeChecked();
    await page.locator('#cron-switch').click();
    await expect(page.getByRole('radio', { name: 'Quartz', exact: true })).toBeChecked();
    await expect(page.locator('#cron-input')).toHaveValue('0 0 12 * * ?');
    await expect(page.locator('#cron-summary')).toHaveText('At 12:00.');
    expect(errors).toEqual([]);
  });

  test('a cron expression is never read as Quartz on its own: switching is explicit', async ({ page }) => {
    await dialect(page, 'Quartz');
    await explain(page, '0 9 * * 1-5');
    await expect(page.locator('#cron-input-error')).toContainText('Quartz expressions have 6 or 7 fields; this has 5.');
    await expect(page.locator('#cron-switch')).toHaveText('Read as Standard cron');
    await page.locator('#cron-switch').click();
    await expect(page.getByRole('radio', { name: 'Standard cron', exact: true })).toBeChecked();
    await expect(page.locator('#cron-summary')).toHaveText('At 09:00, on Monday through Friday.');
  });

  test('no switch is offered when the other dialect would not read it either', async ({ page }) => {
    await explain(page, '* * * *');
    await expect(page.locator('#cron-input-error')).toContainText('this has 4');
    await expect(page.locator('#cron-switch')).toHaveCount(0);
  });
});

test.describe('standard cron', () => {
  test('explains each field and lists ten runs in local time and UTC', async ({ page }) => {
    const errors = watchErrors(page);
    await explain(page, '0 9 * * 1-5', '2026-11-14 12:00');
    await expect(page.locator('#cron-summary')).toHaveText('At 09:00, on Monday through Friday.');
    const fields = page.locator('#cron-fields tbody tr');
    await expect(fields).toHaveCount(5);
    await expect(fields.nth(0).locator('td')).toHaveText(['Minute', '0', 'minute 0', '0']);
    await expect(fields.nth(1).locator('td')).toHaveText(['Hour', '9', 'hour 9', '9']);
    await expect(fields.nth(2).locator('td')).toHaveText(['Day of month', '*', 'any day of the month', '1-31']);
    await expect(fields.nth(3).locator('td')).toHaveText(['Month', '*', 'every month', 'all']);
    await expect(fields.nth(4).locator('td')).toHaveText(['Day of week', '1-5', 'Monday through Friday', 'Mon, Tue, Wed, Thu, Fri']);
    await expect(page.locator('#cron-runs thead th')).toHaveText(['#', 'Local time (America/New_York)', 'Zone', 'UTC', 'Status']);
    await expect(runs(page)).toHaveCount(10);
    await expect(cells(page, 0)).toHaveText(['1', 'Mon 2026-11-16 09:00:00', 'EST UTC-05:00', '2026-11-16T14:00:00Z', 'Scheduled']);
    await expect(cells(page, 4)).toHaveText(['5', 'Fri 2026-11-20 09:00:00', 'EST UTC-05:00', '2026-11-20T14:00:00Z', 'Scheduled']);
    await expect(cells(page, 5)).toHaveText(['6', 'Mon 2026-11-23 09:00:00', 'EST UTC-05:00', '2026-11-23T14:00:00Z', 'Scheduled']);
    await expect(cells(page, 9)).toHaveText(['10', 'Fri 2026-11-27 09:00:00', 'EST UTC-05:00', '2026-11-27T14:00:00Z', 'Scheduled']);
    await expect(page.locator('#cron-warnings')).toHaveCount(0);
    await expect(page.locator('#cron-notes')).toContainText('Cron uses the time zone of the cron daemon');
    expect(errors).toEqual([]);
  });

  test('runs cross a DST change with the new abbreviation and offset', async ({ page }) => {
    await explain(page, '0 12 * * 0', '2026-02-28 00:00');
    await expect(cells(page, 0)).toHaveText(['1', 'Sun 2026-03-01 12:00:00', 'EST UTC-05:00', '2026-03-01T17:00:00Z', 'Scheduled']);
    await expect(cells(page, 1)).toHaveText(['2', 'Sun 2026-03-08 12:00:00', 'EDT UTC-04:00', '2026-03-08T16:00:00Z', 'Scheduled']);
  });

  test('warns about the OR rule when both day fields are set', async ({ page }) => {
    await explain(page, '0 0 1-7 * 1', '2026-11-14 12:00');
    await expect(page.locator('#cron-warnings')).toContainText('cron runs on days that match EITHER one (the OR rule)');
    // Mondays and days 1 to 7 both count: Nov 16, 23 and 30 are Mondays, then Dec 1 to 7.
    await expect(runs(page).locator('td:nth-child(2)')).toHaveText([
      'Mon 2026-11-16 00:00:00', 'Mon 2026-11-23 00:00:00', 'Mon 2026-11-30 00:00:00', 'Tue 2026-12-01 00:00:00', 'Wed 2026-12-02 00:00:00',
      'Thu 2026-12-03 00:00:00', 'Fri 2026-12-04 00:00:00', 'Sat 2026-12-05 00:00:00', 'Sun 2026-12-06 00:00:00', 'Mon 2026-12-07 00:00:00',
    ]);
  });

  test('warns that Vixie cron ANDs the day fields when one starts with *', async ({ page }) => {
    await explain(page, '0 0 */2 * 1', '2026-11-14 12:00');
    await expect(page.locator('#cron-warnings')).toContainText('Vixie cron and cronie require BOTH day fields to match (AND)');
    // Odd-numbered days that are Mondays: Nov 23, Dec 7, Dec 21, Jan 11.
    await expect(runs(page).locator('td:nth-child(2)').first()).toHaveText('Mon 2026-11-23 00:00:00');
    await expect(runs(page).nth(1).locator('td').nth(1)).toHaveText('Mon 2026-12-07 00:00:00');
    await expect(runs(page).nth(3).locator('td').nth(1)).toHaveText('Mon 2027-01-11 00:00:00');
  });

  test('says when a schedule never runs', async ({ page }) => {
    await explain(page, '0 0 30 2 *');
    await expect(page.locator('#cron-warnings')).toContainText('None of the selected months has day 30, so this never runs.');
    await expect(page.locator('#cron-stop')).toHaveText('This schedule never runs: no date matches all of its fields.');
    await expect(page.locator('#cron-runs')).toHaveCount(0);
  });

  test('expands nicknames', async ({ page }) => {
    await explain(page, '@weekly', '2026-11-14 12:00');
    await expect(page.locator('#cron-normalized')).toHaveText('Expands to: 0 0 * * 0');
    await expect(cells(page, 0)).toHaveText(['1', 'Sun 2026-11-15 00:00:00', 'EST UTC-05:00', '2026-11-15T05:00:00Z', 'Scheduled']);
  });

  for (const [input, message, caretLine] of [
    ['0 0 * * 8', '"8" is out of range for day of week: use 0-7 or sun-sat.', '        ^'],
    ['5/15 * * * *', 'in standard cron a step needs * or a range. Write 5-59/15', '^^^^'],
    ['0 0 ? * *', '"?" is Quartz syntax.', '    ^'],
    ['0 0 * * 5-1', '"5-1" runs backwards.', '        ^^^'],
  ] as const) {
    test(`rejects ${input} and points at the problem`, async ({ page }) => {
      await explain(page, input);
      await expect(page.locator('#cron-input-error')).toContainText(message);
      await expect(page.locator('#cron-input')).toHaveAttribute('aria-invalid', 'true');
      await caret(page).toBe(`${input}\n${caretLine}`);
      await expect(page.locator('#cron-runs')).toHaveCount(0);
      await page.fill('#cron-input', '0 0 * * 1');
      await expect(page.locator('#cron-input')).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#cron-input-error')).toBeHidden();
    });
  }
});

test.describe('DST changes', () => {
  test('a time skipped by the spring-forward change is shown in place and not counted', async ({ page }) => {
    await explain(page, '30 2 * * *', '2026-03-07 12:00');
    const first = runs(page).first();
    await expect(first).toHaveAttribute('data-status', 'nonexistent');
    await expect(first.locator('td')).toHaveText([
      '', 'Sun 2026-03-08 02:30:00', '', 'none',
      /^Does not exist\s*Clocks jump forward from 02:00 to 03:00 \(UTC-05:00 to UTC-04:00\) at 2026-03-08T07:00:00Z\. This local time does not exist\./,
    ]);
    await expect(runs(page)).toHaveCount(11);
    await expect(cells(page, 1)).toHaveText(['1', 'Mon 2026-03-09 02:30:00', 'EDT UTC-04:00', '2026-03-09T06:30:00Z', 'Scheduled']);
    await expect(cells(page, 10)).toHaveText(['10', 'Wed 2026-03-18 02:30:00', 'EDT UTC-04:00', '2026-03-18T06:30:00Z', 'Scheduled']);
    await expect(page.locator('#cron-dst')).toContainText('On that day the scheduled time Sun 2026-03-08 02:30:00 does not exist.');
  });

  test('several skipped times collapse into one row', async ({ page }) => {
    await explain(page, '*/20 2 * * *', '2026-03-08 00:00');
    await expect(cells(page, 0).nth(1)).toHaveText('Sun 2026-03-08 02:00:00 to 02:40:00 (3 times)');
    await expect(runs(page).first().locator('.badge')).toHaveText('Does not exist');
    await expect(cells(page, 1)).toHaveText(['1', 'Mon 2026-03-09 02:00:00', 'EDT UTC-04:00', '2026-03-09T06:00:00Z', 'Scheduled']);
  });

  test('cron lists both passes of a time repeated by the fall-back change', async ({ page }) => {
    await explain(page, '30 1 * * *', '2026-10-31 12:00');
    await expect(cells(page, 0)).toHaveText(['1', 'Sun 2026-11-01 01:30:00', 'EDT UTC-04:00', '2026-11-01T05:30:00Z', /^Scheduled \(1st of 2\)\s*Clocks go back from 02:00 to 01:00/]);
    await expect(cells(page, 1)).toHaveText(['2', 'Sun 2026-11-01 01:30:00', 'EST UTC-05:00', '2026-11-01T06:30:00Z', /^Uncertain \(2nd of 2\)\s*Clocks go back/]);
    await expect(runs(page).nth(1)).toHaveAttribute('data-status', 'uncertain');
    await expect(cells(page, 2)).toHaveText(['3', 'Mon 2026-11-02 01:30:00', 'EST UTC-05:00', '2026-11-02T06:30:00Z', 'Scheduled']);
  });

  test('systemd runs a repeated time once and marks the repeat as skipped', async ({ page }) => {
    await dialect(page, 'systemd calendar');
    await explain(page, '*-*-* 01:30:00', '2026-10-31 12:00');
    await expect(cells(page, 0)).toHaveText(['1', 'Sun 2026-11-01 01:30:00', 'EDT UTC-04:00', '2026-11-01T05:30:00Z', /^Scheduled \(1st of 2\)/]);
    await expect(runs(page).nth(1)).toHaveAttribute('data-status', 'skipped');
    await expect(cells(page, 1)).toHaveText(['', 'Sun 2026-11-01 01:30:00', 'UTC-05:00', 'none', /^Skipped \(repeat\)\s*Clocks go back.*systemd 257 runs it once/]);
    await expect(cells(page, 2)).toHaveText(['2', 'Mon 2026-11-02 01:30:00', 'EST UTC-05:00', '2026-11-02T06:30:00Z', 'Scheduled']);
    await expect(runs(page)).toHaveCount(11);
  });

  test('a start time inside a skipped hour is refused', async ({ page }) => {
    await explain(page, '0 * * * *', '2026-03-08 02:30');
    await expect(page.locator('#cron-from-error')).toContainText('does not exist in America/New_York');
  });
});

test.describe('time zones', () => {
  test('a chosen zone is used for the runs and their abbreviations', async ({ page }) => {
    await page.locator('#cron-zone').selectOption('Asia/Kolkata');
    await explain(page, '0 9 * * 1-5', '2026-11-14 00:00');
    await expect(page.locator('#cron-runs thead th').nth(1)).toHaveText('Local time (Asia/Kolkata)');
    await expect(cells(page, 0)).toHaveText(['1', 'Mon 2026-11-16 09:00:00', 'UTC+05:30', '2026-11-16T03:30:00Z', 'Scheduled']);
    await page.locator('#cron-zone').selectOption('UTC');
    await expect(cells(page, 0)).toHaveText(['1', 'Mon 2026-11-16 09:00:00', 'UTC+00:00', '2026-11-16T09:00:00Z', 'Scheduled']);
  });

  test('a start time with an offset is an instant whatever the zone', async ({ page }) => {
    await explain(page, '0 * * * *', '2026-11-14T17:10:00Z');
    await expect(cells(page, 0)).toHaveText(['1', 'Sat 2026-11-14 13:00:00', 'EST UTC-05:00', '2026-11-14T18:00:00Z', 'Scheduled']);
  });

  test('a systemd expression with its own zone is computed and shown there', async ({ page }) => {
    await dialect(page, 'systemd calendar');
    await explain(page, 'Mon *-05~07/1 12:00 Europe/Berlin', '2026-11-14 12:00');
    await expect(page.locator('#cron-normalized')).toHaveText('Normalized form: Mon *-05~07/1 12:00:00 Europe/Berlin');
    await expect(page.locator('#cron-summary')).toHaveText('At 12:00, on the last Monday of May, Europe/Berlin time.');
    await expect(page.locator('#cron-result')).toContainText('This expression names its own time zone, so runs are shown in Europe/Berlin.');
    await expect(page.locator('#cron-runs thead th').nth(1)).toHaveText('Local time (Europe/Berlin)');
    await expect(cells(page, 0)).toHaveText(['1', 'Mon 2027-05-31 12:00:00', 'UTC+02:00', '2027-05-31T10:00:00Z', 'Scheduled']);
    await expect(cells(page, 1).nth(1)).toHaveText('Mon 2028-05-29 12:00:00');
  });
});

test.describe('Quartz and systemd', () => {
  test('Quartz: the last Friday of the month', async ({ page }) => {
    await dialect(page, 'Quartz');
    await explain(page, '0 15 10 ? * 6L', '2026-11-14 12:00');
    await expect(page.locator('#cron-summary')).toHaveText('At 10:15, on the last Friday of the month.');
    await expect(page.locator('#cron-fields tbody tr').nth(5).locator('td')).toHaveText(['Day of week', '6L', 'the last Friday of the month', 'last Fri']);
    await expect(runs(page).locator('td:nth-child(2)')).toHaveText([
      'Fri 2026-11-27 10:15:00', 'Fri 2026-12-25 10:15:00', 'Fri 2027-01-29 10:15:00', 'Fri 2027-02-26 10:15:00', 'Fri 2027-03-26 10:15:00',
      'Fri 2027-04-30 10:15:00', 'Fri 2027-05-28 10:15:00', 'Fri 2027-06-25 10:15:00', 'Fri 2027-07-30 10:15:00', 'Fri 2027-08-27 10:15:00',
    ]);
    await expect(cells(page, 4).nth(3)).toHaveText('2027-03-26T14:15:00Z');
  });

  test('Quartz rejects both day fields and explains the ? rule', async ({ page }) => {
    await dialect(page, 'Quartz');
    await explain(page, '0 0 12 * * *');
    await expect(page.locator('#cron-input-error')).toContainText('Quartz needs "?" in either day-of-month or day-of-week');
    await caret(page).toBe('0 0 12 * * *\n           ^');
  });

  test('Quartz rejects what it cannot support correctly', async ({ page }) => {
    await dialect(page, 'Quartz');
    await explain(page, '0 0 9 31W * ?');
    await expect(page.locator('#cron-input-error')).toContainText('NetForge accepts W only for days 1 to 28');
    await explain(page, '0 0 9 ? * 0');
    await expect(page.locator('#cron-input-error')).toContainText('Quartz numbers weekdays 1 (Sunday) to 7 (Saturday)');
  });

  test('systemd: monotonic settings and cron steps are refused with a reason', async ({ page }) => {
    await dialect(page, 'systemd calendar');
    await explain(page, 'OnBootSec=15min');
    await expect(page.locator('#cron-input-error')).toContainText('OnBootSec= is a monotonic timer setting');
    await expect(page.locator('#cron-input')).toHaveAttribute('aria-invalid', 'true');
    await explain(page, '*:*/15');
    await expect(page.locator('#cron-input-error')).toContainText('systemd has no "*/n". Write a start and a repetition, such as 0/15');
    await caret(page).toBe('*:*/15\n  ^^^^');
  });

  test('systemd: normalization and a date that is already past', async ({ page }) => {
    await dialect(page, 'systemd calendar');
    await explain(page, 'Sat,Thu,Mon..Wed,Sat..Sun');
    await expect(page.locator('#cron-normalized')).toHaveText('Normalized form: Mon..Thu,Sat,Sun *-*-* 00:00:00');
    await explain(page, '2012-10-15');
    await expect(page.locator('#cron-stop')).toHaveText('No runs after the start time: every date this expression allows is earlier.');
    await expect(page.locator('#cron-runs')).toHaveCount(0);
  });

  test('systemd: a timer unit preview is offered as a template, only for systemd', async ({ page }) => {
    await explain(page, '0 9 * * 1-5');
    await expect(page.locator('#cron-timer-unit')).toHaveCount(0);
    await dialect(page, 'systemd calendar');
    await explain(page, 'Mon..Fri 9:00 Europe/Berlin');
    const preview = page.locator('#cron-timer-unit');
    await expect(preview).not.toHaveAttribute('open');
    await preview.locator('summary').click();
    await expect(preview).toContainText('Template');
    const text = await page.locator('#cron-timer-text').textContent();
    expect(text).toContain('OnCalendar=Mon..Fri *-*-* 09:00:00 Europe/Berlin');
    expect(text).toContain('# <NAME>.timer');
    expect(text).toContain('WantedBy=timers.target');
    expect(text).not.toContain('ExecStart');
  });
});

test.describe('copy and export', () => {
  test('copies the explanation and runs as text', async ({ page, context }) => {
    await grantClipboard(context);
    await explain(page, '0 9 * * 1-5', '2026-11-14 12:00');
    await expect(cells(page, 0).nth(1)).toHaveText('Mon 2026-11-16 09:00:00');
    await page.getByRole('button', { name: 'Copy results' }).click();
    await expect.poll(() => readClipboard(page)).toContain('Standard cron: 0 9 * * 1-5');
    const text = await readClipboard(page);
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'Standard cron: 0 9 * * 1-5',
      'Meaning: At 09:00, on Monday through Friday.',
      'Time zone: America/New_York',
      '',
      'Next runs after 2026-11-14T17:00:00Z:',
      '  1  Mon 2026-11-16 09:00:00 EST (-05:00)  =  2026-11-16T14:00:00Z',
    ]);
    expect(lines).toContain(' 10  Fri 2026-11-27 09:00:00 EST (-05:00)  =  2026-11-27T14:00:00Z');
  });

  test('downloads the runs as CSV', async ({ page }) => {
    await explain(page, '0 9 * * 1-5', '2026-11-14 12:00');
    await expect(cells(page, 0).nth(1)).toHaveText('Mon 2026-11-16 09:00:00');
    const file = await download(page, () => page.getByRole('button', { name: 'CSV' }).click());
    expect(file.name).toBe('schedule-cron-runs.csv');
    const rows = file.text.split('\r\n');
    expect(rows[0]).toBe('#,Local time,Local ISO 8601,Time zone,UTC offset,Abbreviation,UTC,Unix seconds,Status,Note');
    // The offset starts with "-", so the formula guard prefixes an apostrophe.
    expect(rows[1]).toBe("1,Mon 2026-11-16 09:00:00,2026-11-16T09:00:00-05:00,America/New_York,'-05:00,EST,2026-11-16T14:00:00Z,1794837600,Scheduled,");
    expect(rows).toHaveLength(12);
    expect(rows[11]).toBe('');
  });

  test('downloads the explanation and runs as JSON', async ({ page }) => {
    await explain(page, '0 9 * * 1-5', '2026-11-14 12:00');
    await expect(cells(page, 0).nth(1)).toHaveText('Mon 2026-11-16 09:00:00');
    const file = await download(page, () => page.getByRole('button', { name: 'JSON' }).click());
    expect(file.name).toBe('schedule-cron.json');
    const json = JSON.parse(file.text);
    expect(json).toMatchObject({
      format: 'netforge-schedule-explanation', version: 1, dialect: 'cron', dialectName: 'Standard cron', expression: '0 9 * * 1-5',
      timeZone: 'America/New_York', runsAfter: '2026-11-14T17:00:00Z', summary: 'At 09:00, on Monday through Friday.', searchStopped: null,
    });
    expect(json.fields).toHaveLength(5);
    expect(json.runs).toHaveLength(10);
    expect(json.runs[0]).toEqual({
      index: 1, local: 'Mon 2026-11-16 09:00:00', localIso: '2026-11-16T09:00:00-05:00', offset: '-05:00', abbreviation: 'EST',
      utc: '2026-11-16T14:00:00Z', unixSeconds: 1794837600, status: 'scheduled', statusLabel: 'Scheduled', note: null,
    });
    expect(json.dst.basis).toContain('cronie');
  });

  test('exports keep the DST rows and their notes', async ({ page }) => {
    await explain(page, '30 2 * * *', '2026-03-07 12:00');
    await expect(runs(page)).toHaveCount(11);
    const file = await download(page, () => page.getByRole('button', { name: 'JSON' }).click());
    const json = JSON.parse(file.text);
    expect(json.runs).toHaveLength(11);
    expect(json.runs[0]).toMatchObject({ index: null, local: 'Sun 2026-03-08 02:30:00', localIso: null, utc: null, status: 'nonexistent', statusLabel: 'Does not exist' });
    expect(json.runs[0].note).toContain('Clocks jump forward from 02:00 to 03:00');
    expect(json.dstChangesAhead[0]).toContain('does not exist');
  });

  test('export buttons are disabled until there is a result', async ({ page }) => {
    for (const name of ['Copy results', 'CSV', 'JSON']) await expect(page.getByRole('button', { name })).toBeDisabled();
    await explain(page, '0 0 * * 8');
    for (const name of ['Copy results', 'CSV', 'JSON']) await expect(page.getByRole('button', { name })).toBeDisabled();
    await page.fill('#cron-input', '0 0 * * 1');
    for (const name of ['Copy results', 'CSV', 'JSON']) await expect(page.getByRole('button', { name })).toBeEnabled();
  });
});

test.describe('keyboard', () => {
  test('Tab reaches the dialect, the input, the examples, the zone and the start time in order', async ({ page }) => {
    await page.getByRole('radio', { name: 'Standard cron', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#cron-input')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.examples .chip').first()).toBeFocused();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    await expect(page.locator('#cron-zone')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#cron-from')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#cron-zone')).toBeFocused();
  });

  test('arrow keys move between dialects and the chosen one applies', async ({ page }) => {
    await page.fill('#cron-input', '0 0 12 * * ?');
    await page.getByRole('radio', { name: 'Standard cron', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Quartz', exact: true })).toBeFocused();
    await expect(page.getByRole('radio', { name: 'Quartz', exact: true })).toBeChecked();
    await expect(page.locator('#cron-summary')).toHaveText('At 12:00.');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'systemd calendar', exact: true })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: 'Standard cron', exact: true })).toBeChecked();
  });

  test('pressing Enter on an example chip fills the input', async ({ page }) => {
    await page.locator('.examples .chip').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#cron-input')).toHaveValue('0 9 * * 1-5');
    await expect(page.locator('#cron-input')).toBeFocused();
  });
});
