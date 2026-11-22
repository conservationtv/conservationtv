import { and, eq } from 'drizzle-orm';
import { exposures, gateways, outputDevices, outputPreviews } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { selectLocalGateway } from '../configuration/plan/helpers.ts';
import { useDevice, type AuthenticatedDevice } from '../middleware/device.ts';
import { usePrincipal } from '../middleware/principal.ts';
import { BUILTIN_GATEWAYS, gatewayProvider, isBuiltinGateway } from './index.ts';
import type {
  ConnectionAction,
  ConnectionDelivery,
  ConnectionDetails,
  RequestedConnection,
  StatsConnection
} from './provider.ts';
import { getOrganisation } from '../services/organisations.ts';
import { selectDeviceOutput } from '../services/outputs.ts';
import { useEnvironment } from '../env/env.ts';

// Who may connect to an exposure or an output's preview, and which provider gives them its connection details: the same
// gateway providers for both, each a delivery at its gateway. Members read, signed in. Devices connect for what they
// publish: a device publishes the exposures it is the pinned publisher of (a browser publishing directly is one), and
// reads the upstreams of those. An exposure with no pinned publisher is published by the agent the configuration
// builders choose (src/configuration/plan/helpers.ts): the active agent whose gateway its upstream is on, as a MoQ copy
// of a camera's exposure there follows it. Nothing else is published. An output's agent (src/db/schemas/outputs.ts) also reads, to play in OBS, what
// the show it follows currently places, as the show's object says (src/shows/host.tsx), or, under `external` control,
// any of its organisation's exposures; and publishes the output's previews. A preview offers only the `default`
// rendition: the programme is one encoding.

/** An exposure, by where its connections are made: `organisations/{organisationId}/streams/{streamId}/exposures/{exposureId}`. */
export interface ExposureLocation {
  organisationId: string;
  streamId: string;
  exposureId: string;
}

/** An output's preview, by where its connections are made: `organisations/{organisationId}/outputs/{outputId}/previews/{previewId}`. */
export interface PreviewLocation {
  organisationId: string;
  outputId: string;
  previewId: string;
}

/** The renditions a preview offers: the program, as it is encoded. */
const PREVIEW_RENDITIONS: ConnectionDelivery['renditions'] = ['default'];

/** What a caller asks for: an action, by a protocol, at a rendition; unchecked against the gateway and delivery. */
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
      upstreamExposureId: exposures.upstreamExposureId
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

/** The preview, with its output's device (null for none), if it is visible to the transaction. */
async function selectPreview(location: PreviewLocation) {
  const db = useDB();
  const [preview] = await db
    .select({ id: outputPreviews.id, gatewayId: outputPreviews.gatewayId, outputDeviceId: outputDevices.deviceId })
    .from(outputPreviews)
    .leftJoin(outputDevices, eq(outputDevices.outputId, outputPreviews.outputId))
    .where(
      and(
        eq(outputPreviews.organisationId, location.organisationId),
        eq(outputPreviews.outputId, location.outputId),
        eq(outputPreviews.id, location.previewId)
      )
    );
  return preview;
}
type VisiblePreview = NonNullable<Awaited<ReturnType<typeof selectPreview>>>;

/** A delivery's gateway, as its provider reads it: a built-in one has no settings, since where it is is the deployment's. */
async function selectGateway(organisationId: string, gatewayId: string) {
  if (isBuiltinGateway(gatewayId)) return { id: gatewayId, kind: BUILTIN_GATEWAYS[gatewayId].kind, settings: {} };
  const db = useDB();
  const [gateway] = await db
    .select({ id: gateways.id, kind: gateways.kind, settings: gateways.settings })
    .from(gateways)
    .where(and(eq(gateways.organisationId, organisationId), eq(gateways.id, gatewayId)));
  // An exposure's or preview's gateway is checked whenever either changes, so it is there.
  return gateway!;
}

/**
 * Whether the device publishes the exposure: as its pinned publisher, or, with none pinned, as the active agent whose
 * gateway its upstream is on while it delivers that upstream too (unpinned, or pinned to it), which is when the
 * configuration builders have it publish (src/configuration/plan/helpers.ts).
 */
async function publishes(device: AuthenticatedDevice, exposure: VisibleExposure) {
  if (exposure.publisherDeviceId !== null) return exposure.publisherDeviceId === device.id;
  if (exposure.upstreamExposureId === null) return false;
  const gatewayId = await selectLocalGateway(device);
  if (gatewayId === undefined) return false;
  const db = useDB({ trusted: true });
  const [upstream] = await db
    .select({ gatewayId: exposures.gatewayId, publisherDeviceId: exposures.publisherDeviceId })
    .from(exposures)
    .where(eq(exposures.id, exposure.upstreamExposureId));
  if (upstream?.gatewayId !== gatewayId) return false;
  return upstream.publisherDeviceId === null || upstream.publisherDeviceId === device.id;
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

/** Whether the device may read the exposure: an upstream of one it publishes, or one its output plays. */
async function reads(deviceId: string, location: ExposureLocation) {
  if (await publishesFrom(deviceId, location)) return true;
  return outputReads(deviceId, location);
}

/**
 * Whether the device runs one of the exposure's organisation's outputs, and that output may play it: under `external`
 * control any of the organisation's exposures, as whatever drives its OBS chooses; under `show` control, what the show
 * it follows places, and nothing while it follows none.
 */
async function outputReads(deviceId: string, location: ExposureLocation) {
  const output = await selectDeviceOutput(deviceId);
  if (output?.organisationId !== location.organisationId) return false;
  if (output.control === 'external') return true;
  if (output.showId === null) return false;
  const environment = useEnvironment();
  const broadcast = environment.broadcasts.get(output.showId);
  return broadcast.places(location.exposureId);
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
  const delivery = { id: exposure.id, renditions: exposure.renditions };
  return { organisationId: location.organisationId, subject, delivery, gateway };
}

/** What the caller may connect to, decided in the transaction: `not_found` if it cannot see the preview, `forbidden` if `allowed` refuses. */
async function previewConnection(
  location: PreviewLocation,
  subject: string,
  allowed: (preview: VisiblePreview) => boolean
) {
  const preview = await selectPreview(location);
  if (!preview) throw new ApiFailure('not_found');
  if (!allowed(preview)) throw new ApiFailure('forbidden');
  const gateway = await selectGateway(location.organisationId, preview.gatewayId);
  const delivery = { id: preview.id, renditions: PREVIEW_RENDITIONS };
  return { organisationId: location.organisationId, subject, delivery, gateway };
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
        action === 'publish' ? publishes(device, exposure) : reads(device.id, location)
      )
    );
  }
  return transaction(() => connection(location, subject, () => action === 'read'));
}

/**
 * What the caller may connect to of a preview. A member decides in their request session, and only reads. A device is
 * decided by trusted code, and only publishes, and only the agent the preview's output runs on.
 */
async function callerPreviewConnection(location: PreviewLocation, action: ConnectionAction) {
  const caller = usePrincipal();
  const subject = `${caller.kind}:${caller.id}`;
  if (caller.kind === 'device') {
    const device = useDevice();
    if (device.organisationId !== location.organisationId) throw new ApiFailure('not_found');
    return trustedTransaction(() =>
      previewConnection(location, subject, preview => action === 'publish' && preview.outputDeviceId === device.id)
    );
  }
  return transaction(() => previewConnection(location, subject, () => action === 'read'));
}

/** What a caller connects to: a delivery at its gateway, for the caller. */
interface ConnectionTarget extends Pick<RequestedConnection, 'organisationId' | 'subject' | 'delivery'> {
  gateway: Awaited<ReturnType<typeof selectGateway>>;
}

/**
 * The connection details from the delivery's gateway's provider, for what the caller asked: `unsupported_gateway` for
 * a kind without one, and the provider's refusals of a protocol or rendition it cannot connect by.
 */
function connectTarget(target: ConnectionTarget, ask: ConnectionAsk): Promise<ConnectionDetails> {
  const { gateway, ...delivered } = target;
  const provider = gatewayProvider(gateway.id, gateway.kind);
  return provider.connect({ ...delivered, gatewayId: gateway.id, ...ask }, gateway.settings);
}

/** Connect the caller to an exposure, as `connectTarget` does. */
export async function connectExposure(location: ExposureLocation, ask: ConnectionAsk): Promise<ConnectionDetails> {
  const target = await callerConnection(location, ask.action);
  return connectTarget(target, ask);
}

/**
 * How a preview at a MediaMTX gateway is read: by HLS alone. OBS encodes the programme with B-frames, which WebRTC
 * refuses, and HLS is what readers of a preview are pointed at; its publisher pushes by RTMP, which stays open.
 */
const MEDIAMTX_PREVIEW_READ_PROTOCOLS: ReadonlySet<string> = new Set(['hls']);

/** Where the caller reads or publishes an output's preview: `unsupported_protocol` to read a MediaMTX one but by HLS. */
export async function connectPreview(location: PreviewLocation, ask: ConnectionAsk): Promise<ConnectionDetails> {
  const target = await callerPreviewConnection(location, ask.action);
  const mediamtx = target.gateway.kind === 'mediamtx';
  if (mediamtx && ask.action === 'read' && !MEDIAMTX_PREVIEW_READ_PROTOCOLS.has(ask.protocol)) {
    throw new ApiFailure('unsupported_protocol');
  }
  return connectTarget(target, ask);
}

/**
 * Where the caller reads a gateway's traffic stats about the organisation: its devices, and its members, decided in
 * their request session so row-level security decides membership. `not_found` for an organisation the caller is not
 * in, and `unsupported_gateway` for a gateway that publishes no stats, as no organisation's own gateway does.
 */
export async function connectStats(organisationId: string, gatewayId: string): Promise<StatsConnection> {
  const caller = usePrincipal();
  if (caller.kind === 'device') {
    const device = useDevice();
    if (device.organisationId !== organisationId) throw new ApiFailure('not_found');
  } else {
    const organisation = await transaction(() => getOrganisation(organisationId));
    if (!organisation) throw new ApiFailure('not_found');
  }
  const stats = isBuiltinGateway(gatewayId) ? BUILTIN_GATEWAYS[gatewayId].stats : undefined;
  if (!stats) throw new ApiFailure('unsupported_gateway');
  return stats({ organisationId, subject: `${caller.kind}:${caller.id}` });
}
