import { HttpError, type Grant, type PostGrantsExchangeData } from '@conservationtv/controlplane-sdk';
import { ApiFailure } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import type { Environment } from '../env/env.ts';

// Iroh endpoint leases from gatekeeper. Its relay admits an endpoint only while gatekeeper holds an active lease for
// the endpoint ID, which the relay's handshake has already proven the device owns, so a lease is never presented by
// the device: issuing it is enough. Gatekeeper trusts this API as its environment's consumer, by GATEKEEPER_TOKEN.

/**
 * How long a lease admits the endpoint. The relay checks only on connect: a connected endpoint outlives its lease, but
 * cannot reconnect after it without a new session. Gatekeeper may shorten it to its environment's ceiling.
 */
const LEASE_LIFETIME_SECONDS = 3_600;

/** The deployment's gatekeeper client. */
export type Gatekeeper = NonNullable<Environment['gatekeeper']>;

/** The lease admitting a device's endpoint to the relay. */
export interface IrohLease {
  id: string;
  /** Gatekeeper's audit record of the exchange, which revoking the lease would name. */
  grantId: string;
  /** After this, the relay refuses new connections from the endpoint until it is leased again. */
  expiresAt: string;
}

/** What a grant asks gatekeeper for. */
export type RequestedCapabilities = PostGrantsExchangeData['body']['requested_capabilities'];

/**
 * Exchange a grant for the device. `forbidden` if gatekeeper will not admit the endpoint (it is denied);
 * `relay_unavailable` for any other failure, which is gatekeeper's or this API's.
 */
export async function exchange(
  device: AuthenticatedDevice,
  gatekeeper: Gatekeeper,
  requested_capabilities: RequestedCapabilities,
  expires_in: number
): Promise<Grant> {
  try {
    const client = await gatekeeper.client();
    const result = await client.grants.exchange.v1({ subject: `device:${device.id}`, requested_capabilities, expires_in });
    if (!(result instanceof Error)) return result;
    const refused = result instanceof HttpError && result.code === 'invalid_endpoint_id';
    throw new ApiFailure(refused ? 'forbidden' : 'relay_unavailable', { cause: result });
  } catch (cause) {
    // The ApiFailure thrown above passes through; anything else is gatekeeper being unreachable.
    if (cause instanceof ApiFailure) throw cause;
    throw new ApiFailure('relay_unavailable', { cause });
  }
}

/** Lease the device's endpoint from gatekeeper, failing as `exchange` does. */
export async function leaseEndpoint(device: AuthenticatedDevice, gatekeeper: Gatekeeper): Promise<IrohLease> {
  const capabilities = { iroh: { endpoint_id: device.publicId, action: 'connect' as const } };
  const result = await exchange(device, gatekeeper, capabilities, LEASE_LIFETIME_SECONDS);
  const lease = result.credentials.iroh;
  if (lease === undefined) throw new ApiFailure('relay_unavailable', { cause: 'Gatekeeper issued no Iroh lease' });
  return { id: lease.lease_id, grantId: result.grant_id, expiresAt: lease.expires_at };
}
