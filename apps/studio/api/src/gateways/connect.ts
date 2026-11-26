import { placedStreams } from '@conservationtv/shows';
import { exposureSubject } from '@conservationtv/reports';
import { and, eq } from 'drizzle-orm';
import { devices, exposures, gateways, outputDevices, outputPreviews, outputs } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { selectLocalGateway, selectRelayCoverage } from '../configuration/plan/helpers.ts';
import { isFailing } from '../health/status.ts';
import { useDevice, type AuthenticatedDevice } from '../middleware/device.ts';
import { usePrincipal } from '../middleware/principal.ts';
import { readShowFacts } from '../shows/lineup.ts';
import type { OutputReader } from '../shows/reach.ts';
import { resolveShow } from '../shows/resolve.ts';
import { BUILTIN_GATEWAY_IDS, BUILTIN_GATEWAYS, gatewayProvider, isBuiltinGateway } from './index.ts';
import { chooseDelivery, reachable, type DeliveryCandidate, type DeliveryReader } from './delivery.ts';
import { askGateway } from './live.ts';
import {
  servedProtocols,
  type ConnectionAction,
  type ConnectionDetails,
  type RequestedConnection,
  type StatsConnection
} from './provider.ts';
import { selectRegisteredProtocols } from '../services/gateway-endpoints.ts';
import { getOrganisation } from '../services/organisations.ts';
import { selectDeviceOutput } from '../services/outputs.ts';
import { getStream } from '../services/streams.ts';
import { listSubjectStates } from '../services/subjects.ts';

// Who may connect to an exposure, a stream or an output's preview, and which provider gives them its connection
// details: the same gateway providers for all, each a delivery at its gateway. Members read, signed in. Devices
// connect for what they publish: a device publishes the exposures it is the pinned publisher of (a browser publishing
// directly is one), and reads the upstreams of those. An agent also reads each exposure it covers on a relay that
// publishes stats (`selectRelayCoverage`), to watch whether the relay has it. An exposure with no pinned publisher is published by the agent
// the configuration builders choose (src/configuration/plan/helpers.ts): the active agent whose gateway its upstream is
// on, as a MoQ copy of a camera's exposure there follows it. Nothing else is published. An output's agent
// (src/db/schemas/outputs.ts) also reads, to play in OBS, what the show it follows places (`placedStreams`, resolved
// from the database: src/shows/resolve.ts), or, under `external` control, any of its organisation's streams, but only
// at a gateway it reaches, as a stream's reader is chosen one (`reachable`, src/gateways/delivery.ts); and publishes
// the output's previews.
//
// A stream is read by whatever delivers it (`connectStream`): the reader names the protocols it can play, and is given
// the exposure it should read by the rules in src/gateways/delivery.ts, from where it is (a member's browser on the
// internet, a device on its network) and, for an output's agent, the one gateway its output reads from, if it names one.

/** A stream, by where its connections are made: `organisations/{organisationId}/streams/{streamId}`. */
export interface StreamLocation {
  organisationId: string;
  streamId: string;
}

/** An exposure, by where its connections are made: `organisations/{organisationId}/streams/{streamId}/exposures/{exposureId}`. */
export interface ExposureLocation extends StreamLocation {
  exposureId: string;
}

/** An output's preview, by where its connections are made: `organisations/{organisationId}/outputs/{outputId}/previews/{previewId}`. */
export interface PreviewLocation {
  organisationId: string;
  outputId: string;
  previewId: string;
}

/** What a caller asks for: an action, by a protocol; unchecked against the gateway and delivery. */
export type ConnectionAsk = Pick<RequestedConnection, 'action' | 'protocol'>;

/** The exposure, if it is visible to the transaction. */
async function selectExposure(location: ExposureLocation) {
  const db = useDB();
  const [exposure] = await db
    .select({
      id: exposures.id,
      gatewayId: exposures.gatewayId,
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
export async function selectGateway(organisationId: string, gatewayId: string) {
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

/** Whether the device covers the exposure on its relay, so watches it there (src/configuration/plan/helpers.ts). */
async function covers(deviceId: string, location: ExposureLocation) {
  const coverage = await selectRelayCoverage(location.organisationId);
  return coverage.some(exposure => exposure.id === location.exposureId && exposure.coveredBy === deviceId);
}

/** The network of a delivery's gateway: null for a built-in one, on the internet. Trusted code. */
async function selectGatewayNetwork(gatewayId: string) {
  if (isBuiltinGateway(gatewayId)) return null;
  const db = useDB({ trusted: true });
  const [gateway] = await db.select({ networkId: gateways.networkId }).from(gateways).where(eq(gateways.id, gatewayId));
  return gateway?.networkId ?? null;
}

/**
 * Whether the device may read the exposure: an upstream of one it publishes, one it covers on its relay, or one of a
 * stream its output plays at a gateway it reaches, and its output's input gateway when that names one, as
 * `connectStream` would choose for it: never one on another network, whose LAN address it could not reach anyway.
 */
async function reads(device: AuthenticatedDevice, location: ExposureLocation, exposure: VisibleExposure) {
  if (await publishesFrom(device.id, location)) return true;
  if (await covers(device.id, location)) return true;
  if (!(await outputReads(device.id, location))) return false;
  const reader = await deviceReader(device, []);
  const networkId = await selectGatewayNetwork(exposure.gatewayId);
  return reachable({ gatewayId: exposure.gatewayId, networkId }, reader);
}

/**
 * Whether the device runs one of the stream's organisation's outputs, and that output may play it: under `external`
 * control any of the organisation's streams, as whatever drives its OBS chooses; under `show` control, what the show
 * it follows places, as its state resolves now, and nothing while it follows none. Trusted code.
 */
async function outputReads(deviceId: string, location: StreamLocation) {
  const output = await selectDeviceOutput(deviceId);
  if (output?.organisationId !== location.organisationId) return false;
  if (output.control === 'external') return true;
  if (output.showId === null) return false;
  const facts = await readShowFacts({ showId: output.showId, organisationId: output.organisationId });
  if (facts === undefined) return false;
  return placedStreams(resolveShow(facts)).includes(location.streamId);
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
  const delivery = { id: exposure.id };
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
  const delivery = { id: preview.id };
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
        action === 'publish' ? publishes(device, exposure) : reads(device, location, exposure)
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
 * a kind without one, and the provider's refusal of a protocol it cannot connect by.
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

/** What a reader asks of a stream: the protocols it can play, in its order of preference. */
export interface StreamAsk {
  protocols: string[];
}

/** A gateway as a delivery candidate's connection is made at it: what `selectGateway` reads. */
type CandidateGateway = Awaited<ReturnType<typeof selectGateway>>;

/**
 * The stream's exposures as delivery candidates (src/gateways/delivery.ts), as the transaction sees them, with the
 * gateways they are at, and whether the stream is pushed (it has no source of its own).
 */
async function streamCandidates(location: StreamLocation, pushed: boolean) {
  const db = useDB();
  const { organisationId, streamId } = location;
  const rows = await db
    .select({ id: exposures.id, gatewayId: exposures.gatewayId })
    .from(exposures)
    .where(and(eq(exposures.organisationId, organisationId), eq(exposures.streamId, streamId)))
    .orderBy(exposures.id);
  const own = await db
    .select({ id: gateways.id, kind: gateways.kind, networkId: gateways.networkId, settings: gateways.settings })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId));
  const subjectIds = rows.map(row => exposureSubject(row.id));
  const states = new Map((await listSubjectStates(organisationId, { subjectIds })).map(row => [row.subjectId, row]));
  const registered = await selectRegisteredProtocols(organisationId);
  const at = new Map<string, CandidateGateway>();
  const candidates = rows.flatMap((row): DeliveryCandidate[] => {
    const gateway = isBuiltinGateway(row.gatewayId)
      ? { id: row.gatewayId, kind: BUILTIN_GATEWAYS[row.gatewayId].kind, networkId: null, settings: {} }
      : own.find(candidate => candidate.id === row.gatewayId);
    // An exposure's gateway is checked whenever either changes, so it is there; a kind with no provider is unread.
    if (gateway === undefined) return [];
    at.set(gateway.id, { id: gateway.id, kind: gateway.kind, settings: gateway.settings });
    const egress = egressOf(gateway, registered.get(gateway.id) ?? new Set());
    const failing = isFailing(states.get(exposureSubject(row.id)));
    const { networkId } = gateway;
    return [{ exposureId: row.id, gatewayId: row.gatewayId, networkId, egress, failing }];
  });
  return { candidates, gateways: at, pushed };
}
type StreamCandidates = Awaited<ReturnType<typeof streamCandidates>>;

/**
 * The protocols a gateway is read by that it has a server for now (`servedProtocols`): a MediaMTX gateway's only those
 * its agent registered, or its settings override, so a reader is never handed one to be refused `gateway_unavailable`.
 * None for a kind with no provider.
 */
function egressOf(gateway: CandidateGateway, registered: ReadonlySet<string>): string[] {
  try {
    const provider = gatewayProvider(gateway.id, gateway.kind);
    return servedProtocols(provider, 'egress', registered, gateway.settings);
  } catch {
    return [];
  }
}

/** Where an output's agent reads from: its device's network, and the one gateway its output reads from, if any. */
const READER_COLUMNS = { networkId: devices.networkId, inputGatewayId: outputs.inputGatewayId };

/** Where a device is, and the gateway its output reads from: trusted code. */
async function deviceReader(device: AuthenticatedDevice, protocols: string[]): Promise<DeliveryReader> {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select(READER_COLUMNS)
    .from(devices)
    .leftJoin(outputDevices, eq(outputDevices.deviceId, devices.id))
    .leftJoin(outputs, eq(outputs.id, outputDevices.outputId))
    .where(eq(devices.id, device.id));
  return { networkId: row?.networkId ?? null, inputGatewayId: row?.inputGatewayId ?? null, protocols };
}

/**
 * The outputs following the show that have an agent, each as its agent reads (`deviceReader`), as the transaction sees
 * them, oldest first: an output with no agent reads nothing.
 */
export function selectShowReaders(organisationId: string, showId: string): Promise<OutputReader[]> {
  const db = useDB();
  return db
    .select({ outputId: outputs.id, ...READER_COLUMNS })
    .from(outputs)
    .innerJoin(outputDevices, eq(outputDevices.outputId, outputs.id))
    .innerJoin(devices, eq(devices.id, outputDevices.deviceId))
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.showId, showId)))
    .orderBy(outputs.id);
}

/** Each gateway's network, as the transaction sees them: the built-in ones on the internet (null), then its own. */
export async function selectGatewayNetworks(organisationId: string): Promise<Map<string, string | null>> {
  const db = useDB();
  const own = await db
    .select({ id: gateways.id, networkId: gateways.networkId })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId));
  const builtin = BUILTIN_GATEWAY_IDS.map((id): [string, string | null] => [id, null]);
  const owned = own.map((gateway): [string, string | null] => [gateway.id, gateway.networkId]);
  return new Map([...builtin, ...owned]);
}

/**
 * The candidates, each with whether its gateway says it is live now, for a pushed stream with more than one: its
 * chains stand whether or not anyone publishes them (a phone by MoQ one day, by WebRTC the next), so the one being
 * published is the one to read. Asked outside any transaction, since it waits on the gateways; a camera's are left as
 * they are.
 */
async function withLiveness(read: StreamCandidates, organisationId: string, subject: string) {
  const { candidates, gateways: at, pushed } = read;
  if (!pushed || candidates.length < 2) return candidates;
  const answers = await Promise.all(
    [...at.values()].map(async gateway => {
      const deliveryIds = candidates.filter(c => c.gatewayId === gateway.id).map(c => c.exposureId);
      const ask = { organisationId, gatewayId: gateway.id, kind: gateway.kind, deliveryIds, subject };
      const answer = await askGateway(ask);
      return Object.entries(answer.live);
    })
  );
  const live = new Map(answers.flat());
  return candidates.map(candidate => ({ ...candidate, live: live.get(candidate.exposureId) ?? null }));
}

/**
 * Which of a stream's deliveries the caller may read from, and where it is, by the rules in src/gateways/delivery.ts.
 * A member reads in their request session, so row-level security decides visibility (`not_found`), from the internet.
 * A device reads as trusted code, from its own network and the internet, only as the agent of one of the stream's
 * organisation's outputs that may play it (`forbidden` otherwise), and only from its output's input gateway when that
 * names one.
 */
async function callerStreamCandidates(location: StreamLocation, ask: StreamAsk) {
  const caller = usePrincipal();
  const subject = `${caller.kind}:${caller.id}`;
  if (caller.kind === 'device') {
    const device = useDevice();
    if (device.organisationId !== location.organisationId) throw new ApiFailure('not_found');
    const read = await trustedTransaction(async () => {
      const stream = await getStream(location.organisationId, location.streamId);
      if (stream === undefined) throw new ApiFailure('not_found');
      if (!(await outputReads(device.id, location))) throw new ApiFailure('forbidden');
      const reader = await deviceReader(device, ask.protocols);
      return { reader, ...(await streamCandidates(location, stream.sourceDeviceId === null)) };
    });
    return { subject, ...read };
  }
  const read = await transaction(async () => {
    const stream = await getStream(location.organisationId, location.streamId);
    if (stream === undefined) throw new ApiFailure('not_found');
    return streamCandidates(location, stream.sourceDeviceId === null);
  });
  const reader: DeliveryReader = { networkId: null, inputGatewayId: null, protocols: ask.protocols };
  return { subject, reader, ...read };
}

/**
 * Read a stream by whatever delivers it: the exposure chosen for the caller (`no_delivery` when none suits it), the
 * gateway it is at, and how to connect to it there by the first protocol the caller named that it is read by.
 */
export async function connectStream(location: StreamLocation, ask: StreamAsk) {
  const read = await callerStreamCandidates(location, ask);
  const candidates = await withLiveness(read, location.organisationId, read.subject);
  const chosen = chooseDelivery(candidates, read.reader);
  if (chosen === undefined) throw new ApiFailure('no_delivery');
  const { candidate, protocol } = chosen;
  const gateway = read.gateways.get(candidate.gatewayId)!;
  const delivery = { id: candidate.exposureId };
  const target = { organisationId: location.organisationId, subject: read.subject, delivery, gateway };
  const connection = await connectTarget(target, { action: 'read', protocol });
  return { exposureId: candidate.exposureId, gatewayId: gateway.id, connection };
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
