import { defineConfig } from 'vitest/config';

/**
 * Unit + integration tests run in Node. The webview UI has its own Playwright
 * harness (`npm run test:e2e`) because it needs a real browser.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 150_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
