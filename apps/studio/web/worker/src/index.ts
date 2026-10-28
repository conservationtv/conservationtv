/**
 * Serves /config.js, the runtime configuration the app's document loads before any of its modules; the static assets
 * answer everything else. The configuration is a text binding on each version, so it changes only with a release and
 * rolls back with one.
 */
export default {
  fetch(_request, env) {
    // The shape the app parses: StudioConfigSchema in ../../src/lib/config.ts.
    const config = { apiUrl: env.API_URL };
    return new Response(`globalThis.studioConfig = ${JSON.stringify(config)};\n`, {
      headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }
    });
  }
} satisfies ExportedHandler<Env>;
