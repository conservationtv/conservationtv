import { bindings, defineConfig, triggers } from 'cf/config';
import { z } from 'zod';
import { LOCAL_DATABASE_URL } from './src/db/local.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// The Worker name and bindings for uploaded versions come from the controlplane Pulumi stack: set STACK_OUTPUT_JSON to
// its `pulumi stack output --json` when uploading. Local development uses the docker-compose database and relays. The custom domain
// and cron trigger are applied by that stack; `triggers` here only drives local development.
const StackOutputsSchema = z.object({
  gatekeeper: z.object({
    workerName: z.string(),
    hyperdriveId: z.string(),
    moqRelayUrl: z.url(),
    irohRelayUrl: z.url()
  })
});
type StackOutputs = z.output<typeof StackOutputsSchema>;
const placeholderHyperdriveId = '00000000000000000000000000000000';
const stack: StackOutputs['gatekeeper'] | undefined = process.env.STACK_OUTPUT_JSON
  ? StackOutputsSchema.parse(JSON.parse(process.env.STACK_OUTPUT_JSON)).gatekeeper
  : undefined;

export default defineConfig({
  worker: {
    /** Each stack's own Worker: `gatekeeper` for prod, `gatekeeper-<stack>` otherwise. */
    name: stack?.workerName ?? 'gatekeeper',
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    env: {
      /** The MoQ relay credentials are for: docker-compose's, whose QUIC listener is :4433, locally. */
      MOQ_RELAY_URL: bindings.text(stack?.moqRelayUrl ?? 'https://localhost:4433/'),
      /** The Iroh relay leases admit endpoints to: docker-compose's, in plain HTTP dev mode, locally. */
      IROH_RELAY_URL: bindings.text(stack?.irohRelayUrl ?? 'http://localhost:3340/'),
      /** Endpoint IDs never admitted to the Iroh relay, as a JSON array; replaceable through .dev.vars. */
      DENIED_IROH_ENDPOINTS: bindings.text('[]'),
      HYPERDRIVE: bindings.hyperdrive({
        id: stack?.hyperdriveId ?? placeholderHyperdriveId,
        dev: { connectionString: LOCAL_DATABASE_URL }
      }),
      /** The environment's consumers, as a JSON array of `{ namespace, token }`; see .dev.vars.example. */
      CONSUMERS: bindings.secret(),
      /** The control plane's MoQ signing key set; see .dev.vars.example. */
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
