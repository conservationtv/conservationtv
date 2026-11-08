import app from './app.ts';
import { kvCache } from './cache/kv.ts';
import { createEnvironment } from './env/config.ts';
import { withEnvironment } from './env/env.ts';

export default {
  async fetch(request, env, ctx) {
    const { environment, close } = createEnvironment({
      admin: env.HYPERDRIVE_ADMIN.connectionString,
      app: env.HYPERDRIVE_APP.connectionString,
      cache: kvCache(env.CACHE),
      // The Worker's own ShowHost export, through its loopback binding: one object per organisation, named by its ID.
      broadcasts: { get: organisationId => ctx.exports.ShowHost.getByName(organisationId) },
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
