import app from './app.ts';
import { kvCache } from './cache/kv.ts';
import { withCache } from './cache/cache.ts';
import { loadConfig, type Config } from './config.ts';
import { servicesFor } from './services-for.ts';
import { withServices } from './services.ts';

// Loaded on first use and kept for the isolate. A failed load keeps nothing, so every request fails the same way.
let config: Config | undefined = undefined;

export default {
  async fetch(request, env, ctx) {
    if (config === undefined) config = loadConfig();
    const { services, close } = servicesFor(
      config,
      { admin: env.HYPERDRIVE_ADMIN.connectionString, app: env.HYPERDRIVE_APP.connectionString },
      task => ctx.waitUntil(task)
    );
    try {
      const cache = kvCache(env.CACHE);
      return await withServices(services, () => withCache(cache, () => app.fetch(request)));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
