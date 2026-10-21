import { ApiFailure } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { exchange, type Gatekeeper } from './leases.ts';

// MoQ publish tokens from gatekeeper, for a device that delivers an exposure itself, such as a camera running the
// edge agent instead of an agent's MediaMTX. The relay asks gatekeeper about every session, so the token is what the
// device presents, as `?jwt=` on the relay URL. Each authorises publishing one broadcast: the exposure's.

/**
 * How long a token admits the device. The relay checks only on connect: a connected publisher outlives its token, but
 * cannot reconnect after it without a new session. Gatekeeper may shorten it to its environment's ceiling.
 */
const TOKEN_LIFETIME_SECONDS = 3_600;

/** A token to publish one broadcast. */
export interface BroadcastToken {
  /** The path the token is rooted at, which the device dials. */
  root: string;
  /** The one broadcast it may publish, relative to the root. */
  broadcast: string;
  /** A gatekeeper-signed moq-relay token. A secret. */
  token: string;
  /** Gatekeeper's audit record of the exchange. */
  grantId: string;
  /** After this, the relay refuses new sessions with the token. */
  expiresAt: string;
}

/** Where an organisation's exposures are broadcast: `organisations/<id>/exposures/<exposure>`. */
export const exposuresRoot = (organisationId: string) => `organisations/${organisationId}/exposures`;

/** A token for the device to publish the exposure's broadcast, failing as `exchange` does. */
export async function publishToken(
  device: AuthenticatedDevice,
  gatekeeper: Gatekeeper,
  exposureId: string
): Promise<BroadcastToken> {
  const root = exposuresRoot(device.organisationId);
  const capabilities = { moq: { root, publish: [exposureId], subscribe: [] } };
  const result = await exchange(device, gatekeeper, capabilities, TOKEN_LIFETIME_SECONDS);
  const moq = result.credentials.moq;
  if (moq === undefined) throw new ApiFailure('relay_unavailable', { cause: 'Gatekeeper issued no MoQ token' });
  return { root, broadcast: exposureId, token: moq.token, grantId: result.grant_id, expiresAt: moq.expires_at };
}
