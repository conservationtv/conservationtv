import { defineConfig } from 'vitest/config';

// Each file starts isolated Postgres and relay containers (Docker required), and forwards HTTP requests
// to the production gatekeeper Worker bundle running in workerd.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000
  }
});
