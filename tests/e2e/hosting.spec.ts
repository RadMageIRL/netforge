import { expect, test, type Page } from '@playwright/test';
import { hostHeadersFor } from '../unit/helpers/host-headers';
import { watchErrors } from './helpers';
import { serveDistCopy } from './static-server';

// The production host's response headers (vercel.json), applied by a local server, so these tests
// see what a browser enforces in production: a policy that reaches workers on the very first
// visit, a service worker that can still fetch its own files, and no framing by other sites.

type Server = Awaited<ReturnType<typeof serveDistCopy>>;

/** A page with no policy of its own that starts a worker; both try to fetch a file of the app. */
function addProbe(server: Server): void {
  server.deploy('__probe.html', () => '<!doctype html><meta charset="utf-8"><title>probe</title><script src="./__probe.js"></script>');
  server.deploy('__probe.js', () => `
    window.__worker = new Promise(resolve => {
      const w = new Worker('./assets/__probe-worker.js');
      w.onmessage = e => resolve(e.data);
      w.onerror = () => resolve('worker failed to start');
      setTimeout(() => resolve('no answer'), 5000);
    });
    window.__page = fetch('./favicon.svg').then(() => 'page fetch allowed', () => 'page fetch blocked');`);
  server.deploy('assets/__probe-worker.js', () => "fetch('../favicon.svg').then(() => postMessage('worker fetch allowed'), () => postMessage('worker fetch blocked'));");
}

async function probe(page: Page, server: Server): Promise<{ worker: string; page: string }> {
  await page.goto(`${server.url}__probe.html`);
  return page.evaluate(async () => {
    const w = window as unknown as { __worker: Promise<string>; __page: Promise<string> };
    return { worker: await w.__worker, page: await w.__page };
  });
}

test('the host headers block connections from a worker and from the page on the first visit, before any service worker', async ({ page }) => {
  const plain = await serveDistCopy();
  const hosted = await serveDistCopy({ hostHeaders: true });
  try {
    addProbe(plain);
    addProbe(hosted);
    // Without the headers the probe connects: this is what the headers are for.
    expect(await probe(page, plain)).toEqual({ worker: 'worker fetch allowed', page: 'page fetch allowed' });
    expect(await probe(page, hosted)).toEqual({ worker: 'worker fetch blocked', page: 'page fetch blocked' });
  } finally {
    await plain.close();
    await hosted.close();
  }
});

test('another site cannot show the app in a frame', async ({ page }) => {
  const plain = await serveDistCopy();
  const hosted = await serveDistCopy({ hostHeaders: true });
  try {
    // The framing page lives on the other server: a different origin from the hosted copy.
    // A refused frame still fires its load event, so the page can tell when both are settled.
    plain.deploy('__frames.html', () => `<!doctype html><meta charset="utf-8"><title>Another site</title><script>window.__settled = [];</script><iframe id="plain" src="${plain.url}" onload="__settled.push('plain')"></iframe><iframe id="hosted" src="${hosted.url}" onload="__settled.push('hosted')"></iframe>`);
    expect(new URL(plain.url).origin).not.toBe(new URL(hosted.url).origin);
    await page.goto(`${plain.url}__frames.html`);
    await page.waitForFunction(() => (window as unknown as { __settled: string[] }).__settled.length === 2);
    // The copy without headers loads in the frame, which shows the test can see a framed app.
    await expect(page.frameLocator('#plain').getByRole('heading', { level: 1, name: 'NetForge' })).toBeVisible();
    // A refused frame is different in every engine (an error page, an empty document, a frame
    // that never answers), so the server's own log is the evidence: the browser asked the hosted
    // copy for the page, was told not to frame it, and never asked for a script or a style sheet.
    expect(plain.requests.some(path => path.startsWith('/assets/'))).toBe(true);
    expect(hosted.requests).toEqual(['/']);
  } finally {
    await plain.close();
    await hosted.close();
  }
});

test('every response carries the configured headers, and a missing asset is a real 404', async ({ page }) => {
  const hosted = await serveDistCopy({ hostHeaders: true });
  try {
    const seen: { path: string; headers: Record<string, string> }[] = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (response.url().startsWith(hosted.url) && !response.fromServiceWorker()) seen.push({ path: url.pathname, headers: response.headers() });
    });
    await page.goto(`${hosted.url}#/hash-hmac`);
    await page.fill('#hash-text', 'abc');
    await expect(page.locator('#hash-list [data-key="SHA-256-hex"] .hash-value')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const paths = seen.map(s => s.path);
    expect(paths).toContain('/');
    expect(paths.some(p => /^\/assets\/.+\.css$/.test(p))).toBe(true);
    expect(paths.some(p => /^\/assets\/.+\.worker-[A-Za-z0-9_-]+\.js$/.test(p))).toBe(true);
    for (const s of seen) {
      const want = hostHeadersFor(s.path);
      expect(Object.keys(want).length, s.path).toBe(10);
      for (const [key, value] of Object.entries(want)) expect([s.path, key, s.headers[key.toLowerCase()]]).toEqual([s.path, key, value]);
      expect(s.headers['content-security-policy'], s.path).toContain(s.path === '/sw.js' ? "connect-src 'self'" : "connect-src 'none'");
      expect(s.headers['cache-control'], s.path).toBe(s.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    const missing = await page.request.get(`${hosted.url}assets/no-such-chunk.js`);
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).not.toContain('html');
    expect(missing.headers()['x-content-type-options']).toBe('nosniff');
  } finally {
    await hosted.close();
  }
});

test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  async function waitForController(page: Page): Promise<void> {
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller;
    }, undefined, { timeout: 20_000 });
  }

  test('under the host headers the app installs, its workers run, and it works offline', async ({ page, context }) => {
    const hosted = await serveDistCopy({ hostHeaders: true });
    try {
      const errors = watchErrors(page);
      await page.goto(hosted.url);
      // The service worker fetches every file of the app under its own policy (connect-src 'self').
      await waitForController(page);
      const cached = await page.evaluate(async () => {
        const name = (await caches.keys()).find(k => k.startsWith('netforge-'))!;
        return (await (await caches.open(name)).keys()).length;
      });
      expect(cached).toBeGreaterThan(30);
      await page.locator('a[data-tool="hash-hmac"]').click();
      await page.fill('#hash-text', 'abc');
      await expect(page.locator('#hash-list [data-key="SHA-256-hex"] .hash-value')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      await page.locator('a[data-tool="yaml-xml-tools"]').click();
      await page.fill('#data-input', 'a: 1\n');
      await expect(page.locator('#data-output')).toHaveValue('a: 1\n');
      expect(errors).toEqual([]);

      await context.setOffline(true);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'YAML/XML Tools' })).toBeVisible();
      await page.locator('a[data-tool="hash-hmac"]').click();
      await page.fill('#hash-text', 'abc');
      await expect(page.locator('#hash-list [data-key="SHA-256-hex"] .hash-value')).toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      await context.setOffline(false);
      await hosted.close();
    }
  });

  test('under the host headers a new version is still found and offered', async ({ page }) => {
    const hosted = await serveDistCopy({ hostHeaders: true });
    try {
      await page.goto(`${hosted.url}#/json-formatter`);
      await waitForController(page);
      await page.fill('#json-input', '{"unsaved":true}');
      hosted.deploy('sw.js', text => text.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-hosted-update'"));
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
      await expect(page.locator('#update-bar')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#json-input')).toHaveValue('{"unsaved":true}');
      await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()]);
      await expect.poll(async () => page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('netforge-')))).toContain('netforge-test-hosted-update');
    } finally {
      await hosted.close();
    }
  });
});
