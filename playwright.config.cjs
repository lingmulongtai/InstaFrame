const { defineConfig } = require('@playwright/test');

const browserTarget = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const crossBrowserSuite = process.env.PLAYWRIGHT_SUITE === 'cross-browser';
const browserUse = browserTarget === 'edge'
  ? { browserName: 'chromium', channel: 'msedge' }
  : { browserName: browserTarget };

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: crossBrowserSuite ? '**/cross-browser.spec.cjs' : '**/instaframe.spec.cjs',
  globalSetup: require.resolve('./tests/e2e/global-setup.cjs'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    acceptDownloads: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: browserTarget,
    use: browserUse,
  }],
});
