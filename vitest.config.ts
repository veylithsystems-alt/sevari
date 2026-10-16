import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
