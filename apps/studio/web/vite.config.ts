import { resolve } from 'node:path';
import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/bundler-plugins/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * React Compiler, through the native (Rust, `oxc-transform-react`) compiler in `@vitejs/plugin-react`. Only its
 * compiler step is used: React Router's plugin already owns the rest of the React setup, including Fast Refresh, and
 * the compiler leaves refresh to it while the main React plugin is absent. Experimental upstream.
 */
const reactCompiler = react({ compiler: true }).filter(
  plugin => plugin && 'name' in plugin && plugin.name === 'vite:react-compiler'
);

/**
 * Serves /config.js, the app's runtime configuration (src/lib/config.ts), in development, as the studio web Worker
 * (worker/src/index.ts) does deployed. API_URL in the environment overrides the local API, e.g. to serve dev over
 * Tailscale for testing on a phone.
 */
const devConfig: Plugin = {
  name: 'studio-dev-config',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/config.js', (_request, response) => {
      // SENTRY_DSN reports dev to that Sentry project, every trace and no replays; nothing is reported without it.
      const sentry = process.env.SENTRY_DSN
        ? { dsn: process.env.SENTRY_DSN, environment: 'development', tracesSampleRate: 1, replaysOnErrorSampleRate: 0 }
        : undefined;
      const config = { apiUrl: process.env.API_URL ?? 'http://localhost:5175', sentry };
      response.setHeader('content-type', 'text/javascript; charset=utf-8');
      response.setHeader('cache-control', 'no-cache');
      response.end(`globalThis.studioConfig = ${JSON.stringify(config)};\n`);
    });
  }
};

/**
 * With SENTRY_AUTH_TOKEN set (CI sets it with SENTRY_ORG, SENTRY_PROJECT and SENTRY_RELEASE, which the plugin reads),
 * the client build gets hidden source maps, which are uploaded to Sentry with the release and then deleted, so they are
 * never served; the release is injected for the SDK to report. Without a token, as locally, there are no source maps.
 * Only the client build: the server build exists only to pre-render index.html.
 */
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);
const sentry: Plugin[] = uploadSourceMaps
  ? sentryVitePlugin({
      release: { name: process.env.SENTRY_RELEASE },
      sourcemaps: { filesToDeleteAfterUpload: ['./build/client/**/*.map'] },
      telemetry: false
    }).map((plugin): Plugin => ({ ...plugin, applyToEnvironment: environment => environment.name === 'client' }))
  : [];

export default defineConfig({
  plugins: [tailwindcss(), reactCompiler, reactRouter(), devConfig, ...sentry],
  environments: { client: { build: { sourcemap: uploadSourceMaps ? 'hidden' : false } } },
  // Pre-bundle every route's dependencies at startup, including those the shared UI package's components bring in.
  // Discovered lazily instead, the first visit to a route re-bundles mid-session and reloads, and a page holding the
  // old bundle can end up with two copies of React.
  optimizeDeps: { entries: ['src/**/*.tsx', '../../../packages/ui/src/**/*.tsx'] },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src')
    }
  }
});
