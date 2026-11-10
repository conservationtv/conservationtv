import type { Agent, Channel, Network, Show } from '@conservationtv/studio-sdk';

import {
  deviceSubjectId,
  forwardSubjectId,
  previewSubjectId,
  programSubjectId,
  recorderSubjectId
} from '@/components/devices/subjects';
import type { ListedGateway } from '@/components/gateways/gateways';
import {
  ownStatus,
  placeTopology,
  statusesOf,
  type NodeStatus,
  type SubjectStatusInput,
  type Topology,
  type UnplacedNode
} from '@/components/streams/topology';

// A show as the studio shows it, worked out from the organisation's lists: its output agent, its programme and how it
// is encoded, the channels it is forwarded to, the gateways it is previewed at and its recorder, each with its status;
// its topology to draw (the output agent, its programme on the agent's network, then the forwards and previews it
// feeds); and one status for the whole show. Pure, so a list of shows and a show's page agree.

export type ShowForward = Show['forwards'][number];
export type ShowPreview = Show['previews'][number];
export type ShowRecorder = Show['recorders'][number];

/** A subject's state, as `subjectStateListQueryOptions` lists it. */
interface SubjectStateInput extends SubjectStatusInput {
  subjectId: string;
}

export interface ShowDetailInputs {
  show: Show;
  agents: Agent[];
  channels: Channel[];
  gateways: ListedGateway[];
  networks: Network[];
  states: SubjectStateInput[];
}

/** The agent that runs OBS for the show: the one the organisation lists, or a note that it has gone. */
export interface OutputAgent {
  deviceId: string;
  agent: Agent | undefined;
  name: string;
  status: NodeStatus;
}

/** One of the show's forwards, with the channel it goes to. */
export interface ForwardPart {
  forward: ShowForward;
  channel: Channel | undefined;
  /** The channel's name, or a note when it has gone. */
  name: string;
  status: NodeStatus;
}

/** One of the show's previews, with the gateway it is published to. */
export interface PreviewPart {
  preview: ShowPreview;
  gateway: ListedGateway | undefined;
  /** The gateway's name, or a note when it has gone. */
  name: string;
  /** The network its gateway is on, by name: null on the internet. */
  network: string | null;
  status: NodeStatus;
}

/** The whole show's status: how its worst part is doing, or why it isn't going out. */
export interface ShowLiveness {
  status: NodeStatus;
  label: string;
}

export interface ShowDetail {
  show: Show;
  /** Its programme's encoding, in a few characters: "1080p30 · 6000 kbps". */
  encoding: string;
  output: OutputAgent | null;
  programmeStatus: NodeStatus;
  forwards: ForwardPart[];
  previews: PreviewPart[];
  /** Its recorder: a show has at most one of each kind, and `obs` is the only kind. */
  recorder: ShowRecorder | undefined;
  /** How its recorder reports itself: unknown with none, or nothing reported. */
  recorderStatus: NodeStatus;
  /** How many channels it is sent to now: its forwards that are on. */
  liveForwardCount: number;
  topology: Topology;
  statuses: Map<string, NodeStatus>;
  liveness: ShowLiveness;
}

/** A show's programme encoding as a short label: its height and frame rate, then its bitrate. */
export function encodingOf(show: Pick<Show, 'height' | 'fps' | 'bitrateKbps'>): string {
  return `${show.height}p${show.fps} · ${show.bitrateKbps} kbps`;
}

const OUTPUT_ID = 'output';
const PROGRAMME_ID = 'programme';

/** The show laid out, each part's status from its subject's state flowing downstream, and one status for it all. */
export function showDetailOf({ show, agents, channels, gateways, networks, states }: ShowDetailInputs): ShowDetail {
  const stateOf = new Map(states.map(state => [state.subjectId, state]));
  const outputAgent = show.output ? agents.find(agent => agent.id === show.output?.deviceId) : undefined;
  const topology = placeTopology(showNodes({ show, outputAgent, channels, gateways }), networks);
  const own = new Map(topology.nodes.map(node => [node.id, ownStatus(stateOf.get(node.subjectId))]));
  const statuses = statusesOf(topology.nodes, own);
  const statusOf = (id: string): NodeStatus => statuses.get(id) ?? 'unknown';
  const forwards = show.forwards.map(forward => forwardPartOf(forward, channels, statusOf(forward.id)));
  const previews = show.previews.map(preview => previewPartOf(preview, gateways, networks, statusOf(preview.id)));
  const recorder = show.recorders[0];
  const output = show.output && {
    deviceId: show.output.deviceId,
    agent: outputAgent,
    name: outputAgent?.device?.name ?? 'Removed agent',
    status: statusOf(OUTPUT_ID)
  };
  return {
    show,
    encoding: encodingOf(show),
    output,
    programmeStatus: statusOf(PROGRAMME_ID),
    forwards,
    previews,
    recorder,
    recorderStatus: recorder ? ownStatus(stateOf.get(recorderSubjectId(recorder.id))) : 'unknown',
    liveForwardCount: show.forwards.filter(forward => forward.enabled).length,
    topology,
    statuses,
    liveness: livenessOf(show, topology, statuses)
  };
}

/** A forward with its channel, named for it: a channel removed since is named as such. */
function forwardPartOf(forward: ShowForward, channels: Channel[], status: NodeStatus): ForwardPart {
  const channel = channels.find(candidate => candidate.id === forward.channelId);
  return { forward, channel, name: channel?.name ?? 'Removed channel', status };
}

/** A preview with its gateway and the network that is on, named for the gateway: one removed since is named as such. */
function previewPartOf(
  preview: ShowPreview,
  gateways: ListedGateway[],
  networks: Network[],
  status: NodeStatus
): PreviewPart {
  const gateway = gateways.find(candidate => candidate.id === preview.gatewayId);
  const network = networks.find(candidate => candidate.id === gateway?.networkId);
  return { preview, gateway, name: gateway?.name ?? 'Unknown gateway', network: network?.name ?? null, status };
}

/** What laying a show out reads. */
interface ShowNodeInputs {
  show: Show;
  outputAgent: Agent | undefined;
  channels: Channel[];
  gateways: ListedGateway[];
}

/**
 * The show's nodes before they are placed: its output agent, its programme on the agent's network, then each forward
 * and each preview the programme feeds. Without an output nothing makes the programme, so there is nothing to draw.
 */
function showNodes({ show, outputAgent, channels, gateways }: ShowNodeInputs): UnplacedNode[] {
  if (!show.output) return [];
  const networkId = outputAgent?.device?.networkId ?? outputAgent?.networkId ?? null;
  const output: UnplacedNode = {
    id: OUTPUT_ID,
    subjectId: deviceSubjectId(show.output.deviceId),
    label: outputAgent?.device?.name ?? 'Removed agent',
    kind: 'server',
    networkId,
    parentId: null,
    recording: false,
    off: false
  };
  const programme: UnplacedNode = {
    id: PROGRAMME_ID,
    subjectId: programSubjectId(show.id),
    label: `Programme · ${show.height}p${show.fps}`,
    kind: 'programme',
    networkId,
    parentId: OUTPUT_ID,
    recording: show.recorders.length > 0,
    off: false
  };
  const forwards = show.forwards.map((forward): UnplacedNode => {
    // On the internet, under the programme, named and drawn for its channel, and off while it is switched off.
    const channel = channels.find(candidate => candidate.id === forward.channelId);
    return {
      id: forward.id,
      subjectId: forwardSubjectId(forward.id),
      label: channel?.name ?? 'Removed channel',
      kind: channel?.kind === 'twitch' ? 'twitch' : 'channel',
      networkId: null,
      parentId: PROGRAMME_ID,
      recording: false,
      off: !forward.enabled
    };
  });
  const previews = show.previews.map((preview): UnplacedNode => {
    // Under the programme, on its gateway's network (a server there) or on the internet (a cloud).
    const gateway = gateways.find(candidate => candidate.id === preview.gatewayId);
    const previewNetworkId = gateway?.networkId ?? null;
    return {
      id: preview.id,
      subjectId: previewSubjectId(preview.id),
      label: gateway?.name ?? 'Unknown gateway',
      kind: previewNetworkId ? 'server' : 'cloud',
      networkId: previewNetworkId,
      parentId: PROGRAMME_ID,
      recording: false,
      off: false
    };
  });
  return [output, programme, ...previews, ...forwards];
}

/**
 * The show's status. Without an output it isn't going out at all. Anything failing says so first; then it is going out
 * once every part that is on reports healthy. Otherwise nothing has reported yet.
 */
function livenessOf(show: Show, topology: Topology, statuses: Map<string, NodeStatus>): ShowLiveness {
  if (!show.output) return { status: 'unknown', label: 'No output' };
  const on = topology.nodes.filter(node => !node.off).map(node => statuses.get(node.id) ?? 'unknown');
  if (on.some(status => status === 'failing' || status === 'affected')) return { status: 'failing', label: 'Failing' };
  if (on.every(status => status === 'ok')) return { status: 'ok', label: 'Going out' };
  return { status: 'unknown', label: 'No reports' };
}
