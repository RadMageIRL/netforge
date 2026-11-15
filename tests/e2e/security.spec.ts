import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createCatalog } from '../../src/app/catalog';
import { examplePlan } from '../../src/core/plan/example';
import { planToJson } from '../../src/core/plan/file';
import { watchErrors } from './helpers';

// Security regression tests from the Phase 6 review (local/docs/SECURITY_REVIEW.md).

const MARKUP = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script><svg onload="window.__xss=1"><a href="javascript:window.__xss=1">x</a>';

/** Elements that could only exist if text had been parsed as markup, and the flag their handlers set. */
async function injected(page: Page): Promise<{ elements: number; flag: unknown }> {
  return page.evaluate(() => ({
    elements: document.querySelectorAll('img, iframe, object, embed, script:not([src]), a[href^="javascript"], [onerror], [onload], [onclick]').length,
    flag: (window as unknown as { __xss?: unknown }).__xss,
  }));
}

test('text from files and fields is always shown as text, never parsed as markup', async ({ page }) => {
  const errors = watchErrors(page);
  const plan = examplePlan();
  plan.name = MARKUP;
  plan.description = MARKUP;
  plan.sites[0]!.name = `HQ ${MARKUP}`;
  plan.vrfs[0]!.name = `Global ${MARKUP}`;
  plan.namespaces[0]!.name = `Switches ${MARKUP}`;
  for (const v of plan.vlans) { v.name = `${v.name} ${MARKUP}`; v.description = MARKUP; v.notes = MARKUP; }
  plan.vlans[0]!.reserved = [{ range: '10.10.10.2 - 10.10.10.20', label: MARKUP }];
  const file = { name: `${MARKUP}.json`, mimeType: 'application/json', buffer: Buffer.from(planToJson(plan), 'utf8') };

  await page.goto('./#/network-planner');
  await page.setInputFiles('#plan-file', file);
  await expect(page.locator('#plan-messages')).toContainText('Opened');
  for (const tab of ['Sites, VRFs and namespaces', 'Allocate', 'Address map', 'Issues', 'VLANs']) {
    await page.getByRole('tab', { name: tab }).click();
    expect(await injected(page)).toEqual({ elements: 0, flag: undefined });
  }
  for (const [tool, prefix] of [['powershell-generator', 'ps'], ['terraform-export', 'tf'], ['network-config-export', 'nc']] as const) {
    await page.goto(`./#/${tool}`);
    await page.setInputFiles(`#${prefix}-plan-file`, file);
    await expect(page.locator(`#${prefix}-plan-summary`)).toContainText('<img src=x');
    await expect(page.locator(`#${prefix}-account`)).toContainText('VLAN 10');
    expect(await injected(page)).toEqual({ elements: 0, flag: undefined });
  }
  await page.setInputFiles('#nc-plan-file', { name: `${MARKUP}.json`, mimeType: 'application/json', buffer: Buffer.from(`{"format":"${MARKUP.replace(/"/g, "'")}"}`) });
  await expect(page.locator('#nc-plan-messages')).toContainText('was not opened');

  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  await page.goto('./#/jwt-decoder');
  await page.fill('#jwt-input', `${b64({ alg: 'HS256', kid: MARKUP, typ: MARKUP })}.${b64({ sub: MARKUP, iss: MARKUP, aud: [MARKUP], [MARKUP]: MARKUP })}.${'A'.repeat(43)}`);
  await expect(page.locator('main')).toContainText('<img src=x');
  expect(await injected(page)).toEqual({ elements: 0, flag: undefined });

  await page.goto('./#/regex-tester');
  await page.fill('#regex-text', `${MARKUP}\n${MARKUP}`);
  await page.fill('#regex-pattern', '<(?<tag>[a-z]+)[^>]*>');
  await expect(page.locator('#regex-status')).toContainText('match');
  expect(await injected(page)).toEqual({ elements: 0, flag: undefined });

  await page.goto('./#/yaml-xml-tools');
  await page.selectOption('#data-operation', 'xml-json');
  await page.fill('#data-input', `<a title="${MARKUP.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"><![CDATA[${MARKUP}]]></a>`);
  await expect(page.locator('#data-output')).toHaveValue(/onerror/);
  await page.fill('#data-input', MARKUP);
  await expect(page.locator('#data-errors')).toBeVisible();
  expect(await injected(page)).toEqual({ elements: 0, flag: undefined });

  await page.goto('./#/json-formatter');
  await page.fill('#json-input', `{"${MARKUP.replace(/"/g, '\\"')}": 1, "a": }`);
  expect(await injected(page)).toEqual({ elements: 0, flag: undefined });
  expect(errors).toEqual([]);
});

test('hostile routes show the not-found page as text and throw nothing', async ({ page }) => {
  const errors = watchErrors(page);
  const proto = ['__proto', '__'].join('');
  for (const hash of ['#/%', '#/%E0%A4%A', `#/${proto}`, '#/constructor', `#/${encodeURIComponent(MARKUP)}`, '#/javascript:alert(1)', `#/${'a'.repeat(20_000)}`, '#/%00', '#/../../x']) {
    await page.goto(`./${hash}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(await injected(page)).toEqual({ elements: 0, flag: undefined });
  }
  await page.goto('./#/subnet-calculator');
  await expect(page.getByRole('heading', { level: 1, name: 'Subnet Calculator' })).toBeVisible();
  const stored = await page.evaluate(() => Object.entries({ ...localStorage }));
  expect(stored).toEqual([['netforge.lastTool', 'subnet-calculator']]);
  expect(errors).toEqual([]);
});

test('visiting every tool writes one preference and nothing else to any storage', async ({ page }) => {
  const errors = watchErrors(page);
  const tools = createCatalog().list();
  for (const tool of tools) {
    await page.goto(`./#/${tool.id}`);
    await expect(page.getByRole('heading', { level: 1, name: tool.name })).toBeVisible();
  }
  const state = await page.evaluate(async () => ({
    local: Object.keys(localStorage).sort(),
    session: Object.keys(sessionStorage),
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
  expect(state).toEqual({ local: ['netforge.lastTool'], session: [], cookie: '', databases: 0, caches: 0 });
  expect(errors).toEqual([]);
});

test('the built page carries the policy as its first head element after the charset, and no inline code', async ({ page }) => {
  await page.goto('./');
  const head = await page.evaluate(() => ({
    order: [...document.head.children].slice(0, 2).map(e => `${e.tagName}:${e.getAttribute('charset') ?? e.getAttribute('http-equiv') ?? ''}`),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    inlineScripts: [...document.scripts].filter(s => !s.src).length,
    inlineStyles: document.querySelectorAll('style').length,
    remote: [...document.querySelectorAll('[src], link[href]')].map(e => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href).filter(u => new URL(u).origin !== location.origin),
    referrer: document.querySelector('meta[name="referrer"]')?.getAttribute('content'),
  }));
  expect(head.order).toEqual(['META:utf-8', 'META:Content-Security-Policy']);
  for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) expect(head.csp).toContain(d);
  expect(head.csp).not.toMatch(/unsafe|\*|data:|blob:|https?:/);
  expect([head.inlineScripts, head.inlineStyles, head.remote]).toEqual([0, 0, []]);
  expect(head.referrer).toBe('no-referrer');
});

// The next two tests are measurements for the review. They assert only that the probe ran, and
// attach what they saw, so they stay green in every browser while recording browser differences.

test('probe: does the page policy (a meta element) reach a worker loaded from a file?', async ({ page, baseURL }, testInfo) => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(import.meta.dirname, '..', '..', 'dist', 'index.html'), 'utf8'))![1]!;
  const origin = new URL(baseURL!).origin;
  await page.route(`${origin}/__probe.html`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>probe</title><script src="./__probe.js"></script>` }));
  await page.route(`${origin}/__probe.js`, route => route.fulfill({ contentType: 'text/javascript', body: `
    window.__probe = new Promise(resolve => {
      const w = new Worker('./__probe-worker.js');
      w.onmessage = e => resolve(e.data);
      w.onerror = () => resolve('worker failed to start');
      setTimeout(() => resolve('no answer'), 4000);
    });
    window.__page = fetch('./favicon.svg').then(() => 'page fetch allowed', () => 'page fetch blocked');` }));
  await page.route(`${origin}/__probe-worker.js`, route => route.fulfill({ contentType: 'text/javascript', body: `fetch('./favicon.svg').then(() => postMessage('worker fetch allowed'), () => postMessage('worker fetch blocked'));` }));
  await page.goto(`${origin}/__probe.html`);
  const result = await page.evaluate(async () => ({ worker: await (window as unknown as { __probe: Promise<string> }).__probe, page: await (window as unknown as { __page: Promise<string> }).__page }));
  testInfo.annotations.push({ type: 'worker-csp', description: `${testInfo.project.name}: ${JSON.stringify(result)}` });
  console.log(`[security probe] ${testInfo.project.name} worker-csp ${JSON.stringify(result)}`);
  expect(result.page).toBe('page fetch blocked');
  expect(['worker fetch allowed', 'worker fetch blocked']).toContain(result.worker);
});

test('probe: would require-trusted-types-for break the app as built?', async ({ page, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const violations: string[] = [];
  page.on('console', m => { if (/TrustedScriptURL|TrustedHTML|TrustedScript|Trusted Type/i.test(m.text())) violations.push(m.text().slice(0, 160)); });
  page.on('pageerror', e => { violations.push(`pageerror: ${e.message.slice(0, 160)}`); });
  await page.route(url => url.origin === origin && (url.pathname === '/' || url.pathname === '/index.html'), async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "require-trusted-types-for 'script'; trusted-types 'none'" } });
  });
  await page.goto(`${origin}/#/regex-tester`);
  await page.getByRole('button', { name: 'Example' }).click();
  await page.waitForTimeout(1500);
  const regex = (await page.locator('#regex-status').textContent()) ?? '';
  await page.goto(`${origin}/#/hash-hmac`);
  await page.fill('#hash-text', 'abc');
  await page.waitForTimeout(1000);
  const hashed = await page.locator('#hash-list').count();
  await page.goto(`${origin}/#/terraform-export`);
  await page.locator('#tf-example').click();
  const exported = await page.locator('#tf-code-0').count();
  const result = { regexWorked: /match/.test(regex), hashWorked: hashed > 0, exportWorked: exported > 0, violations: [...new Set(violations)].slice(0, 6) };
  testInfo.annotations.push({ type: 'trusted-types', description: `${testInfo.project.name}: ${JSON.stringify(result)}` });
  console.log(`[security probe] ${testInfo.project.name} trusted-types ${JSON.stringify(result)}`);
  expect(result.exportWorked).toBe(true);
});
