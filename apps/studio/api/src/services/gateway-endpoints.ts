import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { selectLocalGateway } from '../configuration/plan/helpers.ts';
import { agents, gatewayEndpoints, gateways } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { MEDIAMTX_PROTOCOLS, MEDIAMTX_SCHEMES } from '../gateways/mediamtx-protocols.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';

// Where a MediaMTX gateway's servers are reached (src/db/schemas/gateway-endpoints.ts), registered by the agent running
// it from what its MediaMTX actually listens on, so `connect` hands out URLs that work rather than ones an administrator
// guessed. The agent registers them signed, replacing its set whole, and renews them while it runs; each registration
// holds for `ENDPOINT_LEASE_MS`, so a dead agent's stop counting soon after it does. Only the active agent on the
// gateway's network may register for it, and only its count: one that has been replaced is ignored, even before its
// lease runs out. Storing them is trusted code, as for device addresses; members read them in the request session.

/** How long a registration holds unless it is renewed. Agents renew theirs well within it. */
export const ENDPOINT_LEASE_MS = 2 * 60_000;

/** One of the gateway's protocols, and where its server is reached. */
export const RegisteredEndpointSchema = z
  .strictObject({
    protocol: z.enum(MEDIAMTX_PROTOCOLS).describe('The protocol its server speaks.'),
    url: z
      .url()
      .describe(
        "The server's base URL, as a reader on the gateway's network reaches it: `rtsps://<host>:8322`, say. Paths go under it."
      )
  })
  .refine(
    endpoint => {
      const schemes: readonly string[] = MEDIAMTX_SCHEMES[endpoint.protocol];
      const url = new URL(endpoint.url);
      return schemes.includes(url.protocol);
    },
    {
      message: "The URL's scheme must be the protocol's",
      path: ['url']
    }
  );
export type RegisteredEndpoint = z.output<typeof RegisteredEndpointSchema>;

/** Every endpoint of the gateway the device runs, replacing whatever it registered before. */
export const RegisteredEndpointsSchema = z.strictObject({
  gatewayId: z.uuid().describe('The MediaMTX gateway the device runs, as its configuration names it.'),
  endpoints: z
    .array(RegisteredEndpointSchema)
    .max(MEDIAMTX_PROTOCOLS.length)
    .refine(endpoints => new Set(endpoints.map(endpoint => endpoint.protocol)).size === endpoints.length, {
      message: 'Each protocol may appear once'
    })
    .describe(
      'One per protocol its MediaMTX serves, in no order. Empty to withdraw them, as an agent does on stopping.'
    )
});
export type RegisteredEndpoints = z.output<typeof RegisteredEndpointsSchema>;

/**
 * Replace what the device registered with what it registers now, for `ENDPOINT_LEASE_MS`: trusted code, since the
 * device's signature authenticates it. Anything it registered before goes, for whichever gateway, and so does what
 * another device registered for this one. Refuses, as `conflict`, endpoints for a gateway the device does not run.
 * Withdrawing, with none, is always accepted. Returns what is stored.
 */
export async function replaceGatewayEndpoints(device: AuthenticatedDevice, registration: RegisteredEndpoints) {
  const db = useDB({ trusted: true });
  await db.delete(gatewayEndpoints).where(eq(gatewayEndpoints.deviceId, device.id));
  if (registration.endpoints.length === 0) return [];
  const gatewayId = await selectLocalGateway(device);
  if (gatewayId !== registration.gatewayId) {
    throw new ApiFailure('conflict', { cause: 'The device is not the active agent running this gateway' });
  }
  await db.delete(gatewayEndpoints).where(eq(gatewayEndpoints.gatewayId, gatewayId));
  const environment = useEnvironment();
  const registeredAt = new Date(environment.clock());
  const expiresAt = new Date(registeredAt.getTime() + ENDPOINT_LEASE_MS);
  const rows = registration.endpoints.map(endpoint => ({
    organisationId: device.organisationId,
    gatewayId,
    deviceId: device.id,
    ...endpoint,
    registeredAt,
    expiresAt
  }));
  return db.insert(gatewayEndpoints).values(rows).returning({
    protocol: gatewayEndpoints.protocol,
    url: gatewayEndpoints.url,
    registeredAt: gatewayEndpoints.registeredAt,
    expiresAt: gatewayEndpoints.expiresAt
  });
}

/** The gateway's endpoints that count: registered by the active agent on its network, and not expired. */
function liveEndpoints(organisationId: string, gatewayId: string, trusted: boolean) {
  const db = useDB({ trusted });
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  return db
    .select({
      protocol: gatewayEndpoints.protocol,
      url: gatewayEndpoints.url,
      deviceId: gatewayEndpoints.deviceId,
      registeredAt: gatewayEndpoints.registeredAt,
      expiresAt: gatewayEndpoints.expiresAt
    })
    .from(gatewayEndpoints)
    .innerJoin(gateways, eq(gateways.id, gatewayEndpoints.gatewayId))
    .innerJoin(agents, and(eq(agents.id, gatewayEndpoints.deviceId), eq(agents.networkId, gateways.networkId)))
    .where(
      and(
        eq(gatewayEndpoints.organisationId, organisationId),
        eq(gatewayEndpoints.gatewayId, gatewayId),
        eq(agents.active, true),
        gt(gatewayEndpoints.expiresAt, now)
      )
    )
    .orderBy(gatewayEndpoints.protocol);
}

/** The gateway's live endpoints, as members read them in the request session. */
export function listGatewayEndpoints(organisationId: string, gatewayId: string) {
  return liveEndpoints(organisationId, gatewayId, false);
}

/**
 * The URL of each protocol's server at the gateway, by protocol, as registered and live: trusted code, since `connect`
 * serves devices too, which cannot read the topology.
 */
export async function registeredEndpointUrls(organisationId: string, gatewayId: string) {
  const rows = await liveEndpoints(organisationId, gatewayId, true);
  return new Map(rows.map(row => [row.protocol, row.url]));
}
