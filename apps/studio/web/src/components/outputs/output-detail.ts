import type { Agent, Channel, Network, Output, Show } from '@conservationtv/studio-sdk';

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

// An output as the studio shows it, worked out from the organisation's lists: what drives its scenes (the show it
// follows, or something outside the studio), the agent it runs on, its programme and how it is encoded, the channels it
// is forwarded to, the gateways it is previewed at and its recorder, each with its status; its topology to draw (the
// agent, its programme on the agent's network, then the forwards and previews it feeds); and one status for the whole
// output. Pure, so a list of outputs and an output's page agree.

export type OutputForward = Output['forwards'][number];
export type OutputPreview = Output['previews'][number];
export type OutputRecorder = Output['recorders'][number];

/** A subject's state, as `subjectStateListQueryOptions` lists it. */
interface SubjectStateInput extends SubjectStatusInput {
  subjectId: string;
}

export interface OutputDetailInputs {
  output: Output;
  shows: Show[];
  agents: Agent[];
  channels: Channel[];
  gateways: ListedGateway[];
  networks: Network[];
  states: SubjectStateInput[];
}

/** The agent that runs the output's OBS: the one the organisation lists, or a note that it has gone. */
export interface OutputAgent {
  deviceId: string;
  agent: Agent | undefined;
  name: string;
  status: NodeStatus;
}

/** One of the output's forwards, with the channel it goes to. */
export interface ForwardPart {
  forward: OutputForward;
  channel: Channel | undefined;
  /** The channel's name, or a note when it has gone. */
  name: string;
  status: NodeStatus;
}

/** One of the output's previews, with the gateway it is published to. */
export interface PreviewPart {
  preview: OutputPreview;
  gateway: ListedGateway | undefined;
  /** The gateway's name, or a note when it has gone. */
  name: string;
  /** The network its gateway is on, by name: null on the internet. */
  network: string | null;
  status: NodeStatus;
}

/** The whole output's status: how its worst part is doing, or why it isn't going out. */
export interface OutputLiveness {
  status: NodeStatus;
  label: string;
}

export interface OutputDetail {
  output: Output;
  /** The show it follows, under `show` control: undefined for none, or one the organisation no longer lists. */
  show: Show | undefined;
  /** Its programme's encoding, in a few characters: "1080p30 · 6000 kbps". */
  encoding: string;
  agent: OutputAgent | null;
  programmeStatus: NodeStatus;
  forwards: ForwardPart[];
  previews: PreviewPart[];
  /** Its recorder: an output has at most one of each kind, and `obs` is the only kind. */
  recorder: OutputRecorder | undefined;
  /** How its recorder reports itself: unknown with none, or nothing reported. */
  recorderStatus: NodeStatus;
  /** How many channels it is sent to now: its forwards that are on. */
  liveForwardCount: number;
  topology: Topology;
  statuses: Map<string, NodeStatus>;
  liveness: OutputLiveness;
}

/** An output's programme encoding as a short label: its height and frame rate, then its bitrate. */
export function encodingOf(output: Pick<Output, 'height' | 'fps' | 'bitrateKbps'>): string {
  return `${output.height}p${output.fps} · ${output.bitrateKbps} kbps`;
}

const AGENT_ID = 'agent';
const PROGRAMME_ID = 'programme';

/** The output laid out, each part's status from its subject's state flowing downstream, and one status for it all. */
export function outputDetailOf({
  output,
  shows,
  agents,
  channels,
  gateways,
  networks,
  states
}: OutputDetailInputs): OutputDetail {
  const stateOf = new Map(states.map(state => [state.subjectId, state]));
  const outputAgent = output.device ? agents.find(agent => agent.id === output.device?.deviceId) : undefined;
  const topology = placeTopology(outputNodes({ output, outputAgent, channels, gateways }), networks);
  const own = new Map(topology.nodes.map(node => [node.id, ownStatus(stateOf.get(node.subjectId))]));
  const statuses = statusesOf(topology.nodes, own);
  const statusOf = (id: string): NodeStatus => statuses.get(id) ?? 'unknown';
  const forwards = output.forwards.map(forward => forwardPartOf(forward, channels, statusOf(forward.id)));
  const previews = output.previews.map(preview => previewPartOf(preview, gateways, networks, statusOf(preview.id)));
  const recorder = output.recorders[0];
  const agent = output.device && {
    deviceId: output.device.deviceId,
    agent: outputAgent,
    name: outputAgent?.device?.name ?? 'Removed agent',
    status: statusOf(AGENT_ID)
  };
  return {
    output,
    show: shows.find(show => show.id === output.showId),
    encoding: encodingOf(output),
    agent,
    programmeStatus: statusOf(PROGRAMME_ID),
    forwards,
    previews,
    recorder,
    recorderStatus: recorder ? ownStatus(stateOf.get(recorderSubjectId(recorder.id))) : 'unknown',
    liveForwardCount: output.forwards.filter(forward => forward.enabled).length,
    topology,
    statuses,
    liveness: livenessOf(output, topology, statuses)
  };
}

/** A forward with its channel, named for it: a channel removed since is named as such. */
function forwardPartOf(forward: OutputForward, channels: Channel[], status: NodeStatus): ForwardPart {
  const channel = channels.find(candidate => candidate.id === forward.channelId);
  return { forward, channel, name: channel?.name ?? 'Removed channel', status };
}

/** A preview with its gateway and the network that is on, named for the gateway: one removed since is named as such. */
function previewPartOf(
  preview: OutputPreview,
  gateways: ListedGateway[],
  networks: Network[],
  status: NodeStatus
): PreviewPart {
  const gateway = gateways.find(candidate => candidate.id === preview.gatewayId);
  const network = networks.find(candidate => candidate.id === gateway?.networkId);
  return { preview, gateway, name: gateway?.name ?? 'Unknown gateway', network: network?.name ?? null, status };
}

/** What laying an output out reads. */
interface OutputNodeInputs {
  output: Output;
  outputAgent: Agent | undefined;
  channels: Channel[];
  gateways: ListedGateway[];
}

/**
 * The output's nodes before they are placed: its agent, its programme on the agent's network, then each forward and
 * each preview the programme feeds. Without an agent nothing makes the programme, so there is nothing to draw.
 */
function outputNodes({ output, outputAgent, channels, gateways }: OutputNodeInputs): UnplacedNode[] {
  if (!output.device) return [];
  const networkId = outputAgent?.device?.networkId ?? outputAgent?.networkId ?? null;
  const agent: UnplacedNode = {
    id: AGENT_ID,
    subjectId: deviceSubjectId(output.device.deviceId),
    label: outputAgent?.device?.name ?? 'Removed agent',
    kind: 'server',
    networkId,
    parentId: null,
    recording: false,
    off: false
  };
  const programme: UnplacedNode = {
    id: PROGRAMME_ID,
    subjectId: programSubjectId(output.id),
    label: `Programme · ${output.height}p${output.fps}`,
    kind: 'programme',
    networkId,
    parentId: AGENT_ID,
    recording: output.recorders.length > 0,
    off: false
  };
  const forwards = output.forwards.map((forward): UnplacedNode => {
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
  const previews = output.previews.map((preview): UnplacedNode => {
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
  return [agent, programme, ...previews, ...forwards];
}

/**
 * The output's status. Without an agent it isn't going out at all. Anything failing says so first; then it is going
 * out once every part that is on reports healthy. Otherwise nothing has reported yet.
 */
function livenessOf(output: Output, topology: Topology, statuses: Map<string, NodeStatus>): OutputLiveness {
  if (!output.device) return { status: 'unknown', label: 'No agent' };
  const on = topology.nodes.filter(node => !node.off).map(node => statuses.get(node.id) ?? 'unknown');
  if (on.some(status => status === 'failing' || status === 'affected')) return { status: 'failing', label: 'Failing' };
  if (on.every(status => status === 'ok')) return { status: 'ok', label: 'Going out' };
  return { status: 'unknown', label: 'No reports' };
}
