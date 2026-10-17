import { createStore } from '@conservationtv/store';
import type { Config } from './config/env.ts';
import type { PolicyConfig } from './config/schemas.ts';
import { connectLazily, type Database } from './db/client.ts';
import { loadMoqKeyring, type MoqKeyring } from './moq/keys.ts';

const CLOCK_SKEW_SECONDS = 30;

/** Milliseconds since the epoch. Injected so expiry decisions can be exercised deterministically. */
export type Clock = () => number;

/**
 * Everything request handling depends on. The worker entrypoint builds one per request. Code
 * reads the active set through `useServices()` rather than threading it through every call.
 */
export interface Services {
  policy: PolicyConfig;
  /** Connects on first use, so requests that never touch storage never open a connection. */
  database(): Promise<Database>;
  /** Used only for consumer JWKS retrieval. */
  fetch: typeof fetch;
  clock: Clock;
  moqKeys(): Promise<MoqKeyring>;
  irohRelayToken: string;
  moqRelayToken: string;
  moqClusterToken: string;
}

const ServicesStore = createStore<Services>('services');
export const [withServices, useServices] = ServicesStore;

// Isolate-wide state: the imported signing keys outlive individual requests.
let moqKeyring: Promise<MoqKeyring> | undefined = undefined;

/** One request's (or scheduled run's) services, and `close` to end its connection once the work is done. */
export function servicesFor(config: Config, connectionString: string) {
  const connection = connectLazily(connectionString);
  const services: Services = {
    policy: {
      consumers: config.CONSUMER_REGISTRATIONS,
      deniedIrohEndpoints: config.DENIED_IROH_ENDPOINTS,
      maxCredentialLifetimeSeconds: config.MAX_CREDENTIAL_LIFETIME_SECONDS,
      clockSkewSeconds: CLOCK_SKEW_SECONDS
    },
    database: connection.database,
    fetch: (input, init) => fetch(input, init),
    clock: Date.now,
    moqKeys: () => {
      if (moqKeyring === undefined) moqKeyring = loadMoqKeyring(config.MOQ_SIGNING_KEYS);
      return moqKeyring;
    },
    irohRelayToken: config.IROH_RELAY_TOKEN,
    moqRelayToken: config.MOQ_RELAY_TOKEN,
    moqClusterToken: config.MOQ_CLUSTER_TOKEN
  };
  return { services, close: connection.close };
}
