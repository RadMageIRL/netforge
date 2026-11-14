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
    // Other engines (npm run test:engines; needs `npx playwright install firefox webkit` once).
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
