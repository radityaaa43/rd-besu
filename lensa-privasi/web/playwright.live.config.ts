import { defineConfig } from '@playwright/test';

// Live E2E: drives the REAL server on :8790 (Besu + Paladin). No webServer; start `npm start` first.
// Run one spec at a time: npx playwright test -c playwright.live.config.ts e2e/live/<model>.live.spec.ts
// Paladin-backed models (noto, zeto) must be wrapped in: flock /tmp/lensa-paladin.lock ...
export default defineConfig({
  testDir: 'e2e/live',
  testMatch: '**/*.live.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 10 * 60_000 },
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
