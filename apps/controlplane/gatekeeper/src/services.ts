import { AsyncLocalStorage } from 'node:async_hooks';
import type { PolicyConfig } from './config/schemas.ts';
import type { Database } from './db/client.ts';
import type { JwksCache } from './grants/jwks.ts';
import type { MoqKeyring } from './moq/keys.ts';

/** Milliseconds since the epoch. Injected so expiry decisions can be exercised deterministically. */
export type Clock = () => number;

/**
 * Everything request handling depends on. The worker entrypoint builds one per request. Code
 * reads the active set through `services()` rather than threading it through every call.
 */
export interface Services {
  policy: PolicyConfig;
  /** Connects on first use, so requests that never touch storage never open a connection. */
  database(): Promise<Database>;
  /** Used only for consumer JWKS retrieval. */
  fetch: typeof fetch;
  clock: Clock;
  jwks: JwksCache;
  moqKeys(): Promise<MoqKeyring>;
  irohRelayToken: string;
  moqRelayToken: string;
  moqClusterToken: string;
}

const storage = new AsyncLocalStorage<Services>();

export function runWithServices<Result>(active: Services, task: () => Result): Result {
  return storage.run(active, task);
}

export function services(): Services {
  const active = storage.getStore();
  if (!active) throw new Error('services() called outside runWithServices()');
  return active;
}
