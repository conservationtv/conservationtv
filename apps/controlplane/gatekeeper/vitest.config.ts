import { defineConfig } from 'vitest/config';

// Node tests drive the production Worker bundle in workerd, backed by a Postgres container the global setup starts
// (test/support/database.ts), so they need Docker. The database is shared, so files run serially.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/database.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 30_000
  }
});
