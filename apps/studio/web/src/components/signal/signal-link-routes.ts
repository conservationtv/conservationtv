import { useLayoutEffect, useState } from 'react';

import { useSignalMap } from '@/components/signal/signal-context';
import {
  routeAcross,
  routeAlongRail,
  type Gather,
  type RoutedLink,
  type Waypoint
} from '@/components/signal/signal-link-routing';
import { FOLLOW_MS } from '@/components/signal/signal-motion';
import type { SignalLink } from '@/components/signal/signal-topology';

const gatherOf = (rail: HTMLElement): Gather => {
  const side = rail.dataset.gather;
  return side === 'left' || side === 'right' ? side : undefined;
};

/** One link's route, from where its ends (and anything it runs through) are on the page; none, if an end isn't. */
function routeOf(link: SignalLink, anchors: Map<string, HTMLElement>, origin: DOMRect): RoutedLink[] {
  const from = anchors.get(link.from);
  const to = anchors.get(link.to);
  if (!from || !to) return [];
  const fromBox = from.getBoundingClientRect();
  const toBox = to.getBoundingClientRect();
  const passed = link.via.flatMap(id => {
    const element = anchors.get(id);
    return element ? [{ id, element }] : [];
  });
  const rail = passed.at(-1);
  if (!rail) return [routeAcross(link, fromBox, toBox, origin)];
  const waypoints = passed.map(({ id, element }): Waypoint => ({
    id,
    box: element.getBoundingClientRect(),
    lifted: element.dataset.lifted !== undefined
  }));
  const gather = link.curved ? 'both' : gatherOf(rail.element);
  return [routeAlongRail({ link, from: fromBox, to: toBox, waypoints, origin, gather })];
}

/**
 * The links' routes across the map, measured after layout, and again whenever a node or the map resizes. Nodes
 * easing into place move without resizing anything, so for a while after any change the routes follow them, frame by
 * frame.
 */
export function useLinkRoutes(links: SignalLink[]): RoutedLink[] {
  const { anchors, container, version } = useSignalMap();
  const [routes, setRoutes] = useState<RoutedLink[]>([]);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    let drawn: string | null = null;
    const measure = () => {
      const origin = element.getBoundingClientRect();
      const next = links.flatMap(link => routeOf(link, anchors, origin));
      // Measured every frame while following, so nothing is set unless something moved.
      const signature = `${String(origin.width)}x${String(origin.height)} ${next.map(route => route.path).join(' ')}`;
      if (signature === drawn) return;
      drawn = signature;
      setRoutes(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const anchor of anchors.values()) observer.observe(anchor);
    const until = performance.now() + FOLLOW_MS;
    let frame = requestAnimationFrame(function follow() {
      measure();
      if (performance.now() < until) frame = requestAnimationFrame(follow);
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [links, anchors, container, version]);

  return routes;
}
