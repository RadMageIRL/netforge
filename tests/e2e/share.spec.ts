/**
 * Share links and the RadMage Labs link: every tool's deep link and Share dialog, settings links
 * for the seven tools that have them (made, copied, then opened in a fresh browser session and
 * reloaded), refusal of bad links, and the privacy rules: nothing sensitive in a link, the address
 * bar untouched by typing, and nothing sent anywhere.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { grantClipboard, readClipboard, recordRequests, resultValue, watchErrors } from './helpers';

const OWN = `${'https'}://netforge.radmagelabs.com/`;
const LABS = `${'https'}://radmagelabs.com/`;

const TOOLS: readonly (readonly [id: string, heading: string])[] = [
  ['subnet-calculator', 'Subnet Calculator'], ['vlsm-allocator', 'VLSM Allocator'], ['network-planner', 'NetForge Subnet & VLAN Planner'],
  ['ip-range-analyzer', 'IP Range Analyzer'], ['route-summarization', 'Route Summarization'], ['cron-explainer', 'Cron Explainer'],
  ['schedule-builder', 'Schedule Builder'], ['timestamp-converter', 'Timestamp Converter'], ['json-formatter', 'JSON Formatter'],
  ['yaml-xml-tools', 'YAML/XML Tools'], ['number-bases', 'Number Bases & Bytes'], ['base64-url-hex', 'Base64 / URL / Hex'],
  ['hash-hmac', 'Hash / HMAC'], ['jwt-decoder', 'JWT Decoder'], ['regex-tester', 'Regex Tester'], ['text-tools', 'List / Text Tools'],
  ['uuid-tokens', 'UUID / Random Tokens'], ['chmod-calculator', 'chmod Calculator'], ['powershell-generator', 'PowerShell Generator'],
  ['terraform-export', 'Terraform Export'], ['network-config-export', 'Cisco / Juniper Export'],
];
const WITH_SETTINGS = new Set(['subnet-calculator', 'cron-explainer', 'schedule-builder', 'timestamp-converter', 'number-bases', 'uuid-tokens', 'chmod-calculator']);

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });

async function openShare(page: Page, id: string): Promise<void> {
  await page.locator(`#share-${id}`).click();
  await expect(page.locator('#share-dialog')).toBeVisible();
}

/** Makes the settings link from the Share dialog, as a person would, and returns what was copied. */
async function copySettingsLink(page: Page, id: string): Promise<string> {
  await openShare(page, id);
  await page.locator('#share-settings-link-copy').click();
  await expect(page.locator('#share-status')).toHaveText(/^Copied the link to .+ with these settings\.$/);
  const link = await readClipboard(page);
  expect(await page.locator('#share-settings-link').inputValue()).toBe(link);
  await page.keyboard.press('Escape');
  await expect(page.locator('#share-dialog')).toBeHidden();
  return link;
}

/** Opens a link in a new browser context: no memory, storage or history from the page that made it. */
async function openFresh(browser: Browser, baseURL: string | undefined, link: string): Promise<{ page: Page; done: () => Promise<void> }> {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/${link.slice(link.indexOf('#'))}`);
  return { page, done: () => context.close() };
}

test.describe('RadMage Labs link', () => {
  test('the sidebar and the About page link back to RadMage Labs in a new tab, and work stays in place', async ({ page, context }) => {
    await context.route(`${LABS}**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Labs stand-in</title>' }));
    await page.goto('./#/subnet-calculator');
    await page.fill('#subnet-input', '192.0.2.10/24');
    const link = page.locator('#sidebar-labs-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', LABS);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAccessibleName('RadMage Labs More tools and projects (opens in a new tab)');
    // Keyboard: the link takes focus and Enter follows it, into a new tab.
    await link.focus();
    await expect(link).toBeFocused();
    const [tab] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(LABS);
    await tab.close();
    await expect(page).toHaveURL(/#\/subnet-calculator$/);
    await expect(page.locator('#subnet-input')).toHaveValue('192.0.2.10/24');

    await page.locator('#tool-nav a[data-route="home"]').click();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    const about = page.locator('#about-labs-link');
    await expect(about).toHaveAttribute('href', LABS);
    await expect(about).toHaveAttribute('target', '_blank');
    await expect(about).toHaveAccessibleName(/^RadMage Labs .*\(opens in a new tab\)$/);
    await page.locator('a[data-tool="subnet-calculator"]').click();
    await expect(page.locator('#subnet-input')).toHaveValue('192.0.2.10/24');
  });
});

test.describe('deep links', () => {
  for (const [id, name] of TOOLS) {
    test(`#/${id} opens ${name}, survives a reload, and shares its plain link`, async ({ page, context }) => {
      const errors = watchErrors(page);
      await grantClipboard(context);
      await page.goto(`./#/${id}`);
      await expect(heading(page, name)).toBeVisible();
      await page.reload();
      await expect(heading(page, name)).toBeVisible();
      await openShare(page, id);
      await expect(page.locator('#share-title')).toHaveText(`Share ${name}`);
      await expect(page.locator('#share-tool-link')).toHaveValue(`${OWN}#/${id}`);
      await expect(page.locator('#share-tool-link-copy')).toBeFocused();
      await page.locator('#share-tool-link-copy').click();
      await expect(page.locator('#share-status')).toHaveText(`Copied the link to ${name}.`);
      expect(await readClipboard(page)).toBe(`${OWN}#/${id}`);
      if (WITH_SETTINGS.has(id)) {
        await expect(page.locator('#share-settings-heading')).toHaveText('Link with these settings');
        await expect(page.locator('#share-private')).toHaveCount(0);
      } else {
        await expect(page.locator('#share-settings-heading')).toHaveCount(0);
        await expect(page.locator('#share-private')).toContainText('never carry what you entered');
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#share-dialog')).toBeHidden();
      await expect(page.locator(`#share-${id}`)).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`#/${id}$`));
      expect(errors).toEqual([]);
    });
  }
});

test.describe('settings links', () => {
  test.beforeEach(async ({ context }) => { await grantClipboard(context); });

  test('Subnet Calculator: address, prefix, split and supernet', async ({ page, browser, baseURL }) => {
    await page.goto('./#/subnet-calculator');
    await page.fill('#subnet-input', '172.16.5.4 255.255.240.0');
    await page.locator('#split-panel summary').click();
    await page.selectOption('#split-length', '24');
    await page.locator('#supernet-panel summary').click();
    await page.selectOption('#supernet-length', '18');
    const link = await copySettingsLink(page, 'subnet-calculator');
    expect(link).toBe(`${OWN}#/subnet-calculator?v=1&ip=172.16.5.4/20&split=24&super=18`);
    await expect(page).toHaveURL(/#\/subnet-calculator$/);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    for (const p of [fresh, fresh]) {
      await expect(p.locator('#subnet-input')).toHaveValue('172.16.5.4/20');
      await expect(resultValue(p, 'broadcast')).toHaveText('172.16.15.255');
      await expect(p.locator('#split-panel')).toHaveAttribute('open', '');
      await expect(p.locator('#split-length')).toHaveValue('24');
      await expect(p.locator('#supernet-length')).toHaveValue('18');
      await expect(p.locator('#link-notice')).toHaveCount(0);
      await p.reload();
    }
    await done();
  });

  test('Cron Explainer: expression, dialect and time zone', async ({ page, browser, baseURL }) => {
    await page.goto('./#/cron-explainer');
    await page.getByRole('radio', { name: 'Quartz' }).check();
    await page.fill('#cron-input', '0 15 10 ? * 6L');
    await page.selectOption('#cron-zone', 'Europe/Berlin');
    const link = await copySettingsLink(page, 'cron-explainer');
    expect(link).toBe(`${OWN}#/cron-explainer?v=1&dialect=quartz&expr=0%2015%2010%20%3F%20*%206L&tz=Europe/Berlin`);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.getByRole('radio', { name: 'Quartz' })).toBeChecked();
    await expect(fresh.locator('#cron-input')).toHaveValue('0 15 10 ? * 6L');
    await expect(fresh.locator('#cron-zone')).toHaveValue('Europe/Berlin');
    await expect(fresh.locator('#cron-summary')).toBeVisible();
    await expect(fresh.locator('#cron-runs')).toContainText('Europe/Berlin');
    await done();
  });

  test('Schedule Builder: the schedule, never names, programs or arguments', async ({ page, browser, baseURL }) => {
    await page.goto('./#/schedule-builder');
    await page.selectOption('#builder-frequency', 'weekly');
    await page.fill('#builder-time', '06:30');
    await page.selectOption('#builder-weekday', '5');
    await page.fill('#builder-every-weeks', '2');
    await page.selectOption('#builder-zone', 'Europe/London');
    await page.fill('#builder-start', '2026-12-01');
    await page.locator('#builder-details summary').click();
    await page.fill('#builder-name', 'SentinelTaskName');
    await page.fill('#builder-program', 'C:\\Sentinel\\run.exe');
    await page.fill('#builder-arguments', '--sentinel-argument');
    await expect(page.locator('#builder-description')).toBeVisible();
    const link = await copySettingsLink(page, 'schedule-builder');
    expect(link).toBe(`${OWN}#/schedule-builder?v=1&freq=weekly&time=06:30&day=5&weeks=2&tz=Europe/London&start=2026-12-01`);
    expect(link.toLowerCase()).not.toContain('sentinel');

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.locator('#builder-frequency')).toHaveValue('weekly');
    await expect(fresh.locator('#builder-time')).toHaveValue('06:30');
    await expect(fresh.locator('#builder-weekday')).toHaveValue('5');
    await expect(fresh.locator('#builder-every-weeks')).toHaveValue('2');
    await expect(fresh.locator('#builder-zone')).toHaveValue('Europe/London');
    await expect(fresh.locator('#builder-start')).toHaveValue('2026-12-01');
    await expect(fresh.locator('#builder-name')).toHaveValue('');
    await expect(fresh.locator('#builder-program')).toHaveValue('');
    await expect(fresh.locator('#builder-description')).toHaveText(await page.locator('#builder-description').innerText());
    await done();
  });

  test('Timestamp Converter: the time, its zone and the later occurrence; the device zone is never written', async ({ page, browser, baseURL }) => {
    await page.goto('./#/timestamp-converter');
    await page.fill('#timestamp-input', '1700000000');
    await openShare(page, 'timestamp-converter');
    await expect(page.locator('#share-summary')).toContainText('Time zone: not included');
    expect(await page.locator('#share-settings-link').inputValue()).toBe(`${OWN}#/timestamp-converter?v=1&ts=1700000000&mode=auto`);
    await page.keyboard.press('Escape');

    await page.fill('#timestamp-input', '2026-11-01 01:30');
    await page.selectOption('#timestamp-zone', 'America/New_York');
    await page.getByRole('radio', { name: 'Later (-05:00)' }).check();
    const link = await copySettingsLink(page, 'timestamp-converter');
    expect(link).toBe(`${OWN}#/timestamp-converter?v=1&ts=2026-11-01%2001:30&mode=auto&tz=America/New_York&pick=later`);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.locator('#timestamp-input')).toHaveValue('2026-11-01 01:30');
    await expect(fresh.locator('#timestamp-zone')).toHaveValue('America/New_York');
    await expect(fresh.getByRole('radio', { name: 'Later (-05:00)' })).toBeChecked();
    await expect(resultValue(fresh, 'iso-utc')).toHaveText('2026-11-01T06:30:00Z');
    // A zone from a link is not saved as the person's preference.
    expect(await fresh.evaluate(() => localStorage.getItem('netforge.timeZone'))).toBeNull();
    await done();
  });

  test('Number Bases & Bytes: number, base, width, signedness and a storage amount', async ({ page, browser, baseURL }) => {
    await page.goto('./#/number-bases');
    await page.fill('#num-input', '-2');
    await page.selectOption('#num-width', '16');
    await page.getByRole('radio', { name: 'Signed', exact: true }).check();
    await page.fill('#unit-amount', '1.5');
    await page.selectOption('#unit-from', 'TB');
    const link = await copySettingsLink(page, 'number-bases');
    expect(link).toBe(`${OWN}#/number-bases?v=1&n=-2&base=10&width=16&sign=signed&group=4&amount=1.5&unit=TB`);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.locator('#num-input')).toHaveValue('-2');
    await expect(fresh.locator('#num-width')).toHaveValue('16');
    await expect(fresh.getByRole('radio', { name: 'Signed', exact: true })).toBeChecked();
    await expect(resultValue(fresh, 'hex')).toHaveText('0xfffe');
    await expect(fresh.locator('#unit-amount')).toHaveValue('1.5');
    await expect(fresh.locator('#unit-from')).toHaveValue('TB');
    await done();
  });

  test('chmod Calculator: the mode bits and file type, never the path', async ({ page, browser, baseURL }) => {
    await page.goto('./#/chmod-calculator');
    await page.getByRole('button', { name: '2775', exact: true }).click();
    await page.getByRole('radio', { name: 'Directory' }).check();
    await page.fill('#chmod-path', '/srv/sentinel-path');
    const link = await copySettingsLink(page, 'chmod-calculator');
    expect(link).toBe(`${OWN}#/chmod-calculator?v=1&mode=2775&type=directory`);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.locator('#chmod-octal')).toHaveValue('2775');
    await expect(fresh.getByRole('radio', { name: 'Directory' })).toBeChecked();
    await expect(fresh.locator('#perm-sgid')).toBeChecked();
    await expect(fresh.locator('#chmod-path')).toHaveValue('');
    await done();
  });

  test('UUID / Random Tokens: the options only; a link never carries or generates values', async ({ page, browser, baseURL }) => {
    await page.goto('./#/uuid-tokens');
    await page.selectOption('#token-kind', 'hex');
    await page.fill('#token-count', '3');
    await page.fill('#token-bytes', '16');
    await page.locator('#token-generate').click();
    const values = (await page.locator('#token-output').inputValue()).split('\n');
    expect(values).toHaveLength(3);
    const link = await copySettingsLink(page, 'uuid-tokens');
    expect(link).toBe(`${OWN}#/uuid-tokens?v=1&kind=hex&count=3&bytes=16`);
    for (const v of values) expect(link).not.toContain(v);

    const { page: fresh, done } = await openFresh(browser, baseURL, link);
    await expect(fresh.locator('#token-kind')).toHaveValue('hex');
    await expect(fresh.locator('#token-count')).toHaveValue('3');
    await expect(fresh.locator('#token-bytes')).toHaveValue('16');
    await expect(fresh.locator('#token-output')).toHaveValue('');
    await done();
  });

  test('a settings link is offered only for valid settings', async ({ page }) => {
    await page.goto('./#/subnet-calculator');
    await openShare(page, 'subnet-calculator');
    await expect(page.locator('#share-settings-unavailable')).toHaveText('Enter a valid address and prefix to put them in a link.');
    await expect(page.locator('#share-settings-link')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.fill('#subnet-input', '10.0.0.1/40');
    await openShare(page, 'subnet-calculator');
    await expect(page.locator('#share-settings-unavailable')).toBeVisible();
  });
});

test.describe('links that cannot be used', () => {
  const BAD: readonly (readonly [what: string, query: string, reason: string])[] = [
    ['an unknown setting', 'v=1&ip=192.0.2.0/24&note=hi', 'one of its settings is not valid for this tool'],
    ['an invalid value', 'v=1&ip=192.0.2.0/33', 'one of its settings is not valid for this tool'],
    ['a contradiction', 'v=1&ip=192.0.2.0/24&split=20', 'one of its settings is not valid for this tool'],
    ['a repeated setting', 'v=1&ip=192.0.2.0/24&ip=10.0.0.0/8', 'the link names the same setting twice'],
    ['another version', 'v=2&ip=192.0.2.0/24', 'the link was made by a version of NetForge that wrote settings differently'],
    ['no version', 'ip=192.0.2.0/24', 'the link was made by a version of NetForge that wrote settings differently'],
    ['bad encoding', 'v=1&ip=%E0%A4%A', 'part of the link could not be read'],
    ['an oversized link', `v=1&ip=192.0.2.0/24&pad=${'x'.repeat(2000)}`, 'the link is longer than NetForge reads'],
  ];
  for (const [what, query, reason] of BAD) {
    test(`a link with ${what} opens the tool as usual and says why`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto(`./#/subnet-calculator?${query}`);
      await expect(heading(page, 'Subnet Calculator')).toBeVisible();
      await expect(page.locator('#link-notice')).toHaveText(`The settings in this link were not used: ${reason}. Subnet Calculator opened as it normally does.Dismiss`);
      await expect(page.locator('#subnet-input')).toHaveValue('');
      await page.locator('#link-notice').getByRole('button', { name: 'Dismiss' }).click();
      await expect(page.locator('#link-notice')).toHaveCount(0);
      await expect(heading(page, 'Subnet Calculator')).toBeFocused();
      expect(errors).toEqual([]);
    });
  }

  test('tools that hold secrets or private data never take settings from a link', async ({ page }) => {
    const cases: readonly [string, string, string][] = [
      ['jwt-decoder', 'v=1&token=eyJhbGciOiJIUzI1NiJ9.e30.x', '#jwt-input'],
      ['hash-hmac', 'v=1&key=secret&text=hello', '#hash-key'],
      ['network-planner', 'v=1&plan=site-a', '#plan-name'],
      ['regex-tester', 'v=1&pattern=a%2B&text=aaa', '#regex-pattern'],
      ['powershell-generator', 'v=1&script=Remove-Item', ''],
    ];
    for (const [id, query, field] of cases) {
      await page.goto(`./#/${id}?${query}`);
      await expect(page.locator('#link-notice')).toContainText('this tool never takes settings from a link');
      if (field && (await page.locator(field).count()) > 0) await expect(page.locator(field)).toHaveValue('');
    }
  });

  test('a link for a missing tool shows the not-found page', async ({ page }) => {
    await page.goto('./#/no-such-tool?v=1&a=1');
    await expect(heading(page, 'Page not found')).toBeVisible();
  });

  test('Back to a link does not apply it again over later work', async ({ page }) => {
    await page.goto('./#/chmod-calculator?v=1&mode=700');
    await expect(page.locator('#chmod-octal')).toHaveValue('700');
    await page.getByRole('button', { name: '644', exact: true }).click();
    await page.locator('a[data-tool="json-formatter"]').click();
    await page.goBack();
    await expect(heading(page, 'chmod Calculator')).toBeVisible();
    await expect(page.locator('#chmod-octal')).toHaveValue('644');
  });
});

test.describe('sharing is explicit and private', () => {
  test('typing never changes the address, and copying sends nothing anywhere', async ({ page, context, baseURL }) => {
    await grantClipboard(context);
    const log = await recordRequests(context, new URL(baseURL!).origin);
    await page.goto('./#/subnet-calculator');
    const entries = await page.evaluate(() => window.history.length);
    await page.fill('#subnet-input', '198.51.100.7/32');
    await page.keyboard.type(' ');
    await page.keyboard.press('Backspace');
    await expect(page).toHaveURL(`${baseURL}/#/subnet-calculator`);
    const before = log.all.length;
    await copySettingsLink(page, 'subnet-calculator');
    await expect(page).toHaveURL(`${baseURL}/#/subnet-calculator`);
    expect(await page.evaluate(() => window.history.length)).toBe(entries);
    expect(log.all.slice(before)).toEqual([]);
    expect(log.blockedExternal).toEqual([]);
  });

  test('the JWT Decoder shares only its plain link, whatever was pasted', async ({ page, context }) => {
    await grantClipboard(context);
    await page.goto('./#/jwt-decoder');
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZW50aW5lbCJ9.c2lnbmF0dXJl';
    await page.fill('#jwt-input', token);
    await openShare(page, 'jwt-decoder');
    await expect(page.locator('#share-settings-link')).toHaveCount(0);
    await page.locator('#share-tool-link-copy').click();
    expect(await readClipboard(page)).toBe(`${OWN}#/jwt-decoder`);
    expect(await page.locator('#share-dialog').innerText()).not.toContain('eyJ');
  });

  test('when copying is blocked the link is selected for copying by hand', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } });
      document.execCommand = () => false;
    });
    await page.goto('./#/chmod-calculator');
    await openShare(page, 'chmod-calculator');
    await page.locator('#share-settings-link-copy').click();
    await expect(page.locator('#share-status')).toHaveText('Copy did not work here. The link is selected in the box: copy it from there.');
    await expect(page.locator('#share-settings-link')).toBeFocused();
  });

  test('the dialog works from the keyboard and holds focus while open', async ({ page }) => {
    await page.goto('./#/number-bases');
    await page.locator('#share-number-bases').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#share-tool-link-copy')).toBeFocused();
    await page.keyboard.press('/');
    await expect(page.locator('#tool-search')).not.toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#share-dialog :focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#share-dialog')).toBeHidden();
    await expect(page.locator('#share-number-bases')).toBeFocused();
  });
});
