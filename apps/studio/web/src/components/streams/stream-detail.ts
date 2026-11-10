import type { Camera, Device, Gateway, Network, Stream } from '@conservationtv/studio-sdk';

import {
  layoutTopology,
  ownStatus,
  statusesOf,
  type NodeStatus,
  type SubjectStatusInput,
  type Topology
} from '@/components/streams/topology';

// One stream as its own page shows it: its topology and statuses as the list's cards draw them, its exposures as rows
// grouped the way the topology groups them (each network, then the internet), and one status for the whole stream.
// Pure, from the lists the page reads.

export type ListedGateway = Gateway['gateways'][number];
export type StreamExposure = Stream['exposures'][number];
export type StreamRecorder = Stream['recorders'][number];

/** A subject's state, as `subjectStateListQueryOptions` lists it. */
interface SubjectStateInput extends SubjectStatusInput {
  subjectId: string;
}

export interface StreamDetailInputs {
  stream: Stream;
  cameras: Camera[];
  devices: Device[];
  gateways: ListedGateway[];
  networks: Network[];
  states: SubjectStateInput[];
}

/** One exposure, with what the page says about it. */
export interface Delivery {
  exposure: StreamExposure;
  gateway: ListedGateway | undefined;
  /** Its gateway's name, or a note when the gateway has gone. */
  name: string;
  /** What feeds it: its upstream's gateway, or the source device. */
  fedBy: string;
  /** The device pinned to publish it, by name; null when the system chooses. */
  publisher: string | null;
  status: NodeStatus;
  recorded: boolean;
}

/** A network, or the internet, and the deliveries on it, in delivery order. */
export interface DeliverySection {
  networkId: string | null;
  label: string;
  deliveries: Delivery[];
}

/** The whole stream's status: how its worst part is doing, or why it isn't running. */
export interface Liveness {
  status: NodeStatus;
  label: string;
}

export interface StreamDetail {
  stream: Stream;
  topology: Topology;
  statuses: Map<string, NodeStatus>;
  liveness: Liveness;
  sections: DeliverySection[];
  /** The source device, when it has one the organisation still lists. */
  source: Device | undefined;
  /** The source's camera, when it is one. */
  sourceCamera: Camera | undefined;
}

/** The stream laid out, its nodes' statuses from their states, and its exposures grouped as the topology groups them. */
export function streamDetailOf({
  stream,
  cameras,
  devices,
  gateways,
  networks,
  states
}: StreamDetailInputs): StreamDetail {
  const topology = layoutTopology({ stream, devices, gateways, networks });
  const stateOf = new Map(states.map(state => [state.subjectId, state]));
  const own = new Map(topology.nodes.map(node => [node.id, ownStatus(stateOf.get(node.subjectId))]));
  const statuses = statusesOf(topology.nodes, own);
  const source = devices.find(device => device.id === stream.sourceDeviceId);
  const sourceCamera = cameras.find(camera => camera.id === stream.sourceDeviceId);
  const context: DeliveryContext = { stream, gateways, devices, statuses, source };
  const sections = topology.sections
    .map(section => ({
      networkId: section.networkId,
      label: section.label,
      deliveries: stream.exposures
        .filter(exposure => section.nodes.some(node => node.id === exposure.id))
        .map(exposure => deliveryOf(exposure, context))
    }))
    .filter(section => section.deliveries.length > 0);
  const liveness = livenessOf(stream, sourceCamera, [...statuses.values()]);
  return { stream, topology, statuses, liveness, sections, source, sourceCamera };
}

/** What describing an exposure reads. */
interface DeliveryContext {
  stream: Stream;
  gateways: ListedGateway[];
  devices: Device[];
  statuses: Map<string, NodeStatus>;
  source: Device | undefined;
}

/**
 * An exposure as a row: named for its gateway, with what feeds it and who sends it. Anything it names may have gone
 * since: a missing gateway is "Unknown gateway", and a publisher that isn't pinned (or no longer exists) is null.
 */
function deliveryOf(
  exposure: StreamExposure,
  { stream, gateways, devices, statuses, source }: DeliveryContext
): Delivery {
  const gateway = gateways.find(candidate => candidate.id === exposure.gatewayId);
  return {
    exposure,
    gateway,
    name: gateway?.name ?? 'Unknown gateway',
    fedBy: fedByOf(stream, exposure, gateways, source),
    publisher: devices.find(device => device.id === exposure.publisherDeviceId)?.name ?? null,
    status: statuses.get(exposure.id) ?? 'unknown',
    recorded: stream.recorders.some(recorder => recorder.exposureId === exposure.id)
  };
}

/** What feeds an exposure, by name: its upstream exposure's gateway, else the source, else whatever publishes it. */
function fedByOf(
  stream: Stream,
  exposure: StreamExposure,
  gateways: ListedGateway[],
  source: Device | undefined
): string {
  const upstream = stream.exposures.find(candidate => candidate.id === exposure.upstreamExposureId);
  if (upstream) return gateways.find(gateway => gateway.id === upstream.gatewayId)?.name ?? 'Unknown gateway';
  return source?.name ?? 'its publisher';
}

/**
 * The stream's status. Anything failing says so first; then a source that is switched off; then live once every part
 * reports healthy. Otherwise it has no source, or nothing has reported yet.
 */
function livenessOf(stream: Stream, camera: Camera | undefined, statuses: NodeStatus[]): Liveness {
  if (statuses.length === 0) return { status: 'unknown', label: 'Not set up' };
  if (statuses.some(status => status === 'failing' || status === 'affected')) {
    return { status: 'failing', label: 'Failing' };
  }
  if (camera && camera.state !== 'enabled') return { status: 'unknown', label: `Camera ${camera.state}` };
  if (statuses.every(status => status === 'ok')) return { status: 'ok', label: 'Live' };
  if (stream.sourceDeviceId === null) return { status: 'unknown', label: 'No source' };
  return { status: 'unknown', label: 'No reports' };
}

/** The exposures an exposure may be fed by: the stream's others, except any it feeds itself, which would loop. */
export function upstreamChoices(stream: Stream, exposureId: string | undefined): StreamExposure[] {
  if (exposureId === undefined) return stream.exposures;
  const downstream = new Set([exposureId]);
  // Grow the set of exposures fed, directly or not, by this one until no more join it.
  let grew = true;
  while (grew) {
    const joining = stream.exposures.filter(
      exposure =>
        !downstream.has(exposure.id) &&
        exposure.upstreamExposureId !== null &&
        downstream.has(exposure.upstreamExposureId)
    );
    for (const exposure of joining) downstream.add(exposure.id);
    grew = joining.length > 0;
  }
  return stream.exposures.filter(exposure => !downstream.has(exposure.id));
}

interface GatewayGroup {
  label: string;
  gateways: ListedGateway[];
}

/** The gateways by where they are: each network's, then the internet's. */
export function gatewayGroups(gateways: ListedGateway[], networks: Network[]): GatewayGroup[] {
  const onNetworks = networks.map(network => ({
    label: network.name,
    gateways: gateways.filter(gateway => gateway.networkId === network.id)
  }));
  const internet = { label: 'Internet', gateways: gateways.filter(gateway => gateway.networkId === null) };
  return [...onNetworks, internet].filter(group => group.gateways.length > 0);
}
