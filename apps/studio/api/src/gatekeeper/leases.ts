import { SignJWT } from 'jose';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useServices } from '../services.ts';
import { GRANT_SIGNING_ALGORITHM, grantSigner, type GrantSigningKeys } from './keys.ts';

// Iroh endpoint leases from gatekeeper. Its relay admits an endpoint only while gatekeeper holds an active lease for
// the endpoint ID, which the relay's handshake has already proven the device owns, so a lease is never presented by
// the device: issuing it is enough. Gatekeeper registers this API with its issuer (APP_URL, exactly as configured),
// subject (CONSUMER_SUBJECT), audience (the exchange URL), this JWKS and the subject prefix, delegating Iroh `connect`.

/** The consumer `sub` gatekeeper registers this API under. */
export const CONSUMER_SUBJECT = 'studio-api';
/** The namespace of the grant subjects this API signs for, registered as its only `subject_prefixes` entry. */
export const SUBJECT_PREFIX = 'studio';

/** How long an assertion may be exchanged for; gatekeeper caps it at the registered maximum. */
const ASSERTION_LIFETIME_SECONDS = 60;
/**
 * How long a lease admits the endpoint. The relay checks only on connect: a connected endpoint outlives its lease, but
 * cannot reconnect after it without a new session. Gatekeeper may shorten it to the registered or deployment ceiling.
 */
const LEASE_LIFETIME_SECONDS = 3_600;

/** Where gatekeeper is, and the keys this API signs its assertions with. */
export interface GatekeeperSettings {
  url: string;
  keys: GrantSigningKeys;
}

/** The lease admitting a device's endpoint to the relay. */
export interface IrohLease {
  id: string;
  /** Gatekeeper's audit record of the exchange, which revoking the lease would name. */
  grantId: string;
  /** After this, the relay refuses new connections from the endpoint until it is leased again. */
  expiresAt: string;
}

/** The parts of `grants.exchange` v1's answer used here, and its failures' stable code. */
const ExchangeResultSchema = z.object({
  grant_id: z.string(),
  credentials: z.object({
    iroh: z.object({ endpoint_id: z.string(), lease_id: z.string(), expires_at: z.string() }).optional()
  })
});
type ExchangeResult = z.output<typeof ExchangeResultSchema>;
const ExchangeFailureSchema = z.object({ error: z.string() });
type ExchangeFailure = z.output<typeof ExchangeFailureSchema>;

/** An assertion asking gatekeeper to lease the device's endpoint, signed as this API. */
async function leaseAssertion(device: AuthenticatedDevice, gatekeeper: GatekeeperSettings) {
  const services = useServices();
  const now = Math.floor(services.clock() / 1000);
  const signer = await grantSigner(gatekeeper.keys);
  const grant = {
    version: 1,
    subject: `${SUBJECT_PREFIX}:device:${device.id}`,
    requested_capabilities: { iroh: { endpoint_id: device.publicId, action: 'connect' } },
    expires_in: LEASE_LIFETIME_SECONDS
  };
  return new SignJWT({ grant })
    .setProtectedHeader({ alg: GRANT_SIGNING_ALGORITHM, kid: signer.kid, typ: 'relay-grant+jwt' })
    .setIssuer(services.config.APP_URL)
    .setSubject(CONSUMER_SUBJECT)
    .setAudience(new URL('/grants/exchange', gatekeeper.url).href)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ASSERTION_LIFETIME_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(signer.key);
}

/**
 * Exchange the assertion. Not through the controlplane SDK: one call at one version needs no handshake, and
 * gatekeeper answers 412 if it stops serving it. `forbidden` if gatekeeper will not admit the endpoint (it is denied,
 * or leased to another consumer); `relay_unavailable` for any other failure, which is gatekeeper's or this API's.
 */
async function exchange(assertion: string, gatekeeper: GatekeeperSettings): Promise<ExchangeResult> {
  const response = await fetch(new URL('/grants/exchange', gatekeeper.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'operation-version': '1' },
    body: JSON.stringify({ grant_assertion: assertion })
  }).catch(cause => {
    throw new ApiFailure('relay_unavailable', { cause });
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const result = ExchangeResultSchema.safeParse(body);
    if (result.success) return result.data;
    throw new ApiFailure('relay_unavailable', { cause: result.error });
  }
  const parsed = ExchangeFailureSchema.safeParse(body);
  const code: ExchangeFailure['error'] = parsed.data?.error ?? 'unknown';
  const cause = `Gatekeeper answered ${response.status} ${code}`;
  throw new ApiFailure(code === 'invalid_endpoint_id' ? 'forbidden' : 'relay_unavailable', { cause });
}

/** Lease the device's endpoint from gatekeeper, failing as `exchange` does. */
export async function leaseEndpoint(device: AuthenticatedDevice, gatekeeper: GatekeeperSettings): Promise<IrohLease> {
  const assertion = await leaseAssertion(device, gatekeeper);
  const result = await exchange(assertion, gatekeeper);
  const lease = result.credentials.iroh;
  if (lease === undefined) throw new ApiFailure('relay_unavailable', { cause: 'Gatekeeper issued no Iroh lease' });
  return { id: lease.lease_id, grantId: result.grant_id, expiresAt: lease.expires_at };
}
