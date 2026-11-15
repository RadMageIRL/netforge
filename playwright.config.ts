import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (`npm run build` first) served by `vite preview`, using the
// locally installed Chrome so no browser download is needed. The port is NetForge's own, and an
// existing server is never reused, so these tests cannot silently run against another app.
const PORT = 4317;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    acceptDownloads: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, testMatch: /mobile\.spec\.ts/ },
    // Microsoft Edge, as installed on the machine.
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge', viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    // Other engines (npm run test:engines). Their Playwright builds are kept in a folder of this
    // project so no other project's browsers are touched: set PLAYWRIGHT_BROWSERS_PATH to
    // local/tools/pw-browsers for both `npx playwright install firefox webkit` and the test run.
    // The accessibility scans run in the Chromium engines only: the scanner crashes the content
    // process of Playwright's Firefox build on some pages, and the rules do not depend on the engine.
    {
      name: 'firefox', testIgnore: /(mobile|a11y)\.spec\.ts/,
      use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 900 }, launchOptions: { firefoxUserPrefs: { 'dom.events.asyncClipboard.readText': true, 'dom.events.testing.asyncClipboard': true } } },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 900 } }, testIgnore: /(mobile|a11y)\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
