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
      background: task => ctx.waitUntil(task)
    });
    try {
      return await withEnvironment(environment, () => app.fetch(request));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;
