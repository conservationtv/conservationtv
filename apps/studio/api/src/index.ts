import app from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { keyringFrom, withKeyring, type Keyring } from './db/keyring.ts';
import { servicesFor, withServices } from './services.ts';

// Loaded on first use and kept for the isolate. A failed load keeps nothing, so every request fails the same way.
let config: Config | undefined = undefined;
let keyring: Keyring | undefined = undefined;

export default {
  async fetch(request, env, ctx) {
    if (config === undefined) config = loadConfig();
    if (keyring === undefined) keyring = keyringFrom(config);
    const { services, close } = servicesFor(
      config,
      { admin: env.HYPERDRIVE_ADMIN.connectionString, app: env.HYPERDRIVE_APP.connectionString },
      task => ctx.waitUntil(task)
    );
    try {
      return await withServices(services, () => withKeyring(keyring!, () => app.fetch(request)));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
