import type { Topology } from '@conservationtv/studio-sdk';

import { deviceSubjectId, forwardSubjectId, programSubjectId } from '@/components/devices/subjects';
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

// The signal view's system from an organisation's real topology (`organisations.topology.get`): its shows as the
// broadcasts, each show's forwards as the channels they go out to, its networks with their active agents, the cameras
// on them and the other devices streams come from, and the gateways the broadcast is reached through. Every show
// follows the organisation's one broadcast for now, so a source feeds every show when the broadcast places one of its
// streams, and none when it doesn't. Pure; the query that reads the topology hands it here.

type TopologyDevice = Topology['devices'][number];
type TopologyStream = Topology['streams'][number];
type TopologyShow = Topology['shows'][number];

/** The built-in gateway the broadcast reads its streams from (apps/studio/api/src/shows/broadcast.ts). */
const BROADCAST_GATEWAY = 'conservationtv';

/** Something's status from what its subject last reported. */
type StatusOf = (subjectId: string) => SignalStatus;

function statusesOf(topology: Topology): StatusOf {
  const states = new Map<string, SubjectStatusInput>(topology.states.map(state => [state.subjectId, state]));
  return subjectId => ownStatus(states.get(subjectId));
}

/** The gateways each placed stream's exposure is delivered through on its way to the broadcast, nearest it first. */
function chainOf(stream: TopologyStream, exposureId: string): string[] {
  const byId = new Map(stream.exposures.map(exposure => [exposure.id, exposure]));
  const gateways: string[] = [];
  // Each exposure is published from the one upstream of it; a chain never loops, but a missing link ends it.
  for (let exposure = byId.get(exposureId); exposure; exposure = byId.get(exposure.upstreamExposureId ?? '')) {
    gateways.push(exposure.gatewayId);
  }
  return gateways;
}

/** What the broadcast places: the streams it reads, and the gateways each is delivered through. */
function placementsOf(topology: Topology) {
  const placed = new Set(topology.broadcast.placed);
  return topology.streams.flatMap(stream =>
    stream.exposures
      .filter(exposure => placed.has(exposure.id))
      .map(exposure => ({ stream, gateways: chainOf(stream, exposure.id) }))
  );
}

function broadcastOf(show: TopologyShow, devices: Map<string, TopologyDevice>, statusOf: StatusOf): SignalBroadcast {
  const agent = show.output ? devices.get(show.output.deviceId) : undefined;
  return {
    id: show.id,
    name: show.name,
    width: show.width,
    height: show.height,
    recording: show.recorders.length > 0,
    agent: agent?.name ?? 'No output agent',
    // With no output, nothing runs it to report on it.
    status: show.output ? statusOf(programSubjectId(show.id)) : 'unknown'
  };
}

/** A show's forwards, each as the channel it goes out to: a channel forwarded by two shows is there twice. */
function channelsOf(topology: Topology, broadcasts: SignalBroadcast[], statusOf: StatusOf): SignalChannel[] {
  const channels = new Map(topology.channels.map(channel => [channel.id, channel]));
  const broadcastStatus = new Map(broadcasts.map(broadcast => [broadcast.id, broadcast.status]));
  return topology.shows.flatMap(show =>
    show.forwards.flatMap((forward): SignalChannel[] => {
      const channel = channels.get(forward.channelId);
      if (!channel) return [];
      const own = statusOf(forwardSubjectId(forward.id));
      // Nothing reaches a channel whose broadcast is down.
      const status = broadcastStatus.get(show.id) === 'failing' ? 'affected' : own;
      return [
        {
          id: forward.id,
          platform: channel.kind,
          handle: channel.kind === 'twitch' && channel.externalLogin ? `/${channel.externalLogin}` : channel.name,
          broadcast: show.id,
          status,
          // Nothing measures how well a channel receives yet: full while it reports healthy, empty otherwise.
          level: status === 'ok' ? 3 : 0,
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

/**
 * The gateways the broadcast is reached through, as rails: its own first, which everything is reached through unless
 * a route says otherwise; then any of the organisation's own gateways on a network, when a placed stream from a camera
 * there is delivered through it, as that network's route. A network's first such stream decides its route; a stream
 * from no network, or through no gateway on its network, keeps to the first rail.
 */
function railsOf(topology: Topology, devices: Map<string, TopologyDevice>, placements: Placement[]): Rails {
  const builtin = topology.gateways.find(gateway => gateway.id === BROADCAST_GATEWAY);
  const first: SignalGateway = { id: BROADCAST_GATEWAY, name: builtin?.name ?? 'conservation.tv', hosted: true };
  const routes: Record<string, string> = {};
  const onSite: SignalGateway[] = [];
  for (const { stream, gateways } of placements) {
    // Skip a stream from no network, or from one already routed; route the rest through the first gateway on their
    // chain that sits on their network, if any, adding it as a rail the first time it is a route.
    const network = stream.sourceDeviceId ? devices.get(stream.sourceDeviceId)?.networkId : null;
    if (!network || routes[network] !== undefined) continue;
    const gateway = topology.gateways.find(each => gateways.includes(each.id) && each.networkId === network);
    if (!gateway) continue;
    routes[network] = gateway.id;
    if (!onSite.some(each => each.id === gateway.id))
      onSite.push({ id: gateway.id, name: gateway.name, hosted: false });
  }
  return { gateways: [first, ...onSite], routes };
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
  const broadcasts = topology.shows.map(show => broadcastOf(show, devices, statusOf));
  const networks = networksOf(topology, devices, statusOf);
  const networkAgents = new Map(networks.map(network => [network.id, network.agent]));

  // Every show follows the one broadcast, so what it places feeds them all.
  const everyShow = broadcasts.map(broadcast => broadcast.id);
  const feeding = new Set(placements.flatMap(({ stream }) => (stream.sourceDeviceId ? [stream.sourceDeviceId] : [])));
  const sourceOf = (device: TopologyDevice, network: string | undefined): SignalSource => ({
    id: device.id,
    name: device.name,
    device: network ? (networkAgents.get(network) ?? '') : device.kind,
    kind: sourceKindOf(device),
    status: statusOf(deviceSubjectId(device.id)),
    feeds: feeding.has(device.id) ? everyShow : [],
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
