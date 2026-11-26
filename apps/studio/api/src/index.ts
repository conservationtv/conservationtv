import app from './app.ts';
import { workerEnvironment } from './env/bindings.ts';
import { withEnvironment } from './env/env.ts';

export default {
  async fetch(request, env, ctx) {
    const { environment, close } = workerEnvironment(env, ctx);
    try {
      return await withEnvironment(environment, () => app.fetch(request));
    } finally {
      ctx.waitUntil(close());
    }
  }
} satisfies ExportedHandler<Env>;

// The Durable Object classes the Worker declares (cloudflare.config.ts).
export { ShowHost } from './shows/host.tsx';
