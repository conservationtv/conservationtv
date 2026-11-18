import type {
  SignalBroadcast,
  SignalChannel,
  SignalNetwork,
  SignalSource,
  SignalStatus,
  SignalSubgroup,
  SignalSystem
} from '@/components/signal/signal-system';

// What's wired to what, worked out once from the system and what's open: the same for the map and the stack. Pure;
// nothing here knows how any of it is drawn.

/** A wire between two things on the map. */
export interface SignalLink {
  from: string;
  to: string;
  status: SignalStatus;
  /** In place, but switched off: nothing is sent along it. */
  off?: boolean;
  /**
   * What it runs through, from `from` to `to`, instead of straight across: any joins first (a group's one point on
   * the rail, which its members' links curve into), then the rail it runs along: `['join-main', 'gateway']`.
   */
  via: string[];
  /** Along a rail: meet it a little above both ends, curving, whichever side the rail gathers. */
  curved?: boolean;
}

/** A camera or an ingest, with its health as seen from here. */
export interface SourceView extends SignalSource {
  /** Its health as seen: unknown when its network's agent can't be reached. */
  seen: SignalStatus;
}

/** A subgroup of a network's cameras. */
export interface SubgroupView {
  id: string;
  name: string;
  sources: SourceView[];
  /** Its health at a glance: as its network's, but it has no agent of its own to be down. */
  status: SignalStatus;
  /** What's wrong in it, when something is: "2 not sending". */
  trouble: string | null;
  /** Its cameras that have stopped: on show even while it's shut. */
  stopped: SourceView[];
}

/** A network and its cameras; or the ingests, which are no network's and are always listed one by one. */
export interface GroupView {
  id: string;
  name: string;
  network: SignalNetwork | null;
  /** Its agent can't be reached: nothing in it can be seen. */
  down: boolean;
  status: SignalStatus;
  /** What's wrong in it, when something is: "pi-05 not answering", "1 not sending". */
  trouble: string | null;
  /** Every member, grouped or not. */
  sources: SourceView[];
  /** Its members that have stopped, grouped or not: on show even while it's shut. */
  stopped: SourceView[];
  /** Its members that are in a subgroup, by subgroup; and the rest, listed after them. */
  subgroups: SubgroupView[];
  ungrouped: SourceView[];
}

export interface SignalTopology {
  system: SignalSystem;
  groups: GroupView[];
  links: SignalLink[];
  /** Everything a link can end at as things stand: what's shut inside a network isn't, unless it has stopped. */
  onPage: ReadonlySet<string>;
  /** How many things need looking at. */
  attention: number;
}

const INGESTS_ID = 'ingests';

/** A group's one point on its rail, which its members' links curve into. */
export const joinId = (group: string) => `join-${group}`;

const notSending = (sources: SourceView[]) => sources.filter(source => source.seen === 'failing').length;

/** Those with something wrong first, each lot in the order it came in. */
export function troubledFirst<T>(things: T[], troubled: (thing: T) => boolean): T[] {
  return [...things.filter(troubled), ...things.filter(thing => !troubled(thing))];
}

const sourceTroubled = (source: SourceView) => sourceTrouble(source) !== null;

function subgroupOf(subgroup: SignalSubgroup, members: SourceView[], down: boolean): SubgroupView {
  const sources = troubledFirst(
    members.filter(source => subgroup.cameras.includes(source.id)),
    sourceTroubled
  );
  const failing = notSending(sources);
  // Unknown with its network down; otherwise degraded by any camera of its own that has stopped.
  const status: SignalStatus = down ? 'unknown' : failing > 0 ? 'degraded' : 'ok';
  return {
    id: subgroup.id,
    name: subgroup.name,
    sources,
    status,
    trouble: failing > 0 ? `${String(failing)} not sending` : null,
    stopped: sources.filter(sourceTroubled)
  };
}

function networkGroup(system: SignalSystem, network: SignalNetwork): GroupView {
  const down = network.status === 'failing';
  // Within a network, whatever has stopped comes first: its cameras, and the subgroups holding them.
  const sources = troubledFirst(
    system.cameras
      .filter(camera => camera.network === network.id)
      .map((camera): SourceView => ({ ...camera, seen: down ? 'unknown' : camera.status })),
    sourceTroubled
  );
  const subgroups = troubledFirst(
    system.subgroups
      .filter(subgroup => subgroup.network === network.id)
      .map(subgroup => subgroupOf(subgroup, sources, down)),
    subgroup => subgroup.trouble !== null
  );
  const grouped = new Set(subgroups.flatMap(subgroup => subgroup.sources.map(source => source.id)));
  const failing = notSending(sources);
  // Failing with its agent down, whatever its cameras last said; otherwise degraded by any that has stopped.
  const status: SignalStatus = down ? 'failing' : failing > 0 ? 'degraded' : 'ok';
  const stopped = failing > 0 ? `${String(failing)} not sending` : null;
  return {
    id: network.id,
    name: network.name,
    network,
    down,
    status,
    trouble: down ? `${network.agent} not answering` : stopped,
    sources,
    stopped: sources.filter(sourceTroubled),
    subgroups,
    ungrouped: sources.filter(source => !grouped.has(source.id))
  };
}

function ingestGroup(system: SignalSystem): GroupView {
  const sources = troubledFirst(
    system.ingests.map((ingest): SourceView => ({ ...ingest, seen: ingest.status })),
    sourceTroubled
  );
  return {
    id: INGESTS_ID,
    name: 'Ingests',
    network: null,
    down: false,
    status: notSending(sources) > 0 ? 'degraded' : 'ok',
    trouble: null,
    sources,
    stopped: sources.filter(sourceTroubled),
    subgroups: [],
    ungrouped: sources
  };
}

/** A wire's source end: a network, a subgroup or a single source, and which broadcasts it reaches. */
interface Feed {
  id: string;
  group: string;
  status: SignalStatus;
  /** The broadcasts it feeds, in the system's order. */
  feeds: string[];
}

/** The broadcasts any of these sources feed, in the system's order. */
function fedBy(system: SignalSystem, sources: SourceView[]): string[] {
  return system.broadcasts
    .filter(broadcast => sources.some(source => source.feeds.includes(broadcast.id)))
    .map(broadcast => broadcast.id);
}

/**
 * What feeds the broadcasts: a wire per network; in the open one, one more per subgroup and per camera on show (those
 * in no subgroup, and those in the subgroup that's open); and one per ingest. A camera that has stopped is on show
 * whatever's shut, so it has its own wire either way. `open` holds the open network and the open subgroup alike.
 */
function feedsOf(system: SignalSystem, groups: GroupView[], open: string[]): Feed[] {
  return groups.flatMap((group): Feed[] => {
    const single = (source: SourceView): Feed => ({
      id: source.id,
      group: group.id,
      status: source.seen,
      feeds: fedBy(system, [source])
    });
    // A network's own wire, from its label to the rail, is there whether it's open or shut: first, so the point
    // where it meets the rail is its own, and its cameras' wires fan out from that.
    const own: Feed[] =
      group.network === null
        ? []
        : [{ id: group.id, group: group.id, status: group.status, feeds: fedBy(system, group.sources) }];
    // The ingests are always listed one by one; a network is, only when open.
    if (group.network !== null && !open.includes(group.id)) return [...own, ...group.stopped.map(single)];
    const within = group.subgroups.flatMap((subgroup): Feed[] => [
      { id: subgroup.id, group: group.id, status: subgroup.status, feeds: fedBy(system, subgroup.sources) },
      ...(open.includes(subgroup.id) ? subgroup.sources : subgroup.stopped).map(single)
    ]);
    return [...own, ...within, ...group.ungrouped.map(single)];
  });
}

function linksOf(system: SignalSystem, feeds: Feed[]): SignalLink[] {
  const first = system.gateways[0]?.id ?? 'gateway';
  const broadcastStatus = new Map(system.broadcasts.map(broadcast => [broadcast.id, broadcast.status]));
  const onward = system.channels.map((channel): SignalLink => ({
    from: channel.broadcast,
    to: channel.id,
    status: channel.status,
    off: channel.off,
    via: []
  }));
  const inward = feeds.flatMap(feed => {
    const rail = system.routes[feed.group] ?? first;
    // A network's cameras on show curve into its one point on the rail; anything else meets the rail on its own.
    const within = feed.group !== feed.id && feed.group !== INGESTS_ID;
    return feed.feeds.map((to): SignalLink => ({
      from: feed.id,
      to,
      // Nothing reaches a broadcast that's down: its feeds are cut there.
      status: broadcastStatus.get(to) === 'failing' ? 'affected' : feed.status,
      via: within ? [joinId(feed.group), rail] : [rail],
      curved: !within
    }));
  });
  return [...onward, ...inward];
}

function attentionOf(system: SignalSystem): number {
  return [
    ...system.networks.filter(network => network.status === 'failing'),
    ...system.cameras.filter(camera => camera.status === 'failing'),
    ...system.broadcasts.filter(broadcast => broadcast.status === 'failing'),
    ...system.channels.filter(channel => channel.status === 'degraded' || channel.status === 'failing')
  ].length;
}

/** The system as the page draws it, given what's open (a network, and a subgroup in it). */
export function topologyOf(system: SignalSystem, open: string[]): SignalTopology {
  const groups = [...system.networks.map(network => networkGroup(system, network)), ingestGroup(system)];
  const feeds = feedsOf(system, groups, open);
  return {
    system,
    groups,
    links: linksOf(system, feeds),
    onPage: new Set([
      ...system.channels.map(channel => channel.id),
      ...system.broadcasts.map(broadcast => broadcast.id),
      ...feeds.map(feed => feed.id)
    ]),
    attention: attentionOf(system)
  };
}

/** Every node a link path runs through from `id`: all it is fed by, and all it feeds. */
export function pathThrough(id: string, links: SignalLink[]): Set<string> {
  const reached = new Set([id]);
  // From `start`, along every link whose `next` end is the node in hand, to its other end; and on from there.
  const walk = (start: string, next: (link: SignalLink) => string) => {
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop();
      // The far end of each link that leaves (or arrives at) the node in hand.
      for (const link of links) {
        if (next(link) !== current) continue;
        const neighbour = link.from === current ? link.to : link.from;
        if (reached.has(neighbour)) continue;
        reached.add(neighbour);
        queue.push(neighbour);
      }
    }
  };
  walk(id, link => link.from);
  walk(id, link => link.to);
  return reached;
}

/** What's picked, and what that keeps in full while the rest fades. */
export interface SignalFocus {
  /** The picked thing, if it's still on the page. */
  picked: string | null;
  /** Everything on the picked thing's path: what its links run through. */
  path: ReadonlySet<string> | null;
  /** The path, and the groups that hold something on it: their labels stay in full, though their own wires fade. */
  lit: ReadonlySet<string> | null;
}

export const NO_FOCUS: SignalFocus = { picked: null, path: null, lit: null };

export function focusOf(topology: SignalTopology, picked: string | null): SignalFocus {
  // A pick that's no longer on the page (its network shut since) is dropped rather than fading everything.
  if (picked === null || !topology.onPage.has(picked)) return NO_FOCUS;
  const path = pathThrough(picked, topology.links);
  const holds = (sources: SourceView[]) => sources.some(source => path.has(source.id));
  const holders = topology.groups.flatMap(group => [
    ...(holds(group.sources) ? [group.id] : []),
    ...group.subgroups.filter(subgroup => holds(subgroup.sources)).map(subgroup => subgroup.id)
  ]);
  return { picked, path, lit: new Set([...path, ...holders]) };
}

// What things say about themselves when something's wrong: the same words on the map and in the stack.

export interface SignalTrouble {
  tone: 'warning' | 'destructive';
  text: string;
}

export function channelTrouble(channel: SignalChannel): SignalTrouble | null {
  if (channel.status === 'degraded') return { tone: 'warning', text: 'Dropping frames' };
  if (channel.status === 'failing') return { tone: 'destructive', text: 'Not sending' };
  if (channel.status === 'affected') return { tone: 'destructive', text: 'Its broadcast is down' };
  return null;
}

export const broadcastTrouble = (broadcast: SignalBroadcast) =>
  broadcast.status === 'failing' ? 'Renderer not answering' : null;

export const sourceTrouble = (source: SourceView) => (source.seen === 'failing' ? 'Not sending' : null);

// What goes in a column's lane at its head: whatever has something wrong to say about itself.

export const channelTroubled = (channel: SignalChannel) => channelTrouble(channel) !== null;
export const broadcastTroubled = (broadcast: SignalBroadcast) => broadcastTrouble(broadcast) !== null;
export const groupTroubled = (group: GroupView) => group.trouble !== null;
