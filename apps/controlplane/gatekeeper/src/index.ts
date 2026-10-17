import app from './app.ts';
import { createEnvironment } from './env/config.ts';
import { withEnvironment } from './env/env.ts';
import { purgeExpiredState } from './maintenance.ts';

export default {
  async fetch(request, env, ctx) {
    const { environment, close } = createEnvironment({ database: env.HYPERDRIVE.connectionString });
    try {
      return await withEnvironment(environment, () => app.fetch(request));
    } finally {
      ctx.waitUntil(close());
    }
  },
  async scheduled(_controller, env, ctx) {
    const { environment, close } = createEnvironment({ database: env.HYPERDRIVE.connectionString });
    try {
      // Find & purge any expired grants in the database
      await withEnvironment(environment, purgeExpiredState);
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
