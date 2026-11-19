import type { Topology } from '@conservationtv/studio-sdk';

import {
  channelSubjectId,
  deviceSubjectId,
  exposureSubjectId,
  forwardSubjectId,
  programSubjectId
} from '@/components/devices/subjects';
import type {
  SignalBroadcast,
  SignalChannel,
  SignalGateway,
  SignalNetwork,
  SignalSource,
  SignalStatus,
  SignalSystem
} from '@/components/signal/signal-system';
import { ownStatus, type SubjectStatusInput } from '@/components/streams/topology';

// The signal view's system from an organisation's real topology (`organisations.topology.get`): its outputs as the
// broadcasts, each a programme going out from OBS on an agent; each output's forwards as the channels they go out to;
// its networks with their active agents, the cameras on them and the other devices streams come from; and the
// internet-facing gateways its shows read them at. A source feeds the outputs following a show that places one of its
// streams (each show's `placed`), and none otherwise. An output driven from outside the studio follows no show, so
// nothing feeds it: it starts the way out on its own. Pure; the query that reads the topology hands it here.

type TopologyDevice = Topology['devices'][number];
type TopologyOutput = Topology['outputs'][number];

/** The built-in gateway a show reads its streams from (apps/studio/api/src/shows/broadcast.ts). */
const BROADCAST_GATEWAY = 'conservationtv';

/** Something's status from what its subject last reported. */
type StatusOf = (subjectId: string) => SignalStatus;

/**
 * Each subject's status from its state: as the studio's topology reads it (`ownStatus`), and degraded for a subject
 * the state consumer judges working, but not as it should, while it is still reporting.
 */
function statusesOf(topology: Topology): StatusOf {
  const states = new Map<string, SubjectStatusInput>(topology.states.map(state => [state.subjectId, state]));
  return subjectId => {
    const state = states.get(subjectId);
    if (state?.freshness === 'fresh' && state.health === 'degraded') return 'degraded';
    return ownStatus(state);
  };
}

const SEVERITY = { unknown: 0, ok: 1, degraded: 2, affected: 3, failing: 4 } satisfies Record<SignalStatus, number>;

/** The worst of `statuses`: unknown only when nothing is known, and when there are none. */
function worstStatus(statuses: SignalStatus[]): SignalStatus {
  return statuses.reduce<SignalStatus>((worst, each) => (SEVERITY[each] > SEVERITY[worst] ? each : worst), 'unknown');
}

/**
 * A source's status from its streams' deliveries, as the state consumer judges a stream by its parts: nothing reports
 * about a camera itself. A device no delivered stream comes from is as its own subject says, if anything does.
 */
function sourceStatusOf(topology: Topology, deviceId: string, statusOf: StatusOf): SignalStatus {
  const exposures = topology.streams
    .filter(stream => stream.sourceDeviceId === deviceId)
    .flatMap(stream => stream.exposures.map(exposure => statusOf(exposureSubjectId(exposure.id))));
  return exposures.length > 0 ? worstStatus(exposures) : statusOf(deviceSubjectId(deviceId));
}

/** What each show places: the streams it reads, and the gateway it reads each at. */
function placementsOf(topology: Topology) {
  return topology.shows.flatMap(show => {
    const placed = new Set(show.placed);
    return topology.streams.flatMap(stream =>
      stream.exposures
        .filter(exposure => placed.has(exposure.id))
        .map(exposure => ({ showId: show.id, stream, gatewayId: exposure.gatewayId }))
    );
  });
}

function broadcastOf(
  output: TopologyOutput,
  devices: Map<string, TopologyDevice>,
  statusOf: StatusOf
): SignalBroadcast {
  const agent = output.device ? devices.get(output.device.deviceId) : undefined;
  return {
    id: output.id,
    name: output.name,
    width: output.width,
    height: output.height,
    recording: output.recorders.length > 0,
    agent: agent?.name ?? 'No agent',
    // With no agent, nothing runs it to report on it.
    status: output.device ? statusOf(programSubjectId(output.id)) : 'unknown'
  };
}

/** An output's forwards, each as the channel it goes out to: a channel forwarded by two outputs is there twice. */
function channelsOf(topology: Topology, broadcasts: SignalBroadcast[], statusOf: StatusOf): SignalChannel[] {
  const channels = new Map(topology.channels.map(channel => [channel.id, channel]));
  const broadcastStatus = new Map(broadcasts.map(broadcast => [broadcast.id, broadcast.status]));
  return topology.outputs.flatMap(output =>
    output.forwards.flatMap((forward): SignalChannel[] => {
      const channel = channels.get(forward.channelId);
      if (!channel) return [];
      // How the forward to it is sending, and whether the platform has it live.
      const own = worstStatus([statusOf(forwardSubjectId(forward.id)), statusOf(channelSubjectId(channel.id))]);
      // Nothing reaches a channel whose output is down.
      const status = broadcastStatus.get(output.id) === 'failing' ? 'affected' : own;
      return [
        {
          id: forward.id,
          platform: channel.kind,
          handle: channel.kind === 'twitch' && channel.externalLogin ? `/${channel.externalLogin}` : channel.name,
          broadcast: output.id,
          status,
          // Nothing measures how well a channel receives yet: full while it reports healthy, one bar while degraded.
          level: status === 'ok' ? 3 : status === 'degraded' ? 1 : 0,
          off: !forward.enabled
        }
      ];
    })
  );
}

function networksOf(topology: Topology, devices: Map<string, TopologyDevice>, statusOf: StatusOf): SignalNetwork[] {
  return topology.networks.map(network => {
    const agent = network.activeAgent ? devices.get(network.activeAgent.id) : undefined;
    return {
      id: network.id,
      name: network.name,
      agent: agent?.name ?? 'No active agent',
      // With no active agent, nothing on the network is being looked after, nor known to be down.
      status: agent ? statusOf(deviceSubjectId(agent.id)) : 'unknown'
    };
  });
}

type Placement = ReturnType<typeof placementsOf>[number];

interface Rails {
  gateways: SignalGateway[];
  routes: Record<string, string>;
}

/** The network a stream's source is on: none for a stream with no source, or from a device on no network. */
function networkOf(stream: Placement['stream'], devices: Map<string, TopologyDevice>): string | null {
  if (stream.sourceDeviceId === null) return null;
  return devices.get(stream.sourceDeviceId)?.networkId ?? null;
}

/**
 * The internet-facing gateways the shows read their streams at, as rails: a gateway on a network (an agent's
 * MediaMTX, say) is how a stream leaves its site, not where a show reads it, so it is never one. The built-in
 * gateway comes first, and everything runs along it unless a route says otherwise; then any other gateway on the
 * internet that a placed stream is read at, as the route of the network that stream's camera is on. A network's first
 * such stream decides its route.
 */
function railsOf(topology: Topology, devices: Map<string, TopologyDevice>, placements: Placement[]): Rails {
  const builtin = topology.gateways.find(gateway => gateway.id === BROADCAST_GATEWAY);
  const first: SignalGateway = { id: BROADCAST_GATEWAY, name: builtin?.name ?? 'conservation.tv', hosted: true };
  const internet = new Map(
    topology.gateways.filter(gateway => gateway.networkId === null).map(gateway => [gateway.id, gateway])
  );
  const routes: Record<string, string> = {};
  const others: SignalGateway[] = [];
  for (const { stream, gatewayId } of placements) {
    // Read at the first rail, or somewhere not on the internet: nothing to add. Otherwise it is a rail of its own the
    // first time any stream is read there, and the route of its camera's network unless that has one already.
    const gateway = internet.get(gatewayId);
    if (!gateway || gateway.id === first.id) continue;
    if (!others.some(each => each.id === gateway.id))
      others.push({ id: gateway.id, name: gateway.name, hosted: gateway.builtin });
    const network = networkOf(stream, devices);
    if (network && routes[network] === undefined) routes[network] = gateway.id;
  }
  return { gateways: [first, ...others], routes };
}

/** The kind of source a device that streams come from is, as the view draws it. */
function sourceKindOf(device: TopologyDevice): SignalSource['kind'] {
  if (device.kind === 'camera') return 'camera';
  if (device.kind === 'browser') return 'browser';
  return 'rtmp';
}

export function signalSystemOf(topology: Topology): SignalSystem {
  const statusOf = statusesOf(topology);
  const devices = new Map(topology.devices.map(device => [device.id, device]));
  const placements = placementsOf(topology);
  const broadcasts = topology.outputs.map(output => broadcastOf(output, devices, statusOf));
  const networks = networksOf(topology, devices, statusOf);
  const networkAgents = new Map(networks.map(network => [network.id, network.agent]));

  // What a show places feeds the outputs following it; an output driven from outside follows none.
  const following = (showId: string) =>
    topology.outputs.filter(output => output.control === 'show' && output.showId === showId).map(output => output.id);
  const feedsOf = (deviceId: string) => [
    ...new Set(
      placements.filter(({ stream }) => stream.sourceDeviceId === deviceId).flatMap(({ showId }) => following(showId))
    )
  ];
  const sourceOf = (device: TopologyDevice, network: string | undefined): SignalSource => ({
    id: device.id,
    name: device.name,
    device: network ? (networkAgents.get(network) ?? '') : device.kind,
    kind: sourceKindOf(device),
    status: sourceStatusOf(topology, device.id, statusOf),
    feeds: feedsOf(device.id),
    network
  });

  // A camera on one of the networks sits in it; any other device a stream comes from pushes from anywhere.
  const onNetwork = (device: TopologyDevice) =>
    device.kind === 'camera' && device.networkId !== null && networkAgents.has(device.networkId);
  const cameras = topology.devices.filter(onNetwork).map(device => sourceOf(device, device.networkId ?? undefined));
  const streamed = new Set(topology.streams.flatMap(stream => (stream.sourceDeviceId ? [stream.sourceDeviceId] : [])));
  const ingests = topology.devices
    .filter(device => streamed.has(device.id) && !onNetwork(device))
    .map(device => sourceOf(device, undefined));

  const rails = railsOf(topology, devices, placements);
  return {
    channels: channelsOf(topology, broadcasts, statusOf),
    broadcasts,
    gateways: rails.gateways,
    networks,
    cameras,
    subgroups: [],
    ingests,
    routes: rails.routes
  };
}
