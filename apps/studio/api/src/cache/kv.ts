import type { Cache } from './cache.ts';

/** Workers KV keeps a value for at least a minute. */
const MIN_TTL_SECONDS = 60;

/**
 * A cache in a Workers KV namespace. KV is eventually consistent: a write can take up to a minute to reach another
 * location. TTLs below KV's minute are raised to it.
 */
export function kvCache(namespace: KVNamespace): Cache {
  return {
    get: key => namespace.get(key),
    put: (key, value, ttlSeconds) =>
      namespace.put(key, value, { expirationTtl: Math.max(MIN_TTL_SECONDS, Math.ceil(ttlSeconds)) })
  };
}
