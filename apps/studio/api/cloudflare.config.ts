import { bindings, defineConfig, exports } from 'cf/config';
import { z } from 'zod';
import { LOCAL_POOLED_ADMIN_DATABASE_URL, LOCAL_POOLED_APP_DATABASE_URL } from './src/db/local.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// The Worker name, bindings and text bindings for uploaded versions come from the studio Pulumi stack
// (../infrastructure): set STACK_OUTPUT_JSON to its `pulumi stack output --json` when uploading. Local development uses
// the docker-compose PgBouncer through both bindings, as the two Postgres roles umbrella needs, and the environment's
// text bindings over the localhost defaults. The custom domain is applied by that stack.
const StackOutputsSchema = z.object({
  api: z.object({
    workerName: z.string(),
    adminHyperdriveId: z.string(),
    appHyperdriveId: z.string(),
    cacheId: z.string(),
    appUrl: z.url(),
    webOrigins: z.array(z.url()).nonempty(),
    gatekeeperUrl: z.url(),
    twitchClientId: z.string().min(1)
  })
});
type StackOutputs = z.output<typeof StackOutputsSchema>;
const placeholderHyperdriveIds = { admin: '00000000000000000000000000000001', app: '00000000000000000000000000000002' };
const placeholderCacheId = '00000000000000000000000000000003';
const stack: StackOutputs['api'] | undefined = process.env.STACK_OUTPUT_JSON
  ? StackOutputsSchema.parse(JSON.parse(process.env.STACK_OUTPUT_JSON)).api
  : undefined;

/**
 * The secrets gateway hostnames need (src/gateways/certificates.ts), declared only where `GATEWAY_DOMAIN` is set: every
 * declared secret must be uploaded with each version, which releases without the domain don't do (#90), and `cf dev`
 * hands the Worker only the secrets that are declared, from .dev.vars or .dev.vars.<mode>.
 */
const gatewayCertificateSecrets = process.env.GATEWAY_DOMAIN
  ? { CLOUDFLARE_API_TOKEN: bindings.secret(), ACME_ACCOUNT_KEY: bindings.secret() }
  : undefined;

/** Each stack's own Worker: `studio-api` for prod, `studio-api-<stack>` otherwise. */
const workerName = stack?.workerName ?? 'studio-api';

export default defineConfig({
  worker: {
    name: workerName,
    compatibilityDate: '2026-09-25',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    // contracts/ (see vite.config.ts) as static assets, for the operation manifest, the published OpenAPI document and
    // the show's bundle. Every request still goes to the Worker first, so all are served through its CORS policy:
    // browsers fetch them cross-origin, revalidating with If-None-Match, which needs a preflight. No HTML handling: the
    // frame page is served at frames.html, as its sources name it, rather than redirected to a path without the
    // extension.
    assets: { runWorkerFirst: true, htmlHandling: 'none' },
    exports: {
      /** Each organisation's broadcast, composed and followed over WebSockets; see src/shows/host.tsx. */
      ShowHost: exports.durableObject({ storage: 'sqlite' })
    },
    env: {
      /**
       * The static assets: contracts/operations.json and contracts/openapi.json at their names, and the show's bundle
       * under /show/ (src/app.ts).
       */
      ASSETS: bindings.assets(),
      /** The owning role: migrations, Better Auth's tables, and grant management. Never used for request queries. */
      HYPERDRIVE_ADMIN: bindings.hyperdrive({
        id: stack?.adminHyperdriveId ?? placeholderHyperdriveIds.admin,
        dev: { connectionString: LOCAL_POOLED_ADMIN_DATABASE_URL }
      }),
      /** The application role request sessions run as; row-level security applies to everything it does. */
      HYPERDRIVE_APP: bindings.hyperdrive({
        id: stack?.appHyperdriveId ?? placeholderHyperdriveIds.app,
        dev: { connectionString: LOCAL_POOLED_APP_DATABASE_URL }
      }),
      /** The key-value cache (src/cache.ts): device request nonces and report idempotency. Local in development. */
      CACHE: bindings.kv({ id: stack?.cacheId ?? placeholderCacheId }),
      /** Better Auth's signing secret; see .dev.vars.example. */
      BETTER_AUTH_SECRET: bindings.secret(),
      /** The master key for encrypted columns and blind indexes; see .dev.vars.example. */
      FIELD_KEY: bindings.secret(),
      /**
       * Where this API is served: Better Auth's base URL. The environment can override
       * the localhost default, e.g. to serve dev over Tailscale for testing on a phone.
       */
      APP_URL: bindings.text(stack?.appUrl ?? process.env.APP_URL ?? 'http://localhost:6421'),
      /**
       * Comma-separated browser origins allowed to call the API with credentials; the first is the studio web app.
       * Overridable from the environment, as APP_URL is.
       */
      WEB_ORIGINS: bindings.text(stack?.webOrigins.join(',') ?? process.env.WEB_ORIGINS ?? 'http://localhost:6420'),
      /**
       * The control plane that names the relays and admits devices to them: the local controlplane's gatekeeper
       * (apps/controlplane/gatekeeper) unless the environment overrides it, as `pnpm dev:staging` does.
       */
      GATEKEEPER_URL: bindings.text(stack?.gatekeeperUrl ?? process.env.GATEKEEPER_URL ?? 'http://localhost:6422'),
      /** The control plane environment's consumer token; see .dev.vars.example. */
      GATEKEEPER_TOKEN: bindings.secret(),
      /**
       * Optional: the zone MediaMTX gateways get hostnames and certificates in, its Cloudflare zone, and the ACME
       * directory; see .dev.vars.example. Empty text leaves gateways without hostnames. Their secrets,
       * `CLOUDFLARE_API_TOKEN` and `ACME_ACCOUNT_KEY`, are declared only beside it (`gatewayCertificateSecrets`).
       */
      GATEWAY_DOMAIN: bindings.text(process.env.GATEWAY_DOMAIN ?? ''),
      ...gatewayCertificateSecrets,
      /** The Twitch application channels are connected through, and its secret; see .dev.vars.example. */
      TWITCH_CLIENT_ID: bindings.text(stack?.twitchClientId ?? process.env.TWITCH_CLIENT_ID ?? ''),
      TWITCH_CLIENT_SECRET: bindings.secret(),
      CLOUDFLARE_ZONE_ID: bindings.text(process.env.CLOUDFLARE_ZONE_ID ?? ''),
      ACME_DIRECTORY_URL: bindings.text(
        process.env.ACME_DIRECTORY_URL ?? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      ),
      /** How sign-in codes reach people. Only `log` exists; a deployment needs an email provider first. */
      OTP_DELIVERY: bindings.text('log')
    }
  }
});
