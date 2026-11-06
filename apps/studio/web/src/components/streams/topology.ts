// A stream's delivery as its card draws it: the source device, then each exposure along the chain it publishes from, in
// delivery order (depth first, so each branch follows what feeds it). Nodes are grouped into sections, the network
// they're on or the internet, each drawn as a tree. What a node reports decides its status, and a failing node's status
// flows downstream: whatever it feeds is affected.

export type NodeKind = 'camera' | 'server' | 'cloud';

/**
 * `ok`: reporting healthy. `unknown`: nothing reported yet. `failing`: reporting unhealthy, or gone quiet.
 * `affected`: fed by a failing node.
 */
export type NodeStatus = 'ok' | 'unknown' | 'failing' | 'affected';

export interface TopologyNode {
  id: string;
  /** What reports about it: `device:<id>` or `exposure:<id>`. */
  subjectId: string;
  label: string;
  kind: NodeKind;
  /** The network it is on, or null for the internet. */
  networkId: string | null;
  parentId: string | null;
  /** How many steps it is from the start of its section: how far its row is indented. */
  indent: number;
  /** Whether a recorder records it. */
  recording: boolean;
}

/** A network, or the internet, and the nodes on it, in delivery order. */
export interface TopologySection {
  networkId: string | null;
  label: string;
  nodes: TopologyNode[];
}

export interface Topology {
  /** Every node, in delivery order. */
  nodes: TopologyNode[];
  /** In the order delivery reaches them. */
  sections: TopologySection[];
}

/** The parts of the API's resources the layout reads. */
interface ExposureInput {
  id: string;
  gatewayId: string;
  upstreamExposureId: string | null;
}
interface RecorderInput {
  exposureId: string;
}
interface StreamInput {
  sourceDeviceId: string | null;
  exposures: ExposureInput[];
  recorders: RecorderInput[];
}
interface DeviceInput {
  id: string;
  name: string;
  kind: string;
  networkId: string | null;
}
interface GatewayInput {
  id: string;
  name: string;
  networkId: string | null;
}
interface NetworkInput {
  id: string;
  name: string;
}

export interface TopologyInputs {
  stream: StreamInput;
  devices: DeviceInput[];
  gateways: GatewayInput[];
  networks: NetworkInput[];
}

/** A node before it has a place in the delivery. */
type UnplacedNode = Omit<TopologyNode, 'indent'>;

const SOURCE_ID = 'source';

/** Lay out the stream's source and exposures. An exposure whose upstream is missing hangs off the source. */
export function layoutTopology({ stream, devices, gateways, networks }: TopologyInputs): Topology {
  const source = devices.find(device => device.id === stream.sourceDeviceId);
  const unplaced = stream.exposures.map(exposure => exposureNode(stream, exposure, gateways, source !== undefined));
  if (source) unplaced.unshift(sourceNode(source));

  // Depth first, so each branch follows what feeds it. A node fed from another section starts its own section's tree.
  const nodes: TopologyNode[] = [];
  const place = (parent: TopologyNode | undefined) => {
    for (const node of unplaced.filter(candidate => candidate.parentId === (parent?.id ?? null))) {
      const indent = parent && parent.networkId === node.networkId ? parent.indent + 1 : 0;
      const placed = { ...node, indent };
      nodes.push(placed);
      place(placed);
    }
  };
  place(undefined);

  return { nodes, sections: sectionsOf(nodes, networks) };
}

function sourceNode(source: DeviceInput): UnplacedNode {
  return {
    id: SOURCE_ID,
    subjectId: `device:${source.id}`,
    label: source.name,
    kind: source.kind === 'camera' ? 'camera' : 'server',
    networkId: source.networkId,
    parentId: null,
    recording: false
  };
}

/** An exposure, named for its gateway, fed by its upstream if the stream has it, else by the source if there is one. */
function exposureNode(
  stream: StreamInput,
  exposure: ExposureInput,
  gateways: GatewayInput[],
  hasSource: boolean
): UnplacedNode {
  const gateway = gateways.find(candidate => candidate.id === exposure.gatewayId);
  const networkId = gateway?.networkId ?? null;
  const upstream = stream.exposures.find(candidate => candidate.id === exposure.upstreamExposureId);
  const fallback = hasSource ? SOURCE_ID : null;
  return {
    id: exposure.id,
    subjectId: `exposure:${exposure.id}`,
    label: gateway?.name ?? 'Unknown gateway',
    kind: networkId ? 'server' : 'cloud',
    networkId,
    parentId: upstream?.id ?? fallback,
    recording: stream.recorders.some(recorder => recorder.exposureId === exposure.id)
  };
}

/** The nodes grouped by the network they're on, or the internet, in the order delivery first reaches each. */
function sectionsOf(nodes: TopologyNode[], networks: NetworkInput[]): TopologySection[] {
  const sections: TopologySection[] = [];
  for (const node of nodes) {
    const existing = sections.find(section => section.networkId === node.networkId);
    if (existing) {
      existing.nodes.push(node);
      continue;
    }
    // The first node on a network opens its section.
    const network = networks.find(candidate => candidate.id === node.networkId);
    const label = node.networkId === null ? 'Internet' : (network?.name ?? 'Network');
    sections.push({ networkId: node.networkId, label, nodes: [node] });
  }
  return sections;
}

/** The parts of a subject's state that decide its status. */
export interface SubjectStatusInput {
  health: string;
  freshness: 'fresh' | 'stale';
}

/** A node's own status, from its subject's state: undefined when nothing has been derived for it yet. */
export function ownStatus(state: SubjectStatusInput | undefined): NodeStatus {
  if (!state) return 'unknown';
  if (state.freshness === 'stale' || state.health === 'unhealthy') return 'failing';
  return 'ok';
}

/** Every node's status, with failures flowing downstream: a node fed by a failing or affected one is affected. */
export function statusesOf(nodes: TopologyNode[], own: Map<string, NodeStatus>): Map<string, NodeStatus> {
  const statuses = new Map<string, NodeStatus>();
  for (const node of nodes) {
    // Nodes are placed parents first, so each parent's status is settled before its children's. A node's own failure
    // wins; otherwise a failure upstream makes it affected; otherwise it is as it reports.
    const self = own.get(node.id) ?? 'unknown';
    const parent = node.parentId ? statuses.get(node.parentId) : undefined;
    const upstreamDown = parent === 'failing' || parent === 'affected';
    statuses.set(node.id, self === 'failing' ? 'failing' : upstreamDown ? 'affected' : self);
  }
  return statuses;
}
