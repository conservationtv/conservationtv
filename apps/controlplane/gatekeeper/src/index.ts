import app from './app.ts';
import { loadConfig, type Config } from './config/env.ts';
import { purgeExpiredState } from './maintenance.ts';
import { servicesFor, withServices } from './services.ts';

// Loaded on first use and kept for the isolate. A failed load keeps nothing, so every request fails the same way.
let config: Config | undefined = undefined;

export default {
  async fetch(request, env, ctx) {
    if (config === undefined) config = loadConfig();
    const { services, close } = servicesFor(config, env.HYPERDRIVE.connectionString);
    try {
      return await withServices(services, () => app.fetch(request));
    } finally {
      ctx.waitUntil(close());
    }
  },
  async scheduled(_controller, env, ctx) {
    if (config === undefined) config = loadConfig();
    const { services, close } = servicesFor(config, env.HYPERDRIVE.connectionString);
    try {
      // Find & purge any expired grants in the database
      await withServices(services, purgeExpiredState);
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
