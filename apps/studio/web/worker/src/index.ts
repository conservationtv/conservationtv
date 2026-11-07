/**
 * Serves /config.js, the runtime configuration the app's document loads before any of its modules, and the app's shell
 * for every path the static assets don't have. The configuration is a text binding on each version, so it changes only
 * with a release and rolls back with one.
 */
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/config.js') return config(env);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    // A missing script, image or robots.txt is a 404, not a page: only a page load gets the shell.
    if (!isPageLoad(request)) return new Response('Not found', { status: 404 });
    // index.html is the pre-rendered homepage, so any other page starts from the shell, which renders the root's
    // HydrateFallback until the app loads and routes. The assets drop `.html`, redirecting a request that has it.
    return env.ASSETS.fetch(new Request(new URL('/__spa-fallback', url), request));
  }
} satisfies ExportedHandler<Env>;

/** A browser navigating to a page; clients that don't send Sec-Fetch-Mode still ask for HTML. */
function isPageLoad(request: Request): boolean {
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode !== null) return mode === 'navigate';
  return request.headers.get('Accept')?.includes('text/html') ?? false;
}

function config(env: Env): Response {
  // The shape the app parses: StudioConfigSchema in ../../src/lib/config.ts.
  const config = { apiUrl: env.API_URL };
  return new Response(`globalThis.studioConfig = ${JSON.stringify(config)};\n`, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }
  });
}
