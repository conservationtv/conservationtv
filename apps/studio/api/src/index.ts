import app from './app.ts';
import { kvCache } from './cache/kv.ts';
import { createEnvironment } from './env/config.ts';
import { withEnvironment } from './env/env.ts';
import type { ShowHost } from './shows/host.ts';

/** The broadcasts' objects, one per organisation, named by its ID. */
function broadcastObjects(env: Env) {
  // SAFETY: SHOW_HOST binds this Worker's own ShowHost export (cloudflare.config.ts). The generated `Env` refers to the
  // Worker by name, so it cannot infer the class.
  return env.SHOW_HOST as DurableObjectNamespace<ShowHost>;
}

export default {
  async fetch(request, env, ctx) {
    const { environment, close } = createEnvironment({
      admin: env.HYPERDRIVE_ADMIN.connectionString,
      app: env.HYPERDRIVE_APP.connectionString,
      cache: kvCache(env.CACHE),
      broadcasts: { get: organisationId => broadcastObjects(env).getByName(organisationId) },
      background: task => ctx.waitUntil(task),
      assets: env.ASSETS
    });
    try {
      return await withEnvironment(environment, () => app.fetch(request));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;

// The Durable Object classes the Worker declares (cloudflare.config.ts).
export { ShowHost } from './shows/host.ts';
