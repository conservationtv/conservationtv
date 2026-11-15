import { useState, type ComponentProps, type FC } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { useSignalFocus, useSignalMap, useSignalTopology } from '@/components/signal/signal-context';
import { useLinkRoutes } from '@/components/signal/signal-link-routes';
import { portsOf, trunksOf, type Port, type RoutedLink, type Trunk } from '@/components/signal/signal-link-routing';
import { arrival, intro } from '@/components/signal/signal-motion';
import type { SignalStatus } from '@/components/signal/signal-system';

// The links between the map's nodes, drawn behind them. They keep to the nodes while those move, wipe in from the
// sources' side when the map first draws, fade in and out as they come and go, and ease between health colours.

const EASING = 'transition-[stroke,opacity] duration-300';

const linkStroke = {
  // One solid colour for every link that's fine (or can't be told), so where they cross and gather they stay that
  // colour, rather than building up into darker greys; only trouble changes it.
  ok: 'stroke-custom-connection',
  unknown: 'stroke-custom-connection',
  degraded: 'stroke-custom-warning',
  failing: 'stroke-destructive',
  affected: 'stroke-destructive/40'
} satisfies Record<SignalStatus, string>;

interface DrawnWireProps {
  wire: ComponentProps<'path'>;
  /** Dashed: it has a dash pattern of its own, so it fades in rather than being drawn. */
  plain: boolean;
  delay: number;
  duration: number;
}

/**
 * A link that draws itself along its length as it arrives, from its `from` end, and fades as it goes. Once drawn it
 * is an ordinary path again, so a dash pattern it takes on later (failing, switched off) shows.
 */
const DrawnWire: FC<DrawnWireProps> = ({ wire, plain, delay, duration }) => {
  const [drawn, setDrawn] = useState(plain);
  const { d, fill, strokeWidth, className } = wire;
  return (
    <motion.g
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.2, delay } }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
    >
      {drawn ? (
        <path {...wire} />
      ) : (
        <motion.path
          d={d}
          fill={fill}
          strokeWidth={strokeWidth}
          className={className}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration, delay, ease: [0.45, 0, 0.2, 1] }}
          onAnimationComplete={() => setDrawn(true)}
        />
      )}
    </motion.g>
  );
};

interface SignalWireProps {
  route: RoutedLink;
  /** Off the picked thing's path. */
  dimmed: boolean;
  /** Something is picked, and this wire is on its path. */
  followed: boolean;
}

/** Dashed: nothing is getting along it. */
const isCut = (route: RoutedLink) =>
  route.link.off === true || route.link.status === 'failing' || route.link.status === 'affected';

/**
 * One link's wire, coloured by its health. Along a rail, a link's run is the rail's (its trunk), drawn as its own
 * only when it's followed; its health colours its own pieces, out to the rail and off it, not the rail everyone
 * shares.
 */
const SignalWire: FC<SignalWireProps> = ({ route, dimmed, followed }) => {
  const { settled } = useSignalMap();
  const { link } = route;
  const dashed = isCut(route);
  // A link straight across is a broadcast's, on to a channel; one along a rail is a source's.
  const first = route.stubs === undefined ? intro.onward : intro.feeds;
  const timing = settled ? arrival.link : first;
  const wire = {
    d: followed ? route.path : (route.stubs ?? route.path),
    fill: 'none',
    strokeWidth: dimmed ? 1 : 1.25,
    strokeDasharray: dashed ? '3 3' : undefined,
    className: cn(link.off ? 'stroke-custom-connection' : linkStroke[link.status], dimmed && 'opacity-20', EASING)
  };
  return <DrawnWire wire={wire} plain={dashed} delay={timing.delay} duration={timing.duration} />;
};

interface SignalPortProps {
  port: Port;
}

/** A dot where a link ends or meets a rail; it fades in as its link is drawn. */
const SignalPort: FC<SignalPortProps> = ({ port }) => {
  const { settled } = useSignalMap();
  return (
    <motion.g
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: settled ? arrival.ports : intro.ports }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <circle
        key={port.key}
        cx={port.x}
        cy={port.y}
        r={3}
        className={cn('fill-foreground/70 stroke-background', port.dimmed && 'opacity-20', EASING)}
        strokeWidth={1.5}
      />
    </motion.g>
  );
};

interface SignalTrunkProps {
  trunk: Trunk;
  dimmed: boolean;
}

/** A rail's own line, from the highest thing on it to the lowest. */
const SignalTrunk: FC<SignalTrunkProps> = ({ trunk, dimmed }) => {
  const { settled } = useSignalMap();
  return (
    <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1, transition: settled ? arrival.ports : intro.ports }}>
      <path
        d={`M${String(trunk.x)},${String(trunk.top)}V${String(trunk.bottom)}`}
        fill="none"
        strokeWidth={1.25}
        className={cn('stroke-custom-connection', dimmed && 'opacity-20', EASING)}
      />
    </motion.g>
  );
};

/**
 * The map's links, each from the right edge of whichever end is further left to the other's left edge. Put it last
 * in the SignalMap; it draws behind the columns.
 */
export const SignalLinks: FC = () => {
  const topology = useSignalTopology();
  const focus = useSignalFocus();
  const routes = useLinkRoutes(topology.links);
  const off = (id: string) => focus.path !== null && !focus.path.has(id);
  const dimmed = (route: RoutedLink) => off(route.link.from) || off(route.link.to);
  const picking = routes.some(dimmed);
  // The faded wires first, so those on the picked path are drawn over them.
  const ordered = [...routes].sort((a, b) => Number(dimmed(b)) - Number(dimmed(a)));
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible">
      {trunksOf(routes).map(trunk => (
        <SignalTrunk key={trunk.key} trunk={trunk} dimmed={picking} />
      ))}
      <AnimatePresence>
        {ordered.map(route => (
          <SignalWire
            key={`${route.link.from}-${route.link.to}`}
            route={route}
            dimmed={dimmed(route)}
            followed={picking && !dimmed(route)}
          />
        ))}
      </AnimatePresence>
      <AnimatePresence>
        {/* Named for the link's end it marks, not where that is, so it keeps its place in the tree while it moves. */}
        {portsOf(routes, dimmed).map(port => (
          <SignalPort key={port.owner} port={port} />
        ))}
      </AnimatePresence>
    </svg>
  );
};
