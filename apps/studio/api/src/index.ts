import app from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { fieldKeyFrom, withFieldKey, type FieldKey } from './db/field-key.ts';
import { servicesFor, withServices } from './services.ts';

// Loaded on first use and kept for the isolate. A failed load keeps nothing, so every request fails the same way.
let config: Config | undefined = undefined;
let fieldKey: FieldKey | undefined = undefined;

export default {
  async fetch(request, env, ctx) {
    if (config === undefined) config = loadConfig();
    if (fieldKey === undefined) fieldKey = fieldKeyFrom(config);
    const { services, close } = servicesFor(
      config,
      { admin: env.HYPERDRIVE_ADMIN.connectionString, app: env.HYPERDRIVE_APP.connectionString },
      task => ctx.waitUntil(task)
    );
    try {
      return await withServices(services, () => withFieldKey(fieldKey!, () => app.fetch(request)));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
