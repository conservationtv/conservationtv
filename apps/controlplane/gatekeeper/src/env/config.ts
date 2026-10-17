import { arkenv } from '@arkenv/standard';
import { z } from 'zod';
import {
  ConsumerRegistrationsSchema,
  DeniedEndpointsSchema,
  isSecureRegistration,
  type PolicyConfig
} from '../config/schemas.ts';
import { connectLazily } from '../db/client.ts';
import { loadMoqKeyring, type MoqKeyring } from '../moq/keys.ts';
import type { Clock, Environment } from './env.ts';

const CLOCK_SKEW_SECONDS = 30;

/**
 * The deployment's text bindings and secrets: under `nodejs_compat` they are also `process.env`, which ArkEnv reads.
 */
export const config = {
  /** JSON arrays, replaceable per deployment or through .dev.vars. */
  CONSUMER_REGISTRATIONS: ConsumerRegistrationsSchema,
  /** Local development only: admit registrations on plain HTTP and local names; see `isSecureRegistration`. */
  ALLOW_INSECURE_CONSUMERS: z.stringbool().default(false),
  DENIED_IROH_ENDPOINTS: DeniedEndpointsSchema,
  /** The environment-specific ceiling on issued credential lifetimes, in seconds. */
  MAX_CREDENTIAL_LIFETIME_SECONDS: z.int().min(1).max(86_400),
  /** The control plane's MoQ signing key set; see `pnpm keys:generate`. */
  MOQ_SIGNING_KEYS: z.string(),
  /** Relay credentials. Empty ones match nothing, so that relay is refused. */
  IROH_RELAY_TOKEN: z.string(),
  MOQ_RELAY_TOKEN: z.string(),
  MOQ_CLUSTER_TOKEN: z.string()
};

const parse = () => arkenv(config, { arrayFormat: 'json' });

export type Variables = ReturnType<typeof parse>;

/** What the Worker binds beside its variables. Resolved by the entrypoint, the only module that touches Workers APIs. */
export interface Bindings {
  /** Where gatekeeper's Postgres role connects: the `HYPERDRIVE` binding. */
  database: string;
}

// Isolate-wide state: the imported signing keys outlive individual requests.
let moqKeyring: Promise<MoqKeyring> | undefined = undefined;

export const services = (variables: Variables, bindings: Bindings) => {
  /*
    This is where we initialise all clients that use some configuration from the environment.
    This is useful because we can fail fast, not initialise clients that are not needed and
    ensure we make only one client for each service.

    A Worker cannot share I/O between requests, so this runs once per request (or scheduled run),
    and the database connects on first use: requests that never touch storage never open a connection.
  */

  // An insecure registration fails every request rather than running with a partial policy.
  const insecure = variables.CONSUMER_REGISTRATIONS.find(registration => !isSecureRegistration(registration));
  if (insecure !== undefined && !variables.ALLOW_INSECURE_CONSUMERS) {
    throw new Error(`Consumer registration ${insecure.principal_id} must use HTTPS and a public JWKS host`);
  }

  const policy: PolicyConfig = {
    consumers: variables.CONSUMER_REGISTRATIONS,
    deniedIrohEndpoints: variables.DENIED_IROH_ENDPOINTS,
    maxCredentialLifetimeSeconds: variables.MAX_CREDENTIAL_LIFETIME_SECONDS,
    clockSkewSeconds: CLOCK_SKEW_SECONDS
  };

  // Required clients
  const connection = connectLazily(bindings.database);

  const moqKeys = () => {
    if (moqKeyring === undefined) moqKeyring = loadMoqKeyring(variables.MOQ_SIGNING_KEYS);
    return moqKeyring;
  };

  const clock: Clock = Date.now;

  /** Used only for consumer JWKS retrieval. */
  const fetcher: typeof fetch = (input, init) => fetch(input, init);

  return {
    policy,
    database: connection.database,
    fetch: fetcher,
    clock,
    moqKeys,
    close: connection.close
  };
};

// Parsed on first use and kept for the isolate. A failed parse keeps nothing, so every request fails the same way.
let variables: Variables | undefined = undefined;

/** One request's (or scheduled run's) environment, and `close` to end its connection once the work is done. */
export const createEnvironment = (bindings: Bindings) => {
  if (variables === undefined) variables = parse();
  const { close, ...clients } = services(variables, bindings);
  const environment: Environment = { variables, ...clients };
  return { environment, close };
};
