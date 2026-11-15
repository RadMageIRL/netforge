import { expect, test, type Page } from '@playwright/test';
import { grantClipboard, readClipboard } from './helpers';

/**
 * Keyboard-only use, beyond what an automated accessibility scan sees: every stop the Tab key
 * makes is visible, shows a focus indicator and has an accessible name; Tab reaches every control
 * of a tool in document order and never gets trapped; and results can be produced and copied
 * without a pointer.
 */
const ROUTES = [
  '#/subnet-calculator', '#/vlsm-allocator', '#/network-planner', '#/ip-range-analyzer', '#/route-summarization', '#/cron-explainer', '#/schedule-builder',
  '#/timestamp-converter', '#/json-formatter', '#/yaml-xml-tools', '#/number-bases', '#/base64-url-hex', '#/hash-hmac', '#/jwt-decoder', '#/regex-tester',
  '#/text-tools', '#/uuid-tokens', '#/chmod-calculator', '#/powershell-generator', '#/terraform-export', '#/network-config-export', '#/about',
];

interface Stop {
  readonly what: string;
  readonly visible: boolean;
  readonly indicator: boolean;
  readonly named: boolean;
  readonly inMain: boolean;
  readonly order: number;
  /** A native date or time input, which Tab steps through part by part. */
  readonly segmented: boolean;
}

async function focused(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // A radio drawn as a segmented control shows its focus ring on the label text next to it.
    const shown = el.matches('.segmented-input') ? (el.nextElementSibling as HTMLElement) : el;
    const s = getComputedStyle(shown);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1.5;
    const ring = s.boxShadow !== 'none';
    const name = (el.getAttribute('aria-label') ?? '') + (el.getAttribute('aria-labelledby') ? 'x' : '') + (el.textContent ?? '').trim()
      + ((el as HTMLInputElement).labels && (el as HTMLInputElement).labels!.length > 0 ? 'x' : '') + (el.getAttribute('title') ?? '');
    const all = [...document.querySelectorAll('*')];
    return {
      what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''}`,
      visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && !el.closest('[hidden]') && !el.closest('[inert]'),
      indicator: outline || ring,
      named: name.length > 0,
      inMain: !!el.closest('main'),
      order: all.indexOf(el),
      segmented: el instanceof HTMLInputElement && (el.type === 'time' || el.type === 'date'),
    };
  });
}

test('Tab stops in every tool are visible, named and marked, in document order, with no trap', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  for (const route of ROUTES) {
    await page.goto(`./${route}`);
    await expect(page.locator('h1:visible')).toHaveCount(1);
    const expected = await page.locator('main').evaluate(main => [...main.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex="0"]')]
      .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.checkVisibility() && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden'
        // One Tab stop per radio group and per tab list.
        && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) && el.getAttribute('aria-selected') !== 'false').length);
    // Start from the page heading, where navigation puts focus.
    await page.locator('h1:visible').focus();
    let last = -1;
    let repeats = 0;
    let inMain = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      await page.keyboard.press('Tab');
      const stop = await focused(page);
      if (!stop || !stop.inMain) break;
      // A native time field has several Tab stops of its own (hours, minutes, AM or PM).
      if (stop.order === last && stop.segmented && ++repeats < 6) continue;
      repeats = 0;
      // Coming back to a stop means the walk is over: after the last control Firefox hands focus
      // to the browser window and leaves the element as it was. A real trap ends the walk early,
      // and the count below reports it.
      if (seen.has(stop.order)) { if (inMain < expected) problems.push(`${route}: focus trapped at ${stop.what}`); break; }
      seen.add(stop.order);
      inMain++;
      if (!stop.visible) problems.push(`${route}: hidden element takes focus: ${stop.what}`);
      if (!stop.indicator) problems.push(`${route}: no focus indicator on ${stop.what}`);
      if (!stop.named) problems.push(`${route}: no accessible name on ${stop.what}`);
      if (stop.order < last) problems.push(`${route}: focus moves backward to ${stop.what}`);
      last = stop.order;
    }
    if (inMain < expected) problems.push(`${route}: Tab reached ${inMain} of ${expected} controls`);
  }
  expect(problems).toEqual([]);
});

test('a result can be produced, read and copied with the keyboard alone', async ({ page, context }) => {
  await grantClipboard(context);
  await page.goto('./');
  // Search from anywhere, open the best match, and land on its heading.
  await page.keyboard.press('/');
  await expect(page.locator('#tool-search')).toBeFocused();
  await page.keyboard.type('chmod');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'chmod Calculator' })).toBeFocused();
  // Reach the octal field by Tab alone and type a mode.
  for (let i = 0; i < 40 && !(await page.locator('#chmod-octal').evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(page.locator('#chmod-octal')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('750');
  await expect(page.locator('#chmod-ls')).toHaveValue('rwxr-x---');
  // The first copy button after the fields copies the octal mode.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
    if (/^Copy/.test(label)) break;
  }
  await page.keyboard.press('Enter');
  expect(await readClipboard(page)).toMatch(/^0?750$/);
  // The confirmation is announced to assistive technology.
  await expect(page.locator('#live-region')).toContainText(/Copied/i);
});

test('an error is announced where it happens and tied to its field', async ({ page }) => {
  await page.goto('./#/number-bases');
  await page.selectOption('#num-width', '8');
  await page.fill('#num-input', '256');
  const field = page.locator('#num-input');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  const describedBy = (await field.getAttribute('aria-describedby'))!.split(' ');
  expect(describedBy).toContain('num-input-error');
  await expect(page.locator('#num-input-error')).toBeVisible();
  // A status region reports the outcome without moving focus.
  await expect(page.locator('#num-status')).toHaveAttribute('role', 'status');
  await expect(field).toBeFocused();
});

test('Escape and the skip link work without a pointer', async ({ page, browserName }) => {
  // Safari does not move to links with Tab unless a system setting is changed (Option+Tab does).
  test.skip(browserName === 'webkit', 'WebKit skips links on Tab by default');
  await page.goto('./#/json-formatter');
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('h1:visible')).toBeFocused();
  await page.keyboard.press('Control+K');
  await page.keyboard.type('zzzz');
  await expect(page.locator('#search-status')).not.toBeEmpty();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tool-search')).toHaveValue('');
});
