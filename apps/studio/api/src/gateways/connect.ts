import { and, eq } from 'drizzle-orm';
import { exposures, gateways } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import type { UserPrincipal } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import type { Settings } from '../topology/settings.ts';
import { BUILTIN_GATEWAYS, gatewayProvider, isBuiltinGateway } from './index.ts';
import type { Connection, ConnectionAction, ConnectionRequest } from './provider.ts';

// Who may connect to an exposure, and which provider gives them its connection details. Members read, signed in.
// Devices connect for what they publish: a device publishes the exposures it is the pinned publisher of (a browser
// publishing directly is one), and reads the upstreams of those. Nothing else is published: exposures without a
// pinned publisher wait for the configuration builders to choose one.

/** A connection request, and the gateway its provider is chosen by. */
export interface PendingConnection {
  request: ConnectionRequest;
  gateway: ConnectionGateway;
}

/** The exposure's gateway: a built-in one has no settings, since where it is belongs to the deployment. */
interface ConnectionGateway {
  id: string;
  kind: string;
  settings: Settings;
}

export interface ExposureReference {
  organisationId: string;
  streamId: string;
  exposureId: string;
}

const exposureColumns = {
  id: exposures.id,
  gatewayId: exposures.gatewayId,
  protocol: exposures.protocol,
  publisherDeviceId: exposures.publisherDeviceId,
  params: exposures.params
};

function selectExposure(tx: Transaction, reference: ExposureReference) {
  return tx
    .select(exposureColumns)
    .from(exposures)
    .where(
      and(
        eq(exposures.organisationId, reference.organisationId),
        eq(exposures.streamId, reference.streamId),
        eq(exposures.id, reference.exposureId)
      )
    );
}

/** The exposure's gateway, as its provider reads it. */
async function selectGateway(tx: Transaction, organisationId: string, gatewayId: string): Promise<ConnectionGateway> {
  if (isBuiltinGateway(gatewayId)) return { id: gatewayId, kind: BUILTIN_GATEWAYS[gatewayId].kind, settings: {} };
  const [gateway] = await tx
    .select({ id: gateways.id, kind: gateways.kind, settings: gateways.settings })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)));
  // An exposure's gateway is checked whenever either changes, so it is there.
  return gateway!;
}

/** Whether the device publishes an exposure of the stream from this one. */
async function publishesFrom(tx: Transaction, device: AuthenticatedDevice, reference: ExposureReference) {
  const [downstream] = await tx
    .select({ id: exposures.id })
    .from(exposures)
    .where(
      and(
        eq(exposures.streamId, reference.streamId),
        eq(exposures.upstreamExposureId, reference.exposureId),
        eq(exposures.publisherDeviceId, device.id)
      )
    )
    .limit(1);
  return downstream !== undefined;
}

/** The request a member makes: reading only, in their request session, so row-level security decides visibility. */
export async function memberRequest(
  principal: UserPrincipal,
  reference: ExposureReference,
  action: ConnectionAction
): Promise<PendingConnection> {
  const environment = useEnvironment();
  const session = await environment.session(principal);
  return session.transaction(async tx => {
    const [exposure] = await selectExposure(tx, reference);
    if (!exposure) throw new ApiFailure('not_found');
    // Members publish from a device, such as their browser's, which signs instead.
    if (action === 'publish') throw new ApiFailure('forbidden');
    const gateway = await selectGateway(tx, reference.organisationId, exposure.gatewayId);
    const subject = `user:${principal.id}`;
    return {
      request: { organisationId: reference.organisationId, gatewayId: gateway.id, exposure, action, subject },
      gateway
    };
  });
}

/** The request a device makes, decided by trusted code: a device principal cannot read the topology itself. */
export function deviceRequest(
  device: AuthenticatedDevice,
  reference: ExposureReference,
  action: ConnectionAction
): Promise<PendingConnection> {
  if (device.organisationId !== reference.organisationId) throw new ApiFailure('not_found');
  return trusted(async tx => {
    const [exposure] = await selectExposure(tx, reference);
    if (!exposure) throw new ApiFailure('not_found');
    const allowed =
      action === 'publish' ? exposure.publisherDeviceId === device.id : await publishesFrom(tx, device, reference);
    if (!allowed) throw new ApiFailure('forbidden');
    const gateway = await selectGateway(tx, reference.organisationId, exposure.gatewayId);
    const subject = `device:${device.id}`;
    return {
      request: { organisationId: reference.organisationId, gatewayId: gateway.id, exposure, action, subject },
      gateway
    };
  });
}

/** The connection details from the gateway's provider; `unsupported_gateway` for a kind without one. */
export function connect({ request, gateway }: PendingConnection): Promise<Connection> {
  const provider = gatewayProvider(gateway.id, gateway.kind);
  return provider.connect(request, gateway.settings);
}
