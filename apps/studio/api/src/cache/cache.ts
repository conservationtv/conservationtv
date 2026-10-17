/**
 * A key-value cache shared between requests and isolates, for short-lived values: every value expires, and a cache may
 * drop one earlier. The entrypoint binds one per request; code reads it with `useEnvironment().cache`. Implementations differ in consistency, so each documents what `add` guarantees.
 */
export interface Cache {
  /** The value under `key`, or null if there is none or it has expired. */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key` for `ttlSeconds`, replacing any value already there. */
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Store `value` under `key` for `ttlSeconds` only if nothing is there yet; whether it was stored. */
  add(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}
