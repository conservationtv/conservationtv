import { and, eq } from 'drizzle-orm';
import { exposures, gateways, showOutputs, showPreviews } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { useDevice } from '../middleware/device.ts';
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
import { selectOutputShow } from '../services/shows.ts';
import { useEnvironment } from '../env/env.ts';

// Who may connect to an exposure or a show's preview, and which provider gives them its connection details: the same
// gateway providers for both, each a delivery at its gateway. Members read, signed in. Devices connect for what they
// publish: a device publishes the exposures it is the pinned publisher of (a browser publishing directly is one), and
// reads the upstreams of those. Nothing else is published: exposures without a pinned publisher wait for the
// configuration builders to choose one. A show's output (src/db/schemas/shows.ts) also reads what its organisation's
// broadcast currently places, as its object says (src/shows/host.tsx), to play it in OBS, and publishes the show's
// previews. A preview offers only the `default` rendition: the program is one encoding.

/** An exposure, by where its connections are made: `organisations/{organisationId}/streams/{streamId}/exposures/{exposureId}`. */
export interface ExposureLocation {
  organisationId: string;
  streamId: string;
  exposureId: string;
}

/** A show's preview, by where its connections are made: `organisations/{organisationId}/shows/{showId}/previews/{previewId}`. */
export interface PreviewLocation {
  organisationId: string;
  showId: string;
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
      publisherDeviceId: exposures.publisherDeviceId
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

/** The preview, with its show's output device (null for none), if it is visible to the transaction. */
async function selectPreview(location: PreviewLocation) {
  const db = useDB();
  const [preview] = await db
    .select({ id: showPreviews.id, gatewayId: showPreviews.gatewayId, outputDeviceId: showOutputs.deviceId })
    .from(showPreviews)
    .leftJoin(showOutputs, eq(showOutputs.showId, showPreviews.showId))
    .where(
      and(
        eq(showPreviews.organisationId, location.organisationId),
        eq(showPreviews.showId, location.showId),
        eq(showPreviews.id, location.previewId)
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

/** Whether the device may read the exposure: an upstream of one it publishes, or one its show places. */
async function reads(deviceId: string, location: ExposureLocation) {
  if (await publishesFrom(deviceId, location)) return true;
  return showPlaces(deviceId, location);
}

/**
 * Whether the device is the output of one of the exposure's organisation's shows, and the show places it. Every show
 * follows its organisation's one broadcast for now, keyed by the organisation.
 */
async function showPlaces(deviceId: string, location: ExposureLocation) {
  const output = await selectOutputShow(deviceId);
  if (output?.organisationId !== location.organisationId) return false;
  const environment = useEnvironment();
  const broadcast = environment.broadcasts.get(output.organisationId);
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
        action === 'publish' ? exposure.publisherDeviceId === device.id : reads(device.id, location)
      )
    );
  }
  return transaction(() => connection(location, subject, () => action === 'read'));
}

/**
 * What the caller may connect to of a preview. A member decides in their request session, and only reads. A device is
 * decided by trusted code, and only publishes, and only the output of the preview's show.
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

/** Connect the caller to a show's preview, as `connectTarget` does. */
/**
 * How a preview at a MediaMTX gateway is read: by HLS alone. OBS encodes the programme with B-frames, which WebRTC
 * refuses, and HLS is what readers of a preview are pointed at; its publisher pushes by RTMP, which stays open.
 */
const MEDIAMTX_PREVIEW_READ_PROTOCOLS: ReadonlySet<string> = new Set(['hls']);

/** Where the caller reads or publishes a show's preview: `unsupported_protocol` to read a MediaMTX one but by HLS. */
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
