import { bindings, defineConfig, triggers } from 'cf/config';
import { LOCAL_DATABASE_URL } from './src/db/local.ts';
import { consumerRegistrations, deniedIrohEndpoints } from './src/config/registrations.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Deployment settings live in the controlplane Pulumi stack (`pulumi stack output gatekeeper`): set GATEKEEPER_DOMAIN
// and GATEKEEPER_HYPERDRIVE_ID from it when building for deployment. Local development has no custom domain and uses
// the docker-compose database. Hyperdrive query caching should be disabled: lease and revocation reads must be fresh.
const domain = process.env.GATEKEEPER_DOMAIN;
const hyperdriveId = process.env.GATEKEEPER_HYPERDRIVE_ID ?? '00000000000000000000000000000000';

export default defineConfig({
  worker: {
    name: 'gatekeeper',
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    domains: domain ? [domain] : [],
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    env: {
      /** JSON arrays, replaceable per deployment or through .dev.vars. */
      CONSUMER_REGISTRATIONS: bindings.text(JSON.stringify(consumerRegistrations)),
      DENIED_IROH_ENDPOINTS: bindings.text(JSON.stringify(deniedIrohEndpoints)),
      HYPERDRIVE: bindings.hyperdrive({ id: hyperdriveId, dev: { connectionString: LOCAL_DATABASE_URL } }),
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
