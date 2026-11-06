import { layoutTopology, ownStatus, statusesOf, type NodeStatus, type Topology } from '@/components/streams/topology';
import type { ChartedStream } from '@/components/streams/stream-charts';

/** A stream as the page shows it: where it is delivered, and how each step of that is doing. */
export interface PageStream extends ChartedStream {
  name: string;
  sourceDeviceId: string | null;
  topology: Topology;
  statuses: Map<string, NodeStatus>;
}

export interface StreamPage {
  /** Streams whose source is feeding them: they have one and, if it is a camera, it is enabled. */
  active: PageStream[];
  inactive: PageStream[];
}

/** The parts of the API's resources the page reads, beyond what the topology layout does. */
type TopologyInputs = Parameters<typeof layoutTopology>[0];
type StreamInput = TopologyInputs['stream'] & ChartedStream & ListedStreamName;
interface ListedStreamName {
  name: string;
  sourceDeviceId: string | null;
}
interface CameraInput {
  id: string;
  state: string;
}
interface SubjectStateInput {
  subjectId: string;
  health: string;
  freshness: 'fresh' | 'stale';
}

export interface StreamPageInputs extends Omit<TopologyInputs, 'stream'> {
  streams: StreamInput[];
  cameras: CameraInput[];
  states: SubjectStateInput[];
}

/** Each stream laid out with the organisation's topology, its nodes' statuses from their states, split by activity. */
export function streamPageOf({ streams, cameras, states, ...topology }: StreamPageInputs): StreamPage {
  const stateOf = new Map(states.map(state => [state.subjectId, state]));
  const pageStreams = streams.map((stream): PageStream => {
    const laidOut = layoutTopology({ ...topology, stream });
    const own = new Map(laidOut.nodes.map(node => [node.id, ownStatus(stateOf.get(node.subjectId))]));
    return { ...stream, topology: laidOut, statuses: statusesOf(laidOut.nodes, own) };
  });
  const disabled = new Set(cameras.filter(camera => camera.state !== 'enabled').map(camera => camera.id));
  const isActive = (stream: PageStream) => stream.sourceDeviceId !== null && !disabled.has(stream.sourceDeviceId);
  return { active: pageStreams.filter(isActive), inactive: pageStreams.filter(stream => !isActive(stream)) };
}
