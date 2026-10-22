import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the web engine in real browsers, against the local test
// radio (scripts/stream-server/): the plain-web example (example-web/) and
// the Expo example's web export, which runs the native integration scenarios.
// `yarn test:web` builds both first.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  // The tests share one test radio and drive its fault controls.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4300',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node ../scripts/stream-server/server.mjs 8765',
      url: 'http://localhost:8765/stats',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node ../example-web/serve.mjs 4300',
      url: 'http://localhost:4300/__health',
      reuseExistingServer: !process.env.CI,
    },
    {
      // The React DOM example (example-react, built with Vite).
      command: 'node ../example-web/serve.mjs 4500 example-react/dist',
      url: 'http://localhost:4500/__health',
      reuseExistingServer: !process.env.CI,
    },
    {
      // The Expo example's web export (scripts/build-expo-web.sh).
      command: 'node ../example-web/serve.mjs 4400 example-expo/dist-web',
      url: 'http://localhost:4400/__health',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
