import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

// 6421 follows the studio web app's dev server on 6420, off Vite's defaults (apps/studio/web/vite.config.ts says
// why). Vite's own CORS handling is off: it would answer preflights for any localhost origin without
// `Access-Control-Allow-Credentials`, hiding the Worker's CORS policy.
//
// One bundle, no shared chunks: Rolldown otherwise splits zod between two chunks that import each other, one of them
// with Better Auth's core, which then builds its schemas before zod has finished initialising and fails the Worker at
// startup. Dynamic imports are still evaluated lazily, inside the one file.
//
// contracts/ is the Worker's static assets, so the published OpenAPI document ships beside the bundle rather than in
// it, as does the show's bundle (contracts/show/, built by `pnpm bundle:show`). contracts/.assetsignore keeps the
// frozen snapshots beside them out of the upload.
//
// Startup: a cold start parses and evaluates the whole bundle, so it is minified (keeping function and class names, for
// readable stack traces), and three dependencies the Worker never runs are swapped for stubs that throw if called
// (src/stubs/): Kysely and Better Auth's Kysely adapter, which Better Auth imports though it uses the Drizzle adapter
// here, and zod-to-json-schema, with zod's v3 layer behind it. Together they take the bundle from 3.9MB to 1.6MB.
export default defineConfig({
  plugins: [cloudflare()],
  resolve: {
    alias: {
      kysely: fileURLToPath(new URL('src/stubs/kysely.ts', import.meta.url)),
      '@better-auth/kysely-adapter': fileURLToPath(new URL('src/stubs/kysely-adapter.ts', import.meta.url)),
      'zod-to-json-schema': fileURLToPath(new URL('src/stubs/zod-to-json-schema.ts', import.meta.url))
    }
  },
  publicDir: 'contracts',
  server: { port: 6421, cors: false },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: false,
        minify: { compress: { keepNames: { function: true, class: true } }, mangle: { keepNames: true } }
      }
    }
  }
});
