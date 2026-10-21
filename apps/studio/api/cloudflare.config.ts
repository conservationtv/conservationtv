import { bindings, defineConfig } from 'cf/config';
import { LOCAL_ADMIN_DATABASE_URL, LOCAL_APP_DATABASE_URL } from './src/db/local.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Not deployed yet: the Hyperdrive IDs are placeholders until a stack owns the Worker and its database. Local
// development uses the docker-compose database through both bindings, as the two Postgres roles umbrella needs.
const placeholderHyperdriveIds = { admin: '00000000000000000000000000000001', app: '00000000000000000000000000000002' };
const placeholderCacheId = '00000000000000000000000000000003';

export default defineConfig({
  worker: {
    name: 'studio-api',
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    env: {
      /** The owning role: migrations, Better Auth's tables, and grant management. Never used for request queries. */
      HYPERDRIVE_ADMIN: bindings.hyperdrive({
        id: placeholderHyperdriveIds.admin,
        dev: { connectionString: LOCAL_ADMIN_DATABASE_URL }
      }),
      /** The application role request sessions run as; row-level security applies to everything it does. */
      HYPERDRIVE_APP: bindings.hyperdrive({
        id: placeholderHyperdriveIds.app,
        dev: { connectionString: LOCAL_APP_DATABASE_URL }
      }),
      /** The key-value cache (src/cache.ts): device request nonces and report idempotency. Local in development. */
      CACHE: bindings.kv({ id: placeholderCacheId }),
      /** Better Auth's signing secret; see .dev.vars.example. */
      BETTER_AUTH_SECRET: bindings.secret(),
      /** The master key for encrypted columns and blind indexes; see .dev.vars.example. */
      FIELD_KEY: bindings.secret(),
      /**
       * Where this API is served: Better Auth's base URL and the passkey relying party. The environment can override
       * the localhost default, e.g. to serve dev over Tailscale for testing on a phone.
       */
      APP_URL: bindings.text(process.env.APP_URL ?? 'http://localhost:5175'),
      /**
       * Comma-separated browser origins allowed to call the API with credentials; the first is the studio web app.
       * Overridable from the environment, as APP_URL is.
       */
      WEB_ORIGINS: bindings.text(process.env.WEB_ORIGINS ?? 'http://localhost:5173'),
      /**
       * The iroh relay every device's session uses: until there is one per organisation, n0's public relay in Europe.
       * Overridable from the environment, as APP_URL is.
       */
      IROH_RELAY_URL: bindings.text(process.env.IROH_RELAY_URL ?? 'https://euc1-1.relay.n0.iroh.link./'),
      /**
       * The control plane that leases devices' endpoints on a relay that requires it, as the controlplane's does. Set
       * from the environment, with GATEKEEPER_TOKEN; unset, as for n0's relay, sessions carry no lease.
       */
      ...(process.env.GATEKEEPER_URL ? { GATEKEEPER_URL: bindings.text(process.env.GATEKEEPER_URL) } : {}),
      /** The MoQ relay devices delivering their own exposures publish to, with tokens from the same control plane. */
      ...(process.env.MOQ_RELAY_URL ? { MOQ_RELAY_URL: bindings.text(process.env.MOQ_RELAY_URL) } : {}),
      /** The control plane environment's consumer token; see .dev.vars.example. */
      GATEKEEPER_TOKEN: bindings.secret(),
      /** How sign-in codes reach people. Only `log` exists; a deployment needs an email provider first. */
      OTP_DELIVERY: bindings.text('log')
    }
  }
});
