import { defineConfig } from '@playwright/test';

// Mocked smoke: the real HTTP API and the built web over fake adapters (no chain). Port 8791; 8790 is the real server.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8791', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run build && PORT=8791 npx tsx ../server/src/mock-main.ts',
    url: 'http://127.0.0.1:8791/api/meta',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
