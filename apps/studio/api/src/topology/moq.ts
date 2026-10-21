import { and, eq } from 'drizzle-orm';
import { exposures, streams } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { publishToken, type BroadcastToken } from '../gatekeeper/broadcasts.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { trusted } from '../organisations/membership.ts';
import { useEnvironment } from '../env/env.ts';

// How a device that delivers an exposure itself starts a MoQ session: the relay to publish to, and a token for the
// exposure's broadcast. Only the stream's source device may, and only a `moq` exposure: a camera publishes its own
// stream, never another's.

/** A MoQ session publishing an exposure. */
export interface MoqSession extends BroadcastToken {
  /** The relay URL to dial, at the token's root; the device adds `?jwt=<token>`. */
  url: string;
}

/** Whether the exposure delivers by MoQ a stream the device is the source of. */
async function sources(device: AuthenticatedDevice, exposureId: string): Promise<boolean> {
  // Devices read only their organisation's devices (src/db/roles.ts), so this one question is asked as trusted code.
  const [row] = await trusted(tx =>
    tx
      .select({ id: exposures.id })
      .from(exposures)
      .innerJoin(streams, and(eq(streams.organisationId, exposures.organisationId), eq(streams.id, exposures.streamId)))
      .where(
        and(
          eq(exposures.organisationId, device.organisationId),
          eq(exposures.id, exposureId),
          eq(exposures.protocol, 'moq'),
          eq(streams.sourceDeviceId, device.id)
        )
      )
  );
  return row !== undefined;
}

/** The MoQ session the device starts now, publishing the exposure. */
export async function moqSession(device: AuthenticatedDevice, exposureId: string): Promise<MoqSession> {
  const environment = useEnvironment();
  if (!(await sources(device, exposureId))) throw new ApiFailure('not_found');
  const relay = environment.variables.MOQ_RELAY_URL;
  if (relay === undefined || environment.gatekeeper === undefined) {
    throw new ApiFailure('relay_unavailable', { cause: 'No MoQ relay is configured' });
  }
  const token = await publishToken(device, environment.gatekeeper, exposureId);
  const url = new URL(token.root, relay.endsWith('/') ? relay : `${relay}/`).href;
  return { url, ...token };
}
