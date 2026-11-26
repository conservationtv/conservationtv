import { kvCache } from '../cache/kv.ts';
import { r2Media } from '../media/r2.ts';
import type { Tracer } from '../tracing/trace.ts';
import { createEnvironment } from './config.ts';

// The environment from the Worker's own bindings (cloudflare.config.ts), for whatever the runtime invokes: the
// entrypoint's requests (src/index.ts), and each show's object when it syncs (src/shows/host.tsx), which reads the
// database and the show's bundle itself. The only place, beside those two, that touches Workers APIs.

/** What an invocation's runtime gives beside the bindings: its loopback exports, its background, and its tracing. */
export interface WorkerContext {
  readonly exports: Cloudflare.Exports;
  waitUntil(promise: Promise<unknown>): void;
  readonly tracing: Tracer;
}

/**
 * One invocation's environment, and `close` to end its connections. Work handed to its background keeps the
 * invocation alive, and its connections stay open until that work is done too, so a background task (a show's poke,
 * src/shows/pokes.ts) can still use them after the response is sent.
 */
export function workerEnvironment(env: Env, context: WorkerContext) {
  const tasks: Promise<unknown>[] = [];
  const { environment, close } = createEnvironment({
    admin: env.HYPERDRIVE_ADMIN.connectionString,
    app: env.HYPERDRIVE_APP.connectionString,
    cache: kvCache(env.CACHE),
    media: r2Media(env.MEDIA),
    // The Worker's own ShowHost export, through its loopback binding: one object per show, named by its ID. A show made
    // before shows were their own has its organisation's ID, which its object was named by.
    broadcasts: { get: showId => context.exports.ShowHost.getByName(showId) },
    background: task => {
      tasks.push(task);
      context.waitUntil(task);
    },
    assets: env.ASSETS,
    tracing: context.tracing,
    mail: env.MAIL
  });
  const drained = async () => {
    // A task may hand on more; each round waits for what has been handed so far.
    while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
    await close();
  };
  return { environment, close: drained };
}
