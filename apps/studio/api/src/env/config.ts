import { arkenv } from '@arkenv/standard';
import { bearer, Client as GatekeeperClient } from '@conservationtv/controlplane-sdk';
import type { Principal } from '@conservationtv/umbrella';
import { z } from 'zod';
import { authorization } from '../access.ts';
import { createAuth, type Auth } from '../auth/auth.ts';
import { otpDelivery } from '../auth/otp.ts';
import type { Cache } from '../cache/cache.ts';
import { connectLazily } from '../db/client.ts';
import { certificateIssuer, type CertificateIssuer } from '../gateways/certificates.ts';
import type { Background, Clock, Environment } from './env.ts';

// Building the environment loads the database schema, Better Auth and the authorization client. It is kept apart from
// src/env/env.ts, which only declares it, so that anything (encrypted columns included) can use the environment store
// without importing the schema back.

/**
 * The deployment's text bindings and secrets: under `nodejs_compat` they are also `process.env`, which ArkEnv reads.
 */
/** A text binding that may be left empty, which Workers text bindings are rather than unset. */
const optionalText = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(value => (value === '' ? undefined : value), schema.optional());

export const config = {
  /** Where the API is served: Better Auth's base URL and the passkey relying party. */
  APP_URL: z.url(),
  /** Comma-separated. The first is the studio web app, which hosts the device-flow approval page. */
  WEB_ORIGINS: z.array(z.url()).nonempty(),
  /**
   * The control plane that names the relays and admits devices to them: it leases each device's endpoint on its iroh
   * relay (src/gatekeeper/grants.ts) and issues tokens for its MoQ relay (src/gateways/conservationtv.ts), each with
   * that relay's URL.
   */
  GATEKEEPER_URL: z.url(),
  /** The consumer token of the gatekeeper's environment, which trusts whoever holds it with its relays. */
  GATEKEEPER_TOKEN: z.string().min(1),
  /**
   * The zone MediaMTX gateways get hostnames in, `<gateway>.<organisation>.<GATEWAY_DOMAIN>`, with certificates for
   * them; see src/gateways/certificates.ts. Unset (or empty), gateways get neither. Set, the rest of this group is
   * required.
   */
  GATEWAY_DOMAIN: optionalText(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, 'a bare domain name')),
  /** The Cloudflare zone GATEWAY_DOMAIN is served from, and a token that may edit its DNS records. */
  CLOUDFLARE_ZONE_ID: optionalText(z.string().min(1)),
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  /** The ACME directory certificates come from, and the account key, one ES256 JWK with its private `d`. */
  ACME_DIRECTORY_URL: optionalText(z.url()),
  ACME_ACCOUNT_KEY: z.string().min(1).optional(),
  /** Only logging exists; see src/auth/otp.ts. */
  OTP_DELIVERY: z.literal('log'),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** The master key for encrypted columns and blind indexes, as base64; its 32 bytes. See src/db/encrypted.ts. */
  FIELD_KEY: z
    .base64()
    .transform(text => new Uint8Array(Buffer.from(text, 'base64')))
    .refine(key => key.length === 32, 'FIELD_KEY must be 32 bytes of base64')
};

export type Variables = ReturnType<typeof arkenv<typeof config>>;

/** What the Worker binds beside its variables. Resolved by the entrypoint, the only module that touches Workers APIs. */
export interface Bindings {
  /** Where the owning role connects: the `HYPERDRIVE_ADMIN` binding. */
  admin: string;
  /** Where the application role connects: the `HYPERDRIVE_APP` binding. */
  app: string;
  cache: Cache;
  background: Background;
}

export const services = (variables: Variables, bindings: Bindings) => {
  /*
    This is where we initialise all clients that use some configuration from the environment.
    This is useful because we can fail fast, not initialise clients that are not needed and
    ensure we make only one client for each service.

    A Worker cannot share I/O between requests, so this runs once per request, and every client
    that connects opens on first use: requests that never touch storage never open a connection.
  */

  /** Hostnames and certificates for MediaMTX gateways, when GATEWAY_DOMAIN is set. */
  const gatewayCertificates: CertificateIssuer | undefined = certificateIssuer(variables);

  /** The control plane that names the relays and admits devices to them. */
  const gatekeeper = (() => {
    const url = variables.GATEKEEPER_URL;
    const token = variables.GATEKEEPER_TOKEN;
    let client: Promise<GatekeeperClient> | undefined = undefined;
    return {
      /** The deployment's gatekeeper, handshaken; rejects if the handshake fails. */
      client: () => {
        if (client === undefined) client = connectGatekeeper(url, token);
        return client;
      }
    };
  })();

  /** The owning role's connection. Request handlers use `session()` instead. */
  const admin = connectLazily(bindings.admin);
  /** The application role's connection, enforced by row-level security. */
  const app = connectLazily(bindings.app);

  /** The principal's request session over the application connection: every protected query runs inside it. */
  const session = async (principal: Principal) => authorization.as(await app.database(), principal);

  // Better Auth owns its tables, so it is built over the admin connection.
  let pendingAuth: Promise<Auth> | undefined = undefined;
  const auth = () => {
    if (pendingAuth === undefined)
      pendingAuth = admin.database().then(database =>
        createAuth({
          database,
          access: authorization.access(database),
          variables,
          deliverOtp: otpDelivery(variables.OTP_DELIVERY),
          background: bindings.background
        })
      );
    return pendingAuth;
  };

  const clock: Clock = Date.now;

  return {
    clock,
    background: bindings.background,
    admin: admin.database,
    app: app.database,
    session,
    auth,
    cache: bindings.cache,
    gatekeeper,
    gatewayCertificates,
    close: () => Promise.all([admin.close(), app.close()])
  };
};

/** A client for the deployment's gatekeeper, once it has handshaken. */
const connectGatekeeper = async (url: string, token: string) => {
  const client = new GatekeeperClient({ baseUrl: url, auth: bearer(token) });
  await client.handshake();
  return client;
};

// Parsed on first use and kept for the isolate. A failed parse keeps nothing, so every request fails the same way.
let variables: Variables | undefined = undefined;

/** One request's environment, and `close` to end its connections once the response is sent. */
export const createEnvironment = (bindings: Bindings) => {
  if (variables === undefined) variables = arkenv(config);
  const { close, ...clients } = services(variables, bindings);
  const environment: Environment = { variables, ...clients };
  return { environment, close };
};
