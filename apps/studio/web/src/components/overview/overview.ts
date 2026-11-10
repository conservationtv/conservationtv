import { deviceSubjectId, exposureSubjectId } from '@/components/devices/subjects';
import { isFed } from '@/components/streams/stream-page';
import { ownStatus, type SubjectStatusInput } from '@/components/streams/topology';

// The organisation's overview, worked out from its lists: how much of each thing there is, what is live, what is
// failing, and what a new organisation still has to set up. Pure derivation; the page reads the lists once, together.

interface ListedStream {
  id: string;
  name: string;
  sourceDeviceId: string | null;
  exposures: ListedExposure[];
}
interface ListedExposure {
  id: string;
  gatewayId: string;
}
interface ListedCamera {
  id: string;
  state: string;
  device: NamedDevice | null;
}
interface NamedDevice {
  name: string;
}
interface ListedAgent {
  id: string;
  active: boolean;
  device: NamedDevice | null;
}
interface ListedGateway {
  id: string;
  name: string;
}
interface ListedChannel {
  enabled: boolean;
}
interface ListedState extends SubjectStatusInput {
  subjectId: string;
}
interface Identified {
  id: string;
}

export interface OverviewInputs {
  streams: ListedStream[];
  cameras: ListedCamera[];
  agents: ListedAgent[];
  networks: Identified[];
  gateways: ListedGateway[];
  channels: ListedChannel[];
  states: ListedState[];
}

/** Something reporting unhealthy, or gone quiet: what it is, by name, and where to look at it. */
export interface Problem {
  /** The subject it is filed under: unique among problems. */
  subjectId: string;
  name: string;
  /** What kind of thing it is, in a word or two. */
  kind: string;
  /** The page to open, relative to the organisation. */
  to: string;
}

/** A step a new organisation takes on the way to its first stream, and whether it is done. */
export interface SetupStep {
  label: string;
  /** The page it is done on, relative to the organisation. */
  to: string;
  done: boolean;
}

export interface Overview {
  /** The streams being fed, as the streams page counts them active (`isFed`). */
  fedStreams: ListedStream[];
  streamCount: number;
  cameraCount: number;
  agentCount: number;
  activeAgentCount: number;
  networkCount: number;
  channelCount: number;
  channelsOn: number;
  problems: Problem[];
  /** How many subjects have reported at all: with none, "nothing failing" would say more than is known. */
  reportingCount: number;
  setup: SetupStep[];
}

/** A problem's subject and what it is, before any is known to be failing. */
type NamedSubject = [subjectId: string, subject: Omit<Problem, 'subjectId'>];

function cameraSubject(camera: ListedCamera): NamedSubject {
  return [
    deviceSubjectId(camera.id),
    { name: camera.device?.name ?? 'A camera', kind: 'Camera', to: `cameras/${camera.id}` }
  ];
}

function agentSubject(agent: ListedAgent): NamedSubject {
  return [
    deviceSubjectId(agent.id),
    { name: agent.device?.name ?? 'An agent', kind: 'Agent', to: `agents/${agent.id}` }
  ];
}

/** A stream's deliveries, each named for the stream and the gateway it goes to. */
function exposureSubjects(stream: ListedStream, gateways: ListedGateway[]): NamedSubject[] {
  return stream.exposures.map(exposure => {
    const gateway = gateways.find(candidate => candidate.id === exposure.gatewayId);
    const kind = `Delivery to ${gateway?.name ?? 'a gateway'}`;
    return [exposureSubjectId(exposure.id), { name: stream.name, kind, to: `streams/${stream.id}` }];
  });
}

/** What each subject that can fail is called, and where its page is. */
function namedSubjects({ streams, cameras, agents, gateways }: OverviewInputs) {
  return new Map([
    ...cameras.map(cameraSubject),
    ...agents.map(agentSubject),
    ...streams.flatMap(stream => exposureSubjects(stream, gateways))
  ]);
}

export function overviewOf(inputs: OverviewInputs): Overview {
  const { streams, cameras, agents, networks, channels, states } = inputs;
  const named = namedSubjects(inputs);
  // A failing subject that names nothing the organisation still has (a removed camera's last report) isn't a problem.
  const problems = states.flatMap((state): Problem[] => {
    const subject = named.get(state.subjectId);
    return subject && ownStatus(state) === 'failing' ? [{ subjectId: state.subjectId, ...subject }] : [];
  });
  return {
    fedStreams: streams.filter(stream => isFed(stream, cameras)),
    streamCount: streams.length,
    cameraCount: cameras.length,
    agentCount: agents.length,
    activeAgentCount: agents.filter(agent => agent.active).length,
    networkCount: networks.length,
    channelCount: channels.length,
    channelsOn: channels.filter(channel => channel.enabled).length,
    problems,
    reportingCount: states.length,
    setup: [
      { label: 'Add a network: the site your cameras are on', to: 'networks', done: networks.length > 0 },
      { label: 'Add an agent to it, and start it on a machine there', to: 'agents', done: agents.length > 0 },
      { label: 'Add a camera', to: 'cameras', done: cameras.length > 0 },
      { label: 'Create a stream from it', to: 'streams/new', done: streams.length > 0 }
    ]
  };
}
