import { and, eq } from 'drizzle-orm';
import { exposures, gateways } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { useDevice } from '../middleware/device.ts';
import { usePrincipal } from '../middleware/principal.ts';
import { BUILTIN_GATEWAYS, gatewayProvider, isBuiltinGateway } from './index.ts';
import type { ConnectionAction, ConnectionDetails, RequestedConnection } from './provider.ts';

// Who may connect to an exposure, and which provider gives them its connection details. Members read, signed in.
// Devices connect for what they publish: a device publishes the exposures it is the pinned publisher of (a browser
// publishing directly is one), and reads the upstreams of those. Nothing else is published: exposures without a
// pinned publisher wait for the configuration builders to choose one.

/** An exposure, by where its connections are made: `organisations/{organisationId}/streams/{streamId}/exposures/{exposureId}`. */
export interface ExposureLocation {
  organisationId: string;
  streamId: string;
  exposureId: string;
}

/** What a caller asks for: an action, by a protocol, at a rendition; unchecked against the gateway and exposure. */
export type ConnectionAsk = Pick<RequestedConnection, 'action' | 'protocol' | 'rendition'>;

/** The exposure, if it is visible to the transaction. */
async function selectExposure(location: ExposureLocation) {
  const db = useDB();
  const [exposure] = await db
    .select({
      id: exposures.id,
      gatewayId: exposures.gatewayId,
      renditions: exposures.renditions,
      publisherDeviceId: exposures.publisherDeviceId,
      params: exposures.params
    })
    .from(exposures)
    .where(
      and(
        eq(exposures.organisationId, location.organisationId),
        eq(exposures.streamId, location.streamId),
        eq(exposures.id, location.exposureId)
      )
    );
  return exposure;
}
type VisibleExposure = NonNullable<Awaited<ReturnType<typeof selectExposure>>>;

/** The exposure's gateway, as its provider reads it: a built-in one has no settings, since where it is is the deployment's. */
async function selectGateway(organisationId: string, gatewayId: string) {
  if (isBuiltinGateway(gatewayId)) return { id: gatewayId, kind: BUILTIN_GATEWAYS[gatewayId].kind, settings: {} };
  const db = useDB();
  const [gateway] = await db
    .select({ id: gateways.id, kind: gateways.kind, settings: gateways.settings })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)));
  // An exposure's gateway is checked whenever either changes, so it is there.
  return gateway!;
}

/** Whether the device publishes an exposure of the stream from this one. */
async function publishesFrom(deviceId: string, location: ExposureLocation) {
  const db = useDB({ trusted: true });
  const [downstream] = await db
    .select({ id: exposures.id })
    .from(exposures)
    .where(
      and(
        eq(exposures.streamId, location.streamId),
        eq(exposures.upstreamExposureId, location.exposureId),
        eq(exposures.publisherDeviceId, deviceId)
      )
    )
    .limit(1);
  return downstream !== undefined;
}

/** What the caller may connect to, decided in the transaction: `not_found` if it cannot see the exposure, `forbidden` if `allowed` refuses. */
async function connection(
  location: ExposureLocation,
  subject: string,
  allowed: (exposure: VisibleExposure) => boolean | Promise<boolean>
) {
  const exposure = await selectExposure(location);
  if (!exposure) throw new ApiFailure('not_found');
  if (!(await allowed(exposure))) throw new ApiFailure('forbidden');
  const gateway = await selectGateway(location.organisationId, exposure.gatewayId);
  return { organisationId: location.organisationId, subject, exposure, gateway };
}

/**
 * What the caller may connect to. A member decides in their request session, so row-level security decides
 * visibility, and only reads: they publish from a device, such as their browser's, which signs instead. A device is
 * decided by trusted code, since a device principal cannot read the topology itself.
 */
async function callerConnection(location: ExposureLocation, action: ConnectionAction) {
  const caller = usePrincipal();
  const subject = `${caller.kind}:${caller.id}`;
  if (caller.kind === 'device') {
    const device = useDevice();
    if (device.organisationId !== location.organisationId) throw new ApiFailure('not_found');
    return trustedTransaction(() =>
      connection(location, subject, exposure =>
        action === 'publish' ? exposure.publisherDeviceId === device.id : publishesFrom(device.id, location)
      )
    );
  }
  return transaction(() => connection(location, subject, () => action === 'read'));
}

/**
 * The connection details from the exposure's gateway's provider, for what the caller asked: `unsupported_gateway` for
 * a kind without one, and the provider's refusals of a protocol or rendition it cannot connect by.
 */
export async function connectExposure(location: ExposureLocation, ask: ConnectionAsk): Promise<ConnectionDetails> {
  const { gateway, ...target } = await callerConnection(location, ask.action);
  const provider = gatewayProvider(gateway.id, gateway.kind);
  return provider.connect({ ...target, gatewayId: gateway.id, ...ask }, gateway.settings);
}
