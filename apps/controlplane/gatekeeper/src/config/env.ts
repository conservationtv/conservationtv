import { arkenv } from '@arkenv/standard';
import { z } from 'zod';
import { ConsumerRegistrationsSchema, DeniedEndpointsSchema, isSecureRegistration } from './schemas.ts';

/**
 * The deployment's settings, from its text bindings and secrets: under `nodejs_compat` they are also `process.env`,
 * which ArkEnv reads. The entrypoint loads them on first use, once per isolate; an invalid registration fails every
 * request rather than running with a partial policy.
 */
export function loadConfig() {
  const config = arkenv(
    {
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
    },
    { arrayFormat: 'json' }
  );
  const insecure = config.CONSUMER_REGISTRATIONS.find(registration => !isSecureRegistration(registration));
  if (insecure !== undefined && !config.ALLOW_INSECURE_CONSUMERS) {
    throw new Error(`Consumer registration ${insecure.principal_id} must use HTTPS and a public JWKS host`);
  }
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
