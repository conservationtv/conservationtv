import {
  channelSubject,
  deviceSubject,
  exposureSubject,
  forwardSubject,
  previewSubject,
  programSubject,
  recorderSubject
} from '@conservationtv/reports';
import type { Activity, Health } from './health.ts';

// An organisation's status: what its subjects' states add up to, worked out from its topology. Each subject's own
// status comes from its state; then failures flow along the signal's path, so what a failing subject feeds is
// `affected` rather than a problem of its own; then each stream, show, output and channel is summed up from its parts,
// and the organisation from those. The problems are only the root causes: what is failing or degraded itself, each
// with why, and what it affects.
//
//   camera ─▶ exposure ─▶ exposure …          a stream: its source, then each delivery along the chain it publishes from
//   agent ─▶ programme ─▶ forward ─▶ channel  an output: its agent, its programme, and where that goes
//                      ├▶ preview
//                      └▶ recorder
//
// A show is the streams its state places (`placedStreams`, src/shows/resolve.ts): each one's source and deliveries.
// Pure: from the lists as they are read, and the states.
//
// A state only says something while something is set to report about its subject: an output's parts while an agent
// runs the output, a delivery while an agent delivers it (the one it is pinned to, the active agent on its gateway's
// network, or whichever delivers the exposure it is published from) or, on a relay that publishes stats, while the
// organisation has an active agent to cover it (src/configuration/plan/helpers.ts, `selectRelayCoverage`), a camera while an agent delivering one of its
// streams probes it, a channel while an output with an agent forwards to it. A camera that is switched off feeds
// nothing and is probed by nothing, so neither it nor its streams' deliveries are set to report; nor is a forward that
// is switched off, which its output's agent isn't sent. With nothing set to, silence is not a failure, and whatever was
// last said is history: the subject is `off`, and says why.

/**
 * How a subject is doing, its upstream considered. `healthy`, `degraded` and `failing` are its own (`failing` is
 * reporting unhealthy, or gone quiet); `affected` is fed by something failing; `idle` and `off` aren't judged, since
 * nothing asks for it or it is switched off; `unknown` has reported nothing to judge by.
 */
export const STATUSES = ['healthy', 'degraded', 'failing', 'affected', 'idle', 'off', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];

/** A subject's state, as `organisations.subjects.states.list` reads it. */
export interface StateInput {
  subjectId: string;
  health: Health;
  activity: Activity;
  freshness: 'fresh' | 'stale';
  observedAt: Date;
  state: StateFindings;
}
interface StateFindings {
  findings: FindingInput[];
}
interface FindingInput {
  health: Health;
  summary: string;
}

interface ExposureInput {
  id: string;
  gatewayId: string;
  upstreamExposureId: string | null;
  /** The device it is pinned to, when it is. */
  publisherDeviceId: string | null;
}
interface StreamInput {
  id: string;
  name: string;
  sourceDeviceId: string | null;
  exposures: ExposureInput[];
}
interface NamedInput {
  id: string;
  name: string;
}
interface ShowInput extends NamedInput {
  /** The streams its state places, by ID. */
  streams: string[];
}
interface OutputDeviceInput {
  deviceId: string;
}
interface ForwardInput {
  id: string;
  channelId: string;
  enabled: boolean;
}
interface PreviewInput {
  id: string;
  gatewayId: string;
}
interface OutputInput extends NamedInput {
  showId: string | null;
  device: OutputDeviceInput | null;
  forwards: ForwardInput[];
  previews: PreviewInput[];
  recorders: Identified[];
}
interface Identified {
  id: string;
}
interface DeviceInput extends NamedInput {
  kind: string;
}
/** A camera's state: only an `enabled` one feeds its streams, and is probed. */
interface CameraInput {
  id: string;
  state: string;
}

interface GatewayInput extends NamedInput {
  /** The network it is on: null on the internet. */
  networkId: string | null;
}
interface AgentInput {
  id: string;
  networkId: string;
  /** Whether it is its network's active agent: the one that runs its gateway. */
  active: boolean;
}

export interface StatusInputs {
  devices: DeviceInput[];
  cameras: CameraInput[];
  agents: AgentInput[];
  gateways: GatewayInput[];
  streams: StreamInput[];
  shows: ShowInput[];
  outputs: OutputInput[];
  channels: NamedInput[];
  states: StateInput[];
  /**
   * The gateways whose relays publish stats (conservation.tv), where every exposure is covered by an agent of the
   * organisation's while it has an active one. None when left out.
   */
  statsGatewayIds?: readonly string[];
}

/** One subject in the signal's path: what it is called, and what feeds it. */
interface Node {
  subjectId: string;
  /** What it is, in a word or two: `Camera`, `Delivery to London`. */
  kind: string;
  /** Whose it is: the device's, stream's or output's name. */
  name: string;
  /** The subjects that feed it. It is affected only when every one of them is down. */
  fedBy: string[];
  /** Why nothing is set to report about it, when nothing is: then it is off, whatever was last said of it. */
  unreported?: string;
}

/** A subject's status, and why. */
export interface SubjectStatus extends Node {
  status: Status;
  /** Its own status, before what feeds it is considered. */
  own: Status;
  /** Null when no state has been derived for it. */
  health: Health | null;
  activity: Activity | null;
  freshness: 'fresh' | 'stale' | null;
  /** What its state says is wrong, or why it isn't judged, in words. */
  reasons: string[];
  /** When affected, or degraded by what feeds it: the subjects upstream that are the cause. */
  causedBy: string[];
}

/** What a group of subjects (a stream, a show, an output, a channel) adds up to. */
export type GroupStatus = Exclude<Status, 'affected'>;

export interface Group {
  id: string;
  name: string;
  status: GroupStatus;
  /** The status in a sentence: `Delivering`, `Failing: Tortoise cam`. */
  summary: string;
  /** Its parts, in the order the signal reaches them. */
  subjectIds: string[];
  /** Its parts that are failing or degraded themselves. */
  causes: string[];
}

/** Something a problem affects. */
export interface Affected {
  kind: 'stream' | 'show' | 'output' | 'channel';
  id: string;
  name: string;
}

/** A root cause: a subject failing or degraded itself, why, and what that affects. */
export interface Problem {
  subjectId: string;
  kind: string;
  name: string;
  status: 'failing' | 'degraded';
  reasons: string[];
  affects: Affected[];
}

export interface OrganisationStatus {
  status: GroupStatus;
  /** The whole in a sentence or two. */
  summary: string;
  problems: Problem[];
  streams: Group[];
  shows: Group[];
  outputs: Group[];
  channels: Group[];
  subjects: SubjectStatus[];
}

/**
 * A subject's own status, from its state: gone quiet is failing, whatever it last said, unless nothing is set to
 * report about it, which is off. Something still reporting is as it says, set to or not.
 */
function ownStatus(state: StateInput | undefined, unreported: boolean): Status {
  if (unreported && state?.freshness !== 'fresh') return 'off';
  if (state === undefined) return 'unknown';
  if (state.activity === 'off') return 'off';
  if (state.freshness === 'stale') return 'failing';
  return state.activity === 'idle' ? 'idle' : HEALTH_STATUS[state.health];
}

/** Whether a subject is failing by its own state, whatever feeds it: reporting unhealthy, or gone quiet. */
export function isFailing(state: StateInput | undefined): boolean {
  return ownStatus(state, false) === 'failing';
}

/** A stream as `streamOffline` judges it: its source, and its deliveries. */
export interface StreamSubjectsInput {
  sourceDeviceId: string | null;
  exposures: Identified[];
}

/**
 * Whether a stream is offline to whoever reads it, as a show's card says (docs/shows.md): its source is failing, or
 * every delivery of it is, each by its own state (failing is reporting unhealthy, or gone quiet). A stream with no
 * deliveries, or one nothing has said anything of, is not: it may yet start.
 */
export function streamOffline(stream: StreamSubjectsInput, states: ReadonlyMap<string, StateInput>): boolean {
  const failing = (subjectId: string) => isFailing(states.get(subjectId));
  if (stream.sourceDeviceId !== null && failing(deviceSubject(stream.sourceDeviceId))) return true;
  return stream.exposures.length > 0 && stream.exposures.every(exposure => failing(exposureSubject(exposure.id)));
}

/** What each health is as a status, of a subject that is active and still reporting. */
const HEALTH_STATUS = {
  healthy: 'healthy',
  degraded: 'degraded',
  unhealthy: 'failing',
  unknown: 'unknown'
} satisfies Record<Health, Status>;

/**
 * Why a subject is as it is, in words: its findings that aren't healthy, that it has gone quiet, or why nothing is set
 * to report about it.
 */
function reasonsOf(node: Node, state: StateInput | undefined, own: Status): string[] {
  if (node.unreported !== undefined && state?.freshness !== 'fresh') return [node.unreported];
  if (state === undefined) return [];
  if (state.freshness === 'stale' && own === 'failing')
    return [`Stopped reporting: last heard from at ${state.observedAt.toISOString()}`];
  return state.state.findings.filter(finding => finding.health !== 'healthy').map(finding => finding.summary);
}

const DOWN = {
  healthy: false,
  degraded: false,
  failing: true,
  affected: true,
  idle: false,
  off: false,
  unknown: false
} satisfies Record<Status, boolean>;

/**
 * Whether each of a stream's exposures has an agent set to report about it: one that delivers it, or on a relay that
 * publishes stats, the organisation's agent covering what nobody delivers.
 */
function deliveredExposures(stream: StreamInput, inputs: StatusInputs): Set<string> {
  const { agents, gateways, statsGatewayIds = [] } = inputs;
  const delivered = new Set<string>();
  const byId = new Map(stream.exposures.map(exposure => [exposure.id, exposure]));
  const covered = agents.some(agent => agent.active);
  const isDelivered = (exposure: ExposureInput, seen: Set<string>): boolean => {
    // Pinned to a device; else on a network with an active agent, which runs its gateway; else, on a relay that
    // publishes stats, while any agent is active to cover it; else, on the internet, by whichever agent delivers the
    // exposure it is published from.
    if (exposure.publisherDeviceId !== null) return true;
    if (covered && statsGatewayIds.includes(exposure.gatewayId)) return true;
    const networkId = gateways.find(gateway => gateway.id === exposure.gatewayId)?.networkId ?? null;
    if (networkId !== null) return agents.some(agent => agent.networkId === networkId && agent.active);
    const upstream = byId.get(exposure.upstreamExposureId ?? '');
    if (upstream === undefined || seen.has(upstream.id)) return false;
    return isDelivered(upstream, new Set([...seen, exposure.id]));
  };
  for (const exposure of stream.exposures) if (isDelivered(exposure, new Set())) delivered.add(exposure.id);
  return delivered;
}

/** Whether a subject is in trouble: failing or degraded itself, or fed by something failing. */
const TROUBLED = {
  healthy: false,
  degraded: true,
  failing: true,
  affected: true,
  idle: false,
  off: false,
  unknown: false
} satisfies Record<Status, boolean>;

/** Why a camera isn't probed, nor its streams delivered, when it is switched off: undefined while it is on. */
function switchedOff(deviceId: string | null, cameras: CameraInput[]): string | undefined {
  const camera = cameras.find(candidate => candidate.id === deviceId);
  return camera !== undefined && camera.state !== 'enabled' ? 'Switched off' : undefined;
}

/**
 * A stream's source, when it has one the organisation still has: probed by whichever agent delivers the stream, unless
 * it is a camera that is switched off.
 */
function sourceNode(stream: StreamInput, { devices, cameras }: StatusInputs, probed: boolean): Node | undefined {
  const source = devices.find(device => device.id === stream.sourceDeviceId);
  if (source === undefined) return undefined;
  const kind = source.kind === 'camera' ? 'Camera' : 'Source';
  const unreported =
    switchedOff(source.id, cameras) ?? (probed ? undefined : 'No agent delivers its stream, so nothing probes it');
  return { subjectId: deviceSubject(source.id), kind, name: source.name, fedBy: [], unreported };
}

/** A stream's nodes: its source, then its exposures, each fed by its upstream, or the source without one. */
function streamNodes(stream: StreamInput, inputs: StatusInputs): Node[] {
  const delivered = deliveredExposures(stream, inputs);
  const source = sourceNode(stream, inputs, delivered.size > 0);
  // A camera that is switched off feeds none of its stream's deliveries: nothing is asked to deliver them.
  const cameraOff =
    switchedOff(stream.sourceDeviceId, inputs.cameras) === undefined ? undefined : 'Its camera is switched off';
  const exposures = stream.exposures.map((exposure): Node => {
    // Named for its gateway; fed by its upstream when the stream has it, else by the source when there is one.
    const gateway = inputs.gateways.find(candidate => candidate.id === exposure.gatewayId);
    const upstream = stream.exposures.find(candidate => candidate.id === exposure.upstreamExposureId);
    const feeder = upstream === undefined ? source?.subjectId : exposureSubject(upstream.id);
    return {
      subjectId: exposureSubject(exposure.id),
      kind: `Delivery to ${gateway?.name ?? 'a gateway'}`,
      name: stream.name,
      fedBy: feeder === undefined ? [] : [feeder],
      unreported: cameraOff ?? (delivered.has(exposure.id) ? undefined : 'No agent is set to deliver it')
    };
  });
  return source === undefined ? exposures : [source, ...exposures];
}

/** An output's agent, when it runs on one the organisation still has. */
function agentNode(output: OutputInput, devices: DeviceInput[]): Node | undefined {
  const agent = devices.find(device => device.id === output.device?.deviceId);
  if (agent === undefined) return undefined;
  return { subjectId: deviceSubject(agent.id), kind: 'Agent', name: agent.name, fedBy: [] };
}

/** Why nothing reports about an output's parts, when no agent runs it. */
function unrun(output: OutputInput): string | undefined {
  return output.device === null ? 'No agent runs its output' : undefined;
}

/** What an output's programme goes to: its forwards, previews and recorders, each fed by the programme. */
function programmeParts(output: OutputInput, { gateways, channels }: StatusInputs): Node[] {
  const fedBy = [programSubject(output.id)];
  const name = output.name;
  const unreported = unrun(output);
  const forwards = output.forwards.map((forward): Node => {
    const channel = channels.find(candidate => candidate.id === forward.channelId);
    const kind = `Forward to ${channel?.name ?? 'a channel'}`;
    // A forward that is switched off isn't sent to the output's agent, so nothing reports about it.
    const reason = forward.enabled ? unreported : 'Switched off';
    return { subjectId: forwardSubject(forward.id), kind, name, fedBy, unreported: reason };
  });
  const previews = output.previews.map((preview): Node => {
    const gateway = gateways.find(candidate => candidate.id === preview.gatewayId);
    const kind = `Preview at ${gateway?.name ?? 'a gateway'}`;
    return { subjectId: previewSubject(preview.id), kind, name, fedBy, unreported };
  });
  const recorders = output.recorders.map((recorder): Node => {
    return { subjectId: recorderSubject(recorder.id), kind: 'Recorder', name, fedBy, unreported };
  });
  return [...forwards, ...previews, ...recorders];
}

/** An output's nodes: its agent, its programme, then its forwards, previews and recorders. */
function outputNodes(output: OutputInput, inputs: StatusInputs): Node[] {
  const agent = agentNode(output, inputs.devices);
  const programme: Node = {
    subjectId: programSubject(output.id),
    kind: 'Programme',
    name: output.name,
    fedBy: agent === undefined ? [] : [agent.subjectId],
    unreported: unrun(output)
  };
  const before = agent === undefined ? [] : [agent];
  return [...before, programme, ...programmeParts(output, inputs)];
}

/** A channel's node: fed by every forward to it that is switched on, and reported by those outputs' agents. */
function channelNode(channel: NamedInput, outputs: OutputInput[]): Node {
  const feeding = outputs.flatMap(output =>
    output.forwards
      .filter(forward => forward.channelId === channel.id && forward.enabled)
      .map(forward => ({ forward, run: output.device !== null }))
  );
  return {
    subjectId: channelSubject(channel.id),
    kind: 'Channel',
    name: channel.name,
    fedBy: feeding.map(({ forward }) => forwardSubject(forward.id)),
    unreported: feeding.some(({ run }) => run) ? undefined : 'No output with an agent forwards to it'
  };
}

/** A node's status once what feeds it has settled. */
function settled(node: Node, state: StateInput | undefined, feeders: SubjectStatus[]): SubjectStatus {
  const own = ownStatus(state, node.unreported !== undefined);
  // Cut off: something feeds it, and all of it is down. Then whatever it says of itself is a consequence, so it is
  // affected rather than a failure of its own. Only what is switched off stays as it is, since it wasn't to be fed
  // anyway. Short of that, something degraded while what feeds it is in trouble too is degraded by that: it stays
  // degraded, but its cause is upstream, and it is no problem of its own. A failure with only a degraded feeder is
  // more than its feeder explains, so it is its own.
  const cut = feeders.length > 0 && feeders.every(feeder => DOWN[feeder.status]);
  const affected = cut && own !== 'off';
  const troubled = feeders.filter(feeder => TROUBLED[feeder.status]);
  const consequence = affected || (own === 'degraded' && troubled.length > 0);
  const roots = troubled.flatMap(feeder => (feeder.causedBy.length > 0 ? feeder.causedBy : [feeder.subjectId]));
  return {
    ...node,
    ...stateFields(state),
    status: affected ? 'affected' : own,
    own,
    reasons: reasonsOf(node, state, own),
    causedBy: consequence ? [...new Set(roots)] : []
  };
}

/** What a subject's status says of its state as it is: nothing, when none has been derived for it. */
function stateFields(state: StateInput | undefined): Pick<SubjectStatus, 'health' | 'activity' | 'freshness'> {
  if (state === undefined) return { health: null, activity: null, freshness: null };
  const { health, activity, freshness } = state;
  return { health, activity, freshness };
}

/** Every node's status, failures flowing downstream: a node every one of whose feeders is down is affected by them. */
function settle(nodes: Map<string, Node>, states: Map<string, StateInput>): Map<string, SubjectStatus> {
  const done = new Map<string, SubjectStatus>();
  const visit = (node: Node, path: Set<string>): SubjectStatus => {
    // Each node settles once, its feeders first. A feeder that isn't among the nodes, or that loops back to one on
    // the way here, feeds nothing known, and is left out.
    const known = done.get(node.subjectId);
    if (known !== undefined) return known;
    const onward = new Set([...path, node.subjectId]);
    const feeders = node.fedBy
      .filter(subjectId => !onward.has(subjectId))
      .flatMap(subjectId => {
        const feeder = nodes.get(subjectId);
        return feeder === undefined ? [] : [visit(feeder, onward)];
      });
    const status = settled(node, states.get(node.subjectId), feeders);
    done.set(node.subjectId, status);
    return status;
  };
  for (const node of nodes.values()) visit(node, new Set());
  return done;
}

/**
 * What a whole made of `statuses` is: failing when any part is down; otherwise degraded when any is; otherwise healthy
 * when any is, whatever else is idle, off or yet to report; otherwise idle, off, and at last unknown, as a whole of no
 * parts is.
 */
function overall(statuses: Status[]): GroupStatus {
  if (statuses.some(status => DOWN[status])) return 'failing';
  for (const status of ['degraded', 'healthy', 'idle', 'off'] as const) if (statuses.includes(status)) return status;
  return 'unknown';
}

/** What a group's status is called, for each kind of group. */
type Wording = Record<GroupStatus, string>;

const STREAM_WORDS = {
  healthy: 'Delivering',
  degraded: 'Delivering, degraded',
  failing: 'Failing',
  idle: 'Idle: nothing is asking for it',
  off: 'Switched off',
  unknown: 'No reports'
} satisfies Wording;
const SHOW_WORDS = {
  healthy: 'Every stream it places is delivering',
  degraded: 'A stream it places is degraded',
  failing: 'A stream it places is failing',
  idle: 'Nothing is watching the streams it places',
  off: 'The streams it places are switched off',
  unknown: 'No reports'
} satisfies Wording;
const OUTPUT_WORDS = {
  healthy: 'Going out',
  degraded: 'Going out, degraded',
  failing: 'Failing',
  idle: 'Idle',
  off: 'Switched off',
  unknown: 'No reports'
} satisfies Wording;
const CHANNEL_WORDS = {
  healthy: 'Live',
  degraded: 'Live, degraded',
  failing: 'Not live',
  idle: 'Idle',
  off: 'Nothing forwards to it',
  unknown: 'No reports'
} satisfies Wording;

/** Whether a subject is failing or degraded of itself, rather than because of something upstream of it. */
function isRootCause({ status, causedBy }: SubjectStatus): boolean {
  return (status === 'failing' || status === 'degraded') && causedBy.length === 0;
}

/** A group of `subjectIds`, summed up: its status, in words, with what is wrong named. */
function groupOf(named: NamedInput, subjectIds: string[], subjects: Map<string, SubjectStatus>, words: Wording): Group {
  const parts = subjectIds.flatMap(subjectId => subjects.get(subjectId) ?? []);
  const status = overall(parts.map(part => part.status));
  // What is wrong with it: its own parts first, then whatever upstream its parts are affected by.
  const wrong = parts.filter(isRootCause);
  const upstream = parts.flatMap(part => part.causedBy);
  const causes = [...new Set([...wrong.map(part => part.subjectId), ...upstream])];
  const names = causes.flatMap(subjectId => {
    const cause = subjects.get(subjectId);
    return cause === undefined ? [] : [`${cause.kind} (${cause.name})`];
  });
  const summary = names.length === 0 ? words[status] : `${words[status]}: ${names.join(', ')}`;
  return { id: named.id, name: named.name, status, summary, subjectIds, causes };
}

/** The subjects of the streams a show places, in its order: each stream's source, then its deliveries. */
function placedSubjects(show: ShowInput, perStream: readonly StreamNodes[]): string[] {
  return show.streams.flatMap(streamId => {
    const placed = perStream.find(({ stream }) => stream.id === streamId);
    return placed === undefined ? [] : placed.nodes.map(node => node.subjectId);
  });
}

/** A stream, and its nodes in the signal's path. */
interface StreamNodes {
  stream: StreamInput;
  nodes: Node[];
}

/** The groups a subject is a cause of, each as what a problem affects. */
function affectedBy(subjectId: string, groups: Record<Affected['kind'], Group[]>): Affected[] {
  const kinds = ['stream', 'show', 'output', 'channel'] as const;
  return kinds.flatMap(kind =>
    groups[kind]
      .filter(group => group.causes.includes(subjectId))
      .map(group => ({ kind, id: group.id, name: group.name }))
  );
}

/** How many of `groups` are of each status that says something, in words: `6 delivering, 2 idle`. */
function tally(groups: Group[], words: Partial<Record<GroupStatus, string>>): string {
  const order = ['failing', 'degraded', 'healthy', 'idle', 'off', 'unknown'] as const;
  const counted = order.flatMap(status => {
    const count = groups.filter(group => group.status === status).length;
    const word = words[status];
    return count === 0 || word === undefined ? [] : [`${count} ${word}`];
  });
  return counted.join(', ');
}

export function organisationStatus(inputs: StatusInputs): OrganisationStatus {
  const { devices, streams, shows, outputs, channels } = inputs;
  const states = new Map(inputs.states.map(state => [state.subjectId, state]));

  const perStream = streams.map((stream): StreamNodes => ({ stream, nodes: streamNodes(stream, inputs) }));
  const perOutput = outputs.map(output => ({ output, nodes: outputNodes(output, inputs) }));
  const perChannel = channels.map(channel => ({ channel, node: channelNode(channel, outputs) }));
  // An agent or a camera that nothing above reaches still has a status: an agent that serves a gateway, say. Other
  // devices, such as a browser, report nothing about themselves.
  const reporting = devices.filter(device => device.kind === 'agent' || device.kind === 'camera');
  const others = reporting.map((device): Node => {
    // A camera reached only here is no stream's source, so no agent probes it; an agent reports about itself.
    const camera = device.kind === 'camera';
    const unreported = camera
      ? (switchedOff(device.id, inputs.cameras) ?? 'No stream comes from it, so nothing probes it')
      : undefined;
    return {
      subjectId: deviceSubject(device.id),
      kind: camera ? 'Camera' : 'Agent',
      name: device.name,
      fedBy: [],
      unreported
    };
  });
  const every = [
    ...perStream.flatMap(each => each.nodes),
    ...perOutput.flatMap(each => each.nodes),
    ...perChannel.map(each => each.node),
    ...others
  ];
  // The first to name a subject says what it is: a camera as its stream's source, before as any device.
  const nodes = new Map<string, Node>();
  for (const node of every) if (!nodes.has(node.subjectId)) nodes.set(node.subjectId, node);
  const subjects = settle(nodes, states);

  const idsOf = (group: Node[]) => group.map(node => node.subjectId);
  const groups = {
    stream: perStream.map(({ stream, nodes: parts }) => groupOf(stream, idsOf(parts), subjects, STREAM_WORDS)),
    show: shows.map(show => groupOf(show, placedSubjects(show, perStream), subjects, SHOW_WORDS)),
    output: perOutput.map(({ output, nodes: parts }) => groupOf(output, idsOf(parts), subjects, OUTPUT_WORDS)),
    channel: perChannel.map(({ channel, node }) => groupOf(channel, [node.subjectId], subjects, CHANNEL_WORDS))
  };

  const problems = [...subjects.values()].flatMap((subject): Problem[] => {
    const { subjectId, kind, name, status, reasons } = subject;
    if (!isRootCause(subject) || (status !== 'failing' && status !== 'degraded')) return [];
    return [{ subjectId, kind, name, status, reasons, affects: affectedBy(subjectId, groups) }];
  });
  // Failing first, each in the order the signal reaches it.
  problems.sort((a, b) => Number(b.status === 'failing') - Number(a.status === 'failing'));

  const status = overall([...subjects.values()].map(subject => subject.status));
  const failing = problems.filter(problem => problem.status === 'failing').length;
  const degraded = problems.length - failing;
  const headline =
    problems.length === 0
      ? 'Nothing that is asked for is failing'
      : [failing > 0 ? `${failing} failing` : '', degraded > 0 ? `${degraded} degraded` : '']
          .filter(part => part !== '')
          .join(', ');
  const parts = [
    [
      'Streams',
      tally(groups.stream, {
        failing: 'failing',
        degraded: 'degraded',
        healthy: 'delivering',
        idle: 'idle',
        off: 'off',
        unknown: 'not reporting'
      })
    ],
    [
      'Outputs',
      tally(groups.output, {
        failing: 'failing',
        degraded: 'degraded',
        healthy: 'going out',
        idle: 'idle',
        off: 'off',
        unknown: 'not reporting'
      })
    ],
    [
      'Channels',
      tally(groups.channel, {
        failing: 'not live',
        degraded: 'degraded',
        healthy: 'live',
        off: 'not forwarded to',
        unknown: 'not reporting'
      })
    ]
  ] as const;
  const detail = parts.filter(([, counted]) => counted !== '').map(([label, counted]) => `${label}: ${counted}`);
  const summary = [headline, ...detail].join('. ');

  return {
    status,
    summary,
    problems,
    streams: groups.stream,
    shows: groups.show,
    outputs: groups.output,
    channels: groups.channel,
    subjects: [...subjects.values()]
  };
}
