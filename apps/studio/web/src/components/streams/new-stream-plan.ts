import type { Camera, Device, Network, Rendition } from '@conservationtv/studio-sdk';

import type { ListedGateway } from '@/components/streams/stream-detail';
import { layoutTopology, type NodeStatus, type Topology } from '@/components/streams/topology';

// What a new stream's form will make, before it is made: its deliveries as exposures in the order they are created,
// each fed and published the way the agents deliver today (apps/studio/api/src/configuration/plan/helpers.ts): a
// network's active agent delivers its own MediaMTX gateway's exposures unpinned, and anything pinned to it. So a
// delivery on a network is fed by the source and left unpinned, and one on the internet is fed by the first delivery
// on a network if there is one, and pinned to that network's active agent. A publisher's stream (no camera) pins
// whatever device publishes it to the deliveries it feeds directly.

export type SourceKind = 'camera' | 'publisher';

/** A delivery chosen in the form: a gateway, and the renditions it is to offer. */
export interface ChosenDelivery {
  gatewayId: string;
  renditions: Rendition[];
}

/** An exposure to create. `upstreamGatewayId` names the planned exposure that feeds it, by its gateway. */
export interface PlannedDelivery {
  gatewayId: string;
  name: string;
  upstreamGatewayId: string | null;
  renditions: Rendition[];
  publisherDeviceId: string | null;
}

export interface DeliveryPlanInputs {
  source: SourceKind;
  camera: Camera | undefined;
  publisherDeviceId: string | null;
  deliveries: ChosenDelivery[];
  gateways: ListedGateway[];
  networks: Network[];
}

export interface DeliveryPlan {
  /** In the order they are made: everything on a network before what it feeds on the internet. */
  deliveries: PlannedDelivery[];
  /** The delivery on a network that feeds those on the internet, if any is chosen. */
  feeder: PlannedDelivery | undefined;
  /** What would be refused, by the gateway of the delivery it is about. */
  problems: Map<string, string>;
  /** Deliveries that would be made but that nothing would send yet, and why, by gateway. */
  unsent: Map<string, string>;
}

/** The exposures the chosen deliveries become, with what feeds and publishes each, and anything the API would refuse. */
export function planDeliveries({
  source,
  publisherDeviceId,
  deliveries,
  gateways,
  networks,
  camera
}: DeliveryPlanInputs) {
  const gatewayOf = (id: string) => gateways.find(gateway => gateway.id === id);
  const chosen = deliveries.filter(delivery => gatewayOf(delivery.gatewayId) !== undefined);
  const pinned = source === 'publisher' ? publisherDeviceId : null;
  const local = chosen
    .filter(delivery => gatewayOf(delivery.gatewayId)?.networkId !== null)
    .map(delivery => planned(delivery, gatewayOf(delivery.gatewayId), null, delivery.renditions, pinned));
  const feeder = local[0];
  const feederNetworkId = feeder ? gatewayOf(feeder.gatewayId)?.networkId : camera?.device?.networkId;
  const agentId = networks.find(network => network.id === feederNetworkId)?.activeAgent?.id ?? null;
  const problems = new Map<string, string>();
  const internet = chosen
    .filter(delivery => gatewayOf(delivery.gatewayId)?.networkId === null)
    .map(delivery => {
      // Fed by a delivery on a network, it offers at most what that one does.
      const renditions = feeder
        ? delivery.renditions.filter(rendition => feeder.renditions.includes(rendition))
        : delivery.renditions;
      if (feeder && renditions.length === 0) {
        problems.set(delivery.gatewayId, `Choose one of the renditions ${feeder.name} offers.`);
      }
      const publisher = feeder || source === 'camera' ? agentId : pinned;
      return planned(delivery, gatewayOf(delivery.gatewayId), feeder?.gatewayId ?? null, renditions, publisher);
    });
  const ordered = [...local, ...internet];
  const sendingNetwork = networks.find(network => network.id === feederNetworkId);
  const unsent = unsentOf(ordered, { source, gateways, networks, sendingNetwork });
  return { deliveries: ordered, feeder, problems, unsent } satisfies DeliveryPlan;
}

/** What deciding whether a delivery will be sent reads, beside the delivery. */
interface SendingInputs {
  source: SourceKind;
  gateways: ListedGateway[];
  networks: Network[];
  /** The network whose active agent sends to the internet: the feeding delivery's, or the camera's. */
  sendingNetwork: Network | undefined;
}

/**
 * Deliveries nothing would send, and why. An agent sends what is pinned to it, and serves its own network's MediaMTX
 * gateway unpinned when it is the network's active agent; anything else unpinned waits for a publisher.
 */
function unsentOf(deliveries: PlannedDelivery[], { source, gateways, networks, sendingNetwork }: SendingInputs) {
  const unsent = new Map<string, string>();
  for (const delivery of deliveries.filter(({ publisherDeviceId }) => publisherDeviceId === null)) {
    const network = networks.find(({ id }) => id === gateways.find(({ id }) => id === delivery.gatewayId)?.networkId);
    // An unpinned delivery on a network is served by that network's active agent, when it has one.
    if (source === 'camera' && network?.activeAgent) continue;
    unsent.set(delivery.gatewayId, unsentReason(source, network, sendingNetwork));
  }
  return unsent;
}

/** Why nothing would send a delivery: no publisher pinned, or no active agent on the network it would come from. */
function unsentReason(source: SourceKind, network: Network | undefined, sendingNetwork: Network | undefined): string {
  if (source === 'publisher') return 'Nothing sends it here until a publisher is pinned to it.';
  if (network) return `Nothing serves it yet: ${network.name} has no active agent.`;
  if (sendingNetwork) return `Nothing sends it here yet: ${sendingNetwork.name} has no active agent to send it.`;
  return 'Nothing sends it here until a camera is chosen.';
}

function planned(
  delivery: ChosenDelivery,
  gateway: ListedGateway | undefined,
  upstreamGatewayId: string | null,
  renditions: Rendition[],
  publisherDeviceId: string | null
): PlannedDelivery {
  return {
    gatewayId: delivery.gatewayId,
    name: gateway?.name ?? 'Unknown gateway',
    upstreamGatewayId,
    renditions,
    publisherDeviceId
  };
}

export interface DraftTopologyInputs {
  sourceDeviceId: string | null;
  plan: PlannedDelivery[];
  devices: Device[];
  gateways: ListedGateway[];
  networks: Network[];
}

/** The plan drawn as the stream's page will draw it, each planned exposure standing in by its gateway's ID. */
export function draftTopology({ sourceDeviceId, plan, devices, gateways, networks }: DraftTopologyInputs) {
  const stream = {
    sourceDeviceId,
    exposures: plan.map(delivery => ({
      id: delivery.gatewayId,
      gatewayId: delivery.gatewayId,
      upstreamExposureId: delivery.upstreamGatewayId
    })),
    recorders: []
  };
  const topology: Topology = layoutTopology({ stream, devices, gateways, networks });
  // Nothing has reported about a stream that doesn't exist yet.
  const statuses = new Map<string, NodeStatus>(topology.nodes.map(node => [node.id, 'unknown']));
  return { topology, statuses };
}
