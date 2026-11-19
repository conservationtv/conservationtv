import { defineConfig } from 'vitest/config';

// Unit tests run in Node, without the Worker: vite.config.ts's Cloudflare plugin is for serving and building only.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] }
});
