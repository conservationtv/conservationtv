import { defineConfig } from 'vitest/config';

// Node tests drive the production Worker bundle in workerd, backed by docker-compose Postgres.
// The database is shared, so files run serially.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/migrate.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 30_000
  }
});
