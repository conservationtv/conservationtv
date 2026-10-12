import { bindings, defineConfig, triggers } from 'cf/config';
import { z } from 'zod';
import { LOCAL_DATABASE_URL } from './src/db/local.ts';
import { consumerRegistrations, deniedIrohEndpoints } from './src/config/registrations.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Bindings for uploaded versions come from the controlplane Pulumi stack: set STACK_OUTPUT_JSON to its
// `pulumi stack output --json` when uploading. Local development uses the docker-compose database. The custom domain
// and cron trigger are applied by that stack; `triggers` here only drives local development.
const StackOutputsSchema = z.object({
  gatekeeper: z.object({ hyperdriveId: z.string() })
});
type StackOutputs = z.output<typeof StackOutputsSchema>;
const placeholderHyperdriveId = '00000000000000000000000000000000';
const stack: StackOutputs['gatekeeper'] | undefined = process.env.STACK_OUTPUT_JSON
  ? StackOutputsSchema.parse(JSON.parse(process.env.STACK_OUTPUT_JSON)).gatekeeper
  : undefined;

export default defineConfig({
  worker: {
    name: 'gatekeeper',
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    env: {
      /** JSON arrays, replaceable per deployment or through .dev.vars. */
      CONSUMER_REGISTRATIONS: bindings.text(JSON.stringify(consumerRegistrations)),
      DENIED_IROH_ENDPOINTS: bindings.text(JSON.stringify(deniedIrohEndpoints)),
      HYPERDRIVE: bindings.hyperdrive({
        id: stack?.hyperdriveId ?? placeholderHyperdriveId,
        dev: { connectionString: LOCAL_DATABASE_URL }
      }),
      /** The control plane's MoQ signing key set; see `pnpm keys:generate`. */
      MOQ_SIGNING_KEYS: bindings.secret(),
      /** Shared with the Iroh relay's `access.http.bearer_token`. */
      IROH_RELAY_TOKEN: bindings.secret(),
      /** Shared with the MoQ relays' auth URL, which they present as HTTP Basic credentials. */
      MOQ_RELAY_TOKEN: bindings.secret(),
      /** Pulumi-generated opaque credential shared by the MoQ peers. */
      MOQ_CLUSTER_TOKEN: bindings.secret(),
      /** The environment-specific ceiling on issued credential lifetimes, in seconds. */
      MAX_CREDENTIAL_LIFETIME_SECONDS: bindings.text('3600')
    }
  }
});
