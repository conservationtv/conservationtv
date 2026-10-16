import type { Cache } from './cache.ts';

/** Workers KV keeps a value for at least a minute. */
const MIN_TTL_SECONDS = 60;

/**
 * A cache in a Workers KV namespace. KV is eventually consistent and has no conditional write, so `add` reads, then
 * writes: two concurrent adds of one key, or two within the time a write takes to reach another location (up to a
 * minute), can both succeed. What relies on `add` is best effort here, until an implementation with an atomic one
 * (a Durable Object, say) replaces this. TTLs below KV's minute are raised to it.
 */
export function kvCache(namespace: KVNamespace): Cache {
  const put = (key: string, value: string, ttlSeconds: number) =>
    namespace.put(key, value, { expirationTtl: Math.max(MIN_TTL_SECONDS, Math.ceil(ttlSeconds)) });
  return {
    get: key => namespace.get(key),
    put,
    add: async (key, value, ttlSeconds) => {
      if ((await namespace.get(key)) !== null) return false;
      await put(key, value, ttlSeconds);
      return true;
    }
  };
}
