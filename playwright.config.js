import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3210;
const UNMIN_PORT = PORT + 4;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const UNMIN_URL = `http://127.0.0.1:${UNMIN_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/unminified.spec.js',
      use: { ...devices['Desktop Chrome'], baseURL: BASE_URL },
    },
    {
      name: 'chromium-unminified',
      testMatch: '**/unminified.spec.js',
      use: { ...devices['Desktop Chrome'], baseURL: UNMIN_URL },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/serve.mjs',
      url: `${BASE_URL}/slice-env.json`,
      env: { E2E_PORT: String(PORT) },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node tests/e2e/serve.mjs',
      url: `${UNMIN_URL}/slice-env.json`,
      env: { E2E_PORT: String(UNMIN_PORT), E2E_MINIFY: 'false' },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
