import { existsSync, readFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { mockApi } from './api/server.ts';
import { NAMED_SCENARIOS } from './world/scenarios.ts';

// One server for a world: the mock API under /w/, and the studio web app's production build everywhere else, with a
// /config.js that points the app at whichever scenario the `scenario` cookie names. Visiting /__scenario/<id> sets it.
// The capture uses the same cookie, with a tag per page, so the app is the one built and nothing in it changes.

export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/build/client/', import.meta.url));
export const SCENARIO_COOKIE = 'scenario';

export interface Served {
  origin: string;
  close: () => Promise<void>;
}

export function scenarioApp(webRoot: string) {
  const app = new Hono();
  app.route('/', mockApi());

  app.get('/scenarios', c =>
    c.json(
      NAMED_SCENARIOS.map(scenario => ({
        id: scenario.id,
        title: scenario.title,
        description: scenario.description,
        open: `/__scenario/${scenario.id}`
      }))
    )
  );

  app.get('/__scenario/:prefix', c => {
    setCookie(c, SCENARIO_COOKIE, c.req.param('prefix'), { path: '/', sameSite: 'Lax' });
    return c.redirect('/organisations');
  });

  app.get('/config.js', c => {
    const prefix = getCookie(c, SCENARIO_COOKIE) ?? 'typical';
    // The API is this server, at whatever address the page reached it by.
    const config = { apiUrl: `${new URL(c.req.url).origin}/w/${encodeURIComponent(prefix)}` };
    c.header('Cache-Control', 'no-store');
    return c.body(`globalThis.studioConfig = ${JSON.stringify(config)};\n`, 200, {
      'Content-Type': 'text/javascript; charset=utf-8'
    });
  });

  if (existsSync(webRoot)) {
    const fallback = readFileSync(join(webRoot, '__spa-fallback.html'), 'utf8');
    app.use('/*', serveStatic({ root: webRoot }));
    // Every page but the pre-rendered homepage is the SPA fallback, as the studio web Worker serves it.
    app.get('*', c => c.html(fallback));
  } else {
    app.get('*', c => c.text(`No web build at ${webRoot}: run \`pnpm --filter @conservationtv/web build\`.`, 503));
  }
  return app;
}

/** Stop serving. Hung responses (the slow-API scenario's) would hold close open, so their connections are dropped. */
function closeServer(server: ServerType): Promise<void> {
  return new Promise(done => {
    if (server instanceof HttpServer) server.closeAllConnections();
    server.close(() => done());
  });
}

export function startServer(webRoot: string, port: number): Promise<Served> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: scenarioApp(webRoot).fetch, port, hostname: '127.0.0.1' }, () =>
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => closeServer(server) })
    );
    server.on('error', reject);
  });
}
