import { HttpError, type Client, type Grant } from '@conservationtv/controlplane-sdk';
import { ApiFailure, type ApiFailureCode } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useEnvironment } from '../env/env.ts';

// Credentials from gatekeeper, which names the relays and admits callers to them. Gatekeeper trusts this API as its
// environment's consumer, by GATEKEEPER_TOKEN, and each credential names the relay it is for.
//
//   Iroh leases: its iroh relay admits an endpoint only while gatekeeper holds an active lease for the endpoint ID,
//   which the relay's handshake has already proven the device owns, so a lease is never presented by the device:
//   issuing it is enough.
//
//   MoQ tokens: its MoQ relay admits a connection by a token scoped to a path (src/gateways/conservationtv.ts).

/**
 * How long a lease admits the endpoint. The relay checks only on connect: a connected endpoint outlives its lease, but
 * cannot reconnect after it without a new session. Gatekeeper may shorten it to its environment's ceiling.
 */
const LEASE_LIFETIME_SECONDS = 3_600;

type GrantRequest = Parameters<Client['grants']['exchange']['v1']>[0];

/**
 * Exchange a grant. `forbidden` if gatekeeper will not admit what was asked for (an endpoint it denies); `unavailable`
 * for any other failure, which is gatekeeper's or this API's, never the caller's.
 */
async function exchange(request: GrantRequest, unavailable: ApiFailureCode): Promise<Grant> {
  const environment = useEnvironment();
  try {
    const client = await environment.gatekeeper.client();
    const result = await client.grants.exchange.v1(request);
    if (!(result instanceof Error)) return result;
    const refused = result instanceof HttpError && result.code === 'invalid_endpoint_id';
    throw new ApiFailure(refused ? 'forbidden' : unavailable, { cause: result });
  } catch (cause) {
    // The ApiFailure thrown above passes through; anything else is gatekeeper being unreachable.
    if (cause instanceof ApiFailure) throw cause;
    throw new ApiFailure(unavailable, { cause });
  }
}

/** The lease admitting a device's endpoint to the relay. */
export interface IrohLease {
  id: string;
  /** Gatekeeper's audit record of the exchange, which revoking the lease would name. */
  grantId: string;
  /** After this, the relay refuses new connections from the endpoint until it is leased again. */
  expiresAt: string;
}

/** Lease the device's endpoint, on the relay gatekeeper names; `relay_unavailable` if it cannot be had. */
export async function leaseEndpoint(device: AuthenticatedDevice) {
  const request: GrantRequest = {
    subject: `device:${device.id}`,
    requested_capabilities: { iroh: { endpoint_id: device.publicId, action: 'connect' } },
    expires_in: LEASE_LIFETIME_SECONDS
  };
  const result = await exchange(request, 'relay_unavailable');
  const lease = result.credentials.iroh;
  if (lease === undefined) throw new ApiFailure('relay_unavailable', { cause: 'Gatekeeper issued no Iroh lease' });
  const issued: IrohLease = { id: lease.lease_id, grantId: result.grant_id, expiresAt: lease.expires_at };
  return { relay: lease.relay, lease: issued };
}

/**
 * A MoQ token for the subject at the path: to subscribe to everything under it, and to publish there too when it
 * publishes, which reads back the rendition broadcasts it joins into one. `gateway_unavailable` if it cannot be had.
 */
export async function moqToken(subject: string, path: string, publish: boolean, lifetimeSeconds: number) {
  const request: GrantRequest = {
    subject,
    requested_capabilities: { moq: { root: path, publish: publish ? [''] : [], subscribe: [''] } },
    expires_in: lifetimeSeconds
  };
  const result = await exchange(request, 'gateway_unavailable');
  const credential = result.credentials.moq;
  if (credential === undefined)
    throw new ApiFailure('gateway_unavailable', { cause: 'Gatekeeper issued no MoQ token' });
  return credential;
}
