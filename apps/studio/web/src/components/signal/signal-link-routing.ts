import type { SignalLink } from '@/components/signal/signal-topology';

// Where the links run: rectangles in, paths out. Each link goes from the facing edge of one node to the other's;
// one that names a rail runs out to it, along it, and off again, so a rail reads as one line with a tee for each
// thing on it. Nothing here touches the page.

export interface Point {
  x: number;
  y: number;
}

/** A point where a link meets something, named for whose point it is rather than which link found it. */
interface OwnedPoint extends Point {
  owner: string;
}

/** A stretch of a rail that a link runs along. */
interface Run {
  x: number;
  top: number;
  bottom: number;
}

export interface RoutedLink {
  link: SignalLink;
  /** The whole of it, end to end. */
  path: string;
  start: Point;
  end: Point;
  /** Where it meets a rail, for ports there too. */
  joins: OwnedPoint[];
  /** Along a rail: just the pieces out to it and off it; the run between is the rail's own trunk. */
  stubs?: string;
  runs: Run[];
}

/** A rail, or a group's join on one, as a link passes through it. */
export interface Waypoint {
  id: string;
  box: DOMRect;
  /** A join that sits where a curved link from its place would meet the rail, a little above it. */
  lifted: boolean;
}

export type Gather = 'left' | 'right' | 'both' | undefined;

const curve = (a: Point, b: Point) => {
  const middle = (a.x + b.x) / 2;
  return `C${String(middle)},${String(a.y)} ${String(middle)},${String(b.y)} ${String(b.x)},${String(b.y)}`;
};

/** From the facing edges of two nodes, centred on each, as a horizontal S-curve. */
export function routeAcross(link: SignalLink, from: DOMRect, to: DOMRect, origin: DOMRect): RoutedLink {
  const leftward = from.left > to.left;
  const start = {
    x: (leftward ? from.left - 8 : from.right + 8) - origin.left,
    y: from.top + from.height / 2 - origin.top
  };
  const end = { x: (leftward ? to.right + 8 : to.left - 8) - origin.left, y: to.top + to.height / 2 - origin.top };
  return { link, path: `M${String(start.x)},${String(start.y)}${curve(start, end)}`, start, end, joins: [], runs: [] };
}

interface RailRoute {
  link: SignalLink;
  from: DOMRect;
  to: DOMRect;
  /** Any joins, then the rail. */
  waypoints: Waypoint[];
  origin: DOMRect;
  /** The side (or both) whose links leave the rail a little above their nodes, each at its own point, curving. */
  gather: Gather;
}

/**
 * Along a rail: a curve from one node into its group's join (a point on the rail), or straight across to the rail if
 * it has none; along the rail; and straight off to the other node. A group's links share its join, so it meets the
 * rail once.
 */
export function routeAlongRail({ link, from, to, waypoints, origin, gather }: RailRoute): RoutedLink {
  const centreX = (box: DOMRect) => box.left + box.width / 2 - origin.left;
  const centreY = (box: DOMRect) => box.top + box.height / 2 - origin.top;
  const facing = (node: DOMRect, x: number) => (centreX(node) > x ? node.left - 8 : node.right + 8) - origin.left;
  const rail = waypoints[waypoints.length - 1].box;
  const railX = centreX(rail);
  const start = { x: facing(from, centreX(waypoints[0].box)), y: centreY(from) };
  const end = { x: facing(to, railX), y: centreY(to) };
  // A little above a node, but never above the rail's head.
  const above = (node: Point) => ({ x: railX, y: Math.max(rail.top - origin.top, node.y - 48) });
  const gathers = (node: DOMRect) => {
    const side = centreX(node) < railX ? 'left' : 'right';
    return gather === 'both' || side === gather;
  };
  const joins: OwnedPoint[] = [];
  let point: Point = start;
  let own = `M${String(start.x)},${String(start.y)}`;
  if (gathers(from)) {
    point = above(start);
    own += curve(start, point);
    joins.push({ ...point, owner: `rail:${link.from}` });
  }
  for (const join of waypoints.slice(0, -1)) {
    // A join sits on the rail, level with whatever marks it (a group's label), or a little above when lifted. The
    // map's usual S-curve runs into it, so a group's links fan out from its one point.
    const level = { x: railX, y: centreY(join.box) };
    const next = join.lifted ? above(level) : level;
    own += curve(point, next);
    joins.push({ ...next, owner: `join:${join.id}` });
    point = next;
  }
  // Straight to the rail, unless a join already put it there.
  if (point === start) {
    own += `H${String(railX)}`;
    point = { x: railX, y: start.y };
    joins.push({ ...point, owner: `rail:${link.from}` });
  }
  const leave = gathers(to) ? above(end) : { x: railX, y: end.y };
  joins.push({ ...leave, owner: `rail:${link.to}` });
  const off = gathers(to)
    ? `M${String(leave.x)},${String(leave.y)}${curve(leave, end)}`
    : `M${String(railX)},${String(end.y)}H${String(end.x)}`;
  const along = `M${String(railX)},${String(point.y)}V${String(leave.y)}`;
  return {
    link,
    path: own + along + off,
    stubs: own + off,
    runs: [{ x: railX, top: Math.min(point.y, leave.y), bottom: Math.max(point.y, leave.y) }],
    start,
    end,
    joins
  };
}

export interface Port extends Point {
  /** Where it is, to the pixel: two links ending at one place share it. */
  key: string;
  /** Whose it is: a node's end of a link, or a point on a rail. */
  owner: string;
  dimmed: boolean;
}

/** Ports where links end and meet rails, faded only when every link through them is. */
export function portsOf(routes: RoutedLink[], dimmed: (route: RoutedLink) => boolean): Port[] {
  const ports = new Map<string, Port>();
  const owners = new Set<string>();
  for (const route of routes) {
    // Named for the node (or join) each belongs to, so a port shared by many links is the same port whichever of
    // them come and go.
    const points: OwnedPoint[] = [
      { ...route.start, owner: `start:${route.link.from}` },
      { ...route.end, owner: `end:${route.link.to}` },
      ...route.joins
    ];
    for (const point of points) {
      const key = `${String(Math.round(point.x))},${String(Math.round(point.y))}`;
      const port = ports.get(key);
      if (port) port.dimmed &&= dimmed(route);
      // One port per owner, even if two links measure its place a hair apart.
      else if (!owners.has(point.owner)) {
        owners.add(point.owner);
        ports.set(key, { key, owner: point.owner, x: point.x, y: point.y, dimmed: dimmed(route) });
      }
    }
  }
  return [...ports.values()];
}

export interface Trunk extends Run {
  key: string;
}

/** Each rail's trunk: one line from the highest thing on it to the lowest. */
export function trunksOf(routes: RoutedLink[]): Trunk[] {
  const trunks = new Map<number, Trunk>();
  for (const run of routes.flatMap(route => route.runs)) {
    const key = Math.round(run.x);
    const trunk = trunks.get(key) ?? { key: `trunk-${String(key)}`, x: run.x, top: run.top, bottom: run.bottom };
    trunk.top = Math.min(trunk.top, run.top);
    trunk.bottom = Math.max(trunk.bottom, run.bottom);
    trunks.set(key, trunk);
  }
  return [...trunks.values()];
}
