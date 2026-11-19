import {
  deviceSubjectId,
  exposureSubjectId,
  forwardSubjectId,
  previewSubjectId,
  programSubjectId
} from '@/components/devices/subjects';
import { isFed } from '@/components/streams/stream-page';

// The organisation's overview, worked out from its lists: what is live, what is failing, and what a new organisation
// still has to set up. Pure derivation; the page reads the lists once, together.

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
  device: NamedDevice | null;
}
interface ListedGateway {
  id: string;
  name: string;
}
interface ListedOutput {
  id: string;
  name: string;
  forwards: ListedForward[];
  previews: ListedPreview[];
}
interface ListedForward {
  id: string;
  channelId: string;
}
interface ListedPreview {
  id: string;
  gatewayId: string;
}
interface ListedChannel {
  id: string;
  name: string;
}
/** A root cause, as the organisation's status names it (`organisations.status.get`). */
interface StatusProblem {
  subjectId: string;
  kind: string;
  name: string;
  status: 'failing' | 'degraded';
  reasons: string[];
  affects: AffectedGroup[];
}
interface AffectedGroup {
  kind: string;
  name: string;
}
interface StatusSubject {
  freshness: 'fresh' | 'stale' | null;
}
/** The parts of the organisation's status the overview reads. */
interface OrganisationStatus {
  summary: string;
  problems: StatusProblem[];
  subjects: StatusSubject[];
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
  outputs: ListedOutput[];
  channels: ListedChannel[];
  status: OrganisationStatus;
}

/**
 * A root cause of something not working: a subject failing or degraded itself, rather than fed by one that is. What it
 * is, by name, why, what that affects, and where to look at it.
 */
export interface Problem {
  /** The subject it is filed under: unique among problems. */
  subjectId: string;
  name: string;
  /** What kind of thing it is, in a word or two. */
  kind: string;
  status: 'failing' | 'degraded';
  /** Why, as its state's findings say: `Reachable 0% of the last 2 min`. */
  reasons: string[];
  /** What it affects, by name: `Tortoise, Broadcast`. Empty when nothing downstream of it is. */
  affects: string[];
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
  problems: Problem[];
  /** The organisation's status in a sentence or two, as the API sums it up. */
  summary: string;
  /** How many subjects have reported at all: with none, "nothing failing" would say more than is known. */
  reportingCount: number;
  setup: SetupStep[];
}

/** A problem's subject and what it is, before any is known to be failing. */
type NamedSubject = [subjectId: string, subject: Pick<Problem, 'name' | 'kind' | 'to'>];

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

/** An output's programme, forwards and previews, each named for the output and what it is. */
function outputSubjects(output: ListedOutput, channels: ListedChannel[], gateways: ListedGateway[]): NamedSubject[] {
  const to = `outputs/${output.id}`;
  const name = output.name;
  const forwards = output.forwards.map((forward): NamedSubject => {
    const channel = channels.find(candidate => candidate.id === forward.channelId);
    return [forwardSubjectId(forward.id), { name, kind: `Forward to ${channel?.name ?? 'a channel'}`, to }];
  });
  const previews = output.previews.map((preview): NamedSubject => {
    const gateway = gateways.find(candidate => candidate.id === preview.gatewayId);
    return [previewSubjectId(preview.id), { name, kind: `Preview at ${gateway?.name ?? 'a gateway'}`, to }];
  });
  return [[programSubjectId(output.id), { name, kind: 'Programme', to }], ...forwards, ...previews];
}

/** What each subject that can fail is called, and where its page is. */
function namedSubjects({ streams, cameras, agents, gateways, outputs, channels }: OverviewInputs) {
  return new Map([
    ...cameras.map(cameraSubject),
    ...agents.map(agentSubject),
    ...streams.flatMap(stream => exposureSubjects(stream, gateways)),
    ...outputs.flatMap(output => outputSubjects(output, channels, gateways))
  ]);
}

export function overviewOf(inputs: OverviewInputs): Overview {
  const { streams, cameras, agents, networks, status } = inputs;
  const named = namedSubjects(inputs);
  // The API names the root causes; here each only gains the page it is looked at on. One that has no page here (a
  // channel, say) isn't listed.
  const problems = status.problems.flatMap((problem): Problem[] => {
    const subject = named.get(problem.subjectId);
    if (!subject) return [];
    const { subjectId, reasons } = problem;
    const affects = [...new Set(problem.affects.map(group => group.name))].filter(name => name !== subject.name);
    return [{ ...subject, subjectId, status: problem.status, reasons, affects }];
  });
  return {
    fedStreams: streams.filter(stream => isFed(stream, cameras)),
    problems,
    summary: status.summary,
    reportingCount: status.subjects.filter(subject => subject.freshness !== null).length,
    setup: [
      { label: 'Add a network: the site your cameras are on', to: 'networks', done: networks.length > 0 },
      { label: 'Add an agent to it, and start it on a machine there', to: 'agents', done: agents.length > 0 },
      { label: 'Add a camera', to: 'cameras', done: cameras.length > 0 },
      { label: 'Create a stream from it', to: 'streams/new', done: streams.length > 0 }
    ]
  };
}
