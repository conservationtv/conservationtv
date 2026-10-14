import { arkenv } from '@arkenv/standard';
import { z } from 'zod';
import { ConsumerRegistrationsSchema, DeniedEndpointsSchema } from './schemas.ts';

/**
 * The deployment's settings, from its text bindings and secrets: under `nodejs_compat` they are also `process.env`,
 * which ArkEnv reads. The entrypoint loads them on first use, once per isolate; an invalid registration fails every
 * request rather than running with a partial policy.
 */
export const loadConfig = () =>
  arkenv(
    {
      /** JSON arrays, replaceable per deployment or through .dev.vars. */
      CONSUMER_REGISTRATIONS: ConsumerRegistrationsSchema,
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

export type Config = ReturnType<typeof loadConfig>;
