import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// 6421 follows the studio web app's dev server on 6420, off Vite's defaults (apps/studio/web/vite.config.ts says
// why). Vite's own CORS handling is off: it would answer preflights for any localhost origin without
// `Access-Control-Allow-Credentials`, hiding the Worker's CORS policy.
//
// One bundle, no shared chunks: Rolldown otherwise splits zod between two chunks that import each other, one of them
// with Better Auth's core, which then builds its schemas before zod has finished initialising and fails the Worker at
// startup. Dynamic imports are still evaluated lazily, inside the one file.
export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 6421, cors: false },
  build: { rolldownOptions: { output: { codeSplitting: false } } }
});
