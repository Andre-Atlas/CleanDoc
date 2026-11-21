import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:4174', acceptDownloads: true, trace: 'retain-on-failure' },
  webServer: { command: 'npm run build && npx vite preview --port 4174 --strictPort', port: 4174, timeout: 180_000, reuseExistingServer: true },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
