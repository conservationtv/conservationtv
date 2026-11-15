import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FC,
  type ReactNode
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import { StatusDot, type Status } from '@/components/common/status';

// The organisation's signal path on one screen: the channels its broadcasts go out to, the broadcasts, the gateways
// they are composed at, and the sources that feed them. Each is a part to compose: columns of nodes, and the links
// drawn between them, measured from wherever the nodes rendered. Nothing here reads data; a page passes it in.

/** How a node or link is doing: the topology's four statuses, and degraded, for working but not well. */
export type SignalStatus = Status | 'degraded';

export interface SignalLink {
  from: string;
  to: string;
  status?: SignalStatus;
  /** In place, but switched off: nothing is sent along it. */
  off?: boolean;
  /** Marching dashes along it, for something being sent right now. */
  flowing?: boolean;
  /** Something to sit on the link's midpoint: a label, a switch. */
  label?: ReactNode;
  /**
   * What it runs through, from `from` to `to`, instead of straight across: any joins first (a group's one point on
   * the rail, which its members' links curve into), then the rail it runs along: `['join-main', 'gateway']`.
   */
  via?: string | string[];
  /** Along a rail: meet it a little above both ends, curving, whichever side the rail gathers. */
  curved?: boolean;
}

interface SignalMapContextValue {
  register: (id: string) => (element: HTMLElement | null) => void;
  /** Whether a node is off the highlighted path, and fades back. */
  isDimmed: (id: string) => boolean;
  links: SignalLink[];
  setLinks: (links: SignalLink[]) => void;
  elements: Map<string, HTMLElement>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  version: number;
}

const SignalMapContext = createContext<SignalMapContextValue | null>(null);

function useSignalMap(): SignalMapContextValue {
  const context = use(SignalMapContext);
  if (!context) throw new Error('A signal map part is rendered outside a SignalMap.');
  return context;
}

export interface SignalMapProps extends ComponentProps<'div'> {
  /**
   * Which way the signal reads: audience-first puts channels on the left and sources on the right, as the sketch
   * does; source-first runs it the way the signal flows. Columns are written in audience-first order either way.
   */
  flow?: 'audience-first' | 'source-first';
  /** A node whose whole path, upstream and downstream, stays in full while everything else fades back. */
  highlight?: string;
}

/** The map: its columns side by side, with the links drawn behind them. */
export const SignalMap: FC<SignalMapProps> = ({
  flow = 'audience-first',
  highlight,
  className,
  children,
  ...props
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<SignalLink[]>([]);
  const [version, setVersion] = useState(0);
  const path = highlight === undefined ? null : pathThrough(highlight, links);
  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  // One callback per node, kept, so a node re-rendering doesn't re-register and re-measure.
  const register = (id: string) => {
    const existing = callbacks.current.get(id);
    if (existing) return existing;
    const callback = (element: HTMLElement | null) => {
      const current = elements.current.get(id);
      if (current === (element ?? undefined)) return;
      if (element) elements.current.set(id, element);
      else elements.current.delete(id);
      setVersion(count => count + 1);
    };
    callbacks.current.set(id, callback);
    return callback;
  };
  const isDimmed = (id: string) => path !== null && !path.has(id);
  const value = {
    register,
    isDimmed,
    links,
    setLinks,
    elements: elements.current,
    containerRef,
    version
  };
  return (
    <SignalMapContext value={value}>
      <div className="overflow-x-auto">
        <div
          ref={containerRef}
          className={cn(
            'relative flex min-w-max items-stretch gap-20',
            flow === 'source-first' && 'flex-row-reverse justify-end',
            className
          )}
          {...props}
        >
          {children}
        </div>
      </div>
    </SignalMapContext>
  );
};

/** Every node a link path runs through from `id`: all it is fed by, and all it feeds. */
export function pathThrough(id: string, links: SignalLink[]): Set<string> {
  const reached = new Set([id]);
  const walk = (start: string, next: (link: SignalLink) => string | null) => {
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop();
      for (const link of links) {
        const neighbour = next(link) === current ? (link.from === current ? link.to : link.from) : null;
        if (neighbour !== null && !reached.has(neighbour)) {
          reached.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
  };
  walk(id, link => link.from);
  walk(id, link => link.to);
  return reached;
}

export interface SignalColumnProps extends ComponentProps<'section'> {}

/** A column of the map: a header, then its nodes. */
export const SignalColumn: FC<SignalColumnProps> = ({ className, ...props }) => {
  return <section className={cn('relative z-10 flex shrink-0 flex-col gap-4', className)} {...props} />;
};

export interface SignalColumnHeaderProps extends ComponentProps<'header'> {
  /** How many, beside the name. */
  count?: ReactNode;
}

/** A column's name, small and quiet. */
export const SignalColumnHeader: FC<SignalColumnHeaderProps> = ({ count, className, children, ...props }) => {
  return (
    <header
      className={cn(
        'flex items-baseline gap-1.5 text-custom-10 font-semibold tracking-(--tracking-custom-label) text-muted-foreground uppercase',
        className
      )}
      {...props}
    >
      {children}
      {count !== undefined && <span className="font-normal text-muted-foreground">{count}</span>}
    </header>
  );
};

export interface SignalColumnContentProps extends ComponentProps<'div'> {}

/** A column's nodes, stacked. Spread them with `justify-around` to sit beside what they link to. */
export const SignalColumnContent: FC<SignalColumnContentProps> = ({ className, ...props }) => {
  return <div className={cn('flex flex-1 flex-col gap-3', className)} {...props} />;
};

export interface SignalGroupProps extends ComponentProps<'div'> {}

/** A run of nodes under one heading: a platform's channels, or the ingests among the sources. */
export const SignalGroup: FC<SignalGroupProps> = ({ className, ...props }) => {
  return <div className={cn('flex flex-col gap-1.5', className)} {...props} />;
};

export interface SignalGroupLabelProps extends ComponentProps<'div'> {}

/** A group's heading: an icon, and the platform or kind. */
export const SignalGroupLabel: FC<SignalGroupLabelProps> = ({ className, ...props }) => {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-custom-13 font-medium text-foreground [&_svg]:size-4 [&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  );
};

export interface SignalNodeProps extends ComponentProps<'div'> {
  /** What links name it by. */
  id: string;
  status?: SignalStatus;
  /** In place, but switched off. */
  off?: boolean;
  /** A row of text; a raised card; or a pill, as the stream topology draws them. */
  variant?: 'plain' | 'card' | 'pill';
}

const nodeVariants = {
  plain: 'py-0.5',
  card: 'rounded-lg border border-border bg-card px-3 py-2 shadow-[0_0_6px_0_var(--custom-surface-shadow)]',
  pill: 'h-8 rounded-lg border border-border bg-card px-3 shadow-[0_0_6px_0_var(--custom-surface-shadow)]'
};

/** One thing on the map. Links attach to its edges; compose its icon, title, meta and health inside. */
export const SignalNode: FC<SignalNodeProps> = ({
  id,
  status = 'ok',
  off = false,
  variant = 'plain',
  className,
  ...props
}) => {
  // Outside a map (in a React Flow node, say) there's nothing to register with, and the host does any dimming.
  const map = use(SignalMapContext);
  const dimmed = map?.isDimmed(id) ?? false;
  const ref = map?.register(id);
  return (
    <div
      ref={ref}
      data-status={status}
      data-variant={variant}
      data-off={off || undefined}
      className={cn(
        'group/node relative flex w-full items-center gap-2 text-custom-13 whitespace-nowrap text-foreground transition-opacity',
        nodeVariants[variant],
        variant !== 'plain' && status === 'failing' && 'border-dashed border-destructive bg-destructive-subtle shadow-none',
        variant !== 'plain' && status === 'affected' && 'border-dashed border-destructive/40 shadow-none',
        variant !== 'plain' && status === 'degraded' && 'border-custom-warning/60',
        status === 'affected' && 'text-destructive/60',
        off && 'border-dashed text-muted-foreground shadow-none',
        dimmed && 'opacity-25',
        className
      )}
      {...props}
    />
  );
};

export interface SignalNodeIconProps extends ComponentProps<'span'> {}

/** The node's icon: its platform, or what kind of thing it is. */
export const SignalNodeIcon: FC<SignalNodeIconProps> = ({ className, ...props }) => {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center text-custom-icon-stream group-data-[status=failing]/node:text-destructive group-data-off/node:text-muted-foreground [&_svg]:size-4',
        className
      )}
      {...props}
    />
  );
};

export interface SignalNodeBodyProps extends ComponentProps<'div'> {}

/** The node's title over its meta lines. */
export const SignalNodeBody: FC<SignalNodeBodyProps> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', className)} {...props} />;
};

export interface SignalNodeTitleProps extends ComponentProps<'span'> {}

/** What the node is called. */
export const SignalNodeTitle: FC<SignalNodeTitleProps> = ({ className, ...props }) => {
  return (
    <span
      className={cn('truncate group-data-[status=failing]/node:text-destructive', className)}
      {...props}
    />
  );
};

export interface SignalNodeMetaProps extends ComponentProps<'span'> {
  tone?: 'default' | 'agent' | 'warning' | 'destructive';
}

const metaTones = {
  default: 'text-custom-text-secondary',
  agent: 'text-muted-foreground',
  warning: 'text-custom-warning',
  destructive: 'text-destructive'
};

/** A line of detail under the title: its format, where it is composed, what it is waiting on. */
export const SignalNodeMeta: FC<SignalNodeMetaProps> = ({ tone = 'default', className, ...props }) => {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-custom-12 [&_svg]:size-3 [&_svg]:shrink-0',
        metaTones[tone],
        className
      )}
      {...props}
    />
  );
};

export interface SignalNodeFlagProps extends ComponentProps<'span'> {
  tone?: 'recording' | 'muted' | 'destructive' | 'warning' | 'live';
}

const flagTones = {
  recording: 'text-custom-recording',
  muted: 'text-muted-foreground',
  destructive: 'text-destructive',
  warning: 'text-custom-warning',
  live: 'text-emerald-600 dark:text-emerald-400'
};

/** A small capitalised word beside the title: Recording, Off, Live. */
export const SignalNodeFlag: FC<SignalNodeFlagProps> = ({ tone = 'muted', className, children, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-custom-10 font-semibold tracking-(--tracking-custom-label) uppercase',
        flagTones[tone],
        className
      )}
      {...props}
    >
      {tone !== 'muted' && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
};

export interface SignalNodeActionsProps extends ComponentProps<'div'> {}

/** Controls at the node's end: a switch, a menu. */
export const SignalNodeActions: FC<SignalNodeActionsProps> = ({ className, ...props }) => {
  return <div className={cn('ml-auto flex items-center gap-1 pl-2', className)} {...props} />;
};

export interface SignalHealthDotProps extends ComponentProps<'span'> {
  status: SignalStatus;
}

/** Health as the app's status dot, with degraded in amber. */
export const SignalHealthDot: FC<SignalHealthDotProps> = ({ status, className, ...props }) => {
  if (status === 'degraded') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-block size-1.5 shrink-0 rounded-full bg-custom-warning', className)}
        {...props}
      />
    );
  }
  return <StatusDot status={status} className={className} {...props} />;
};

export interface SignalDotsProps extends ComponentProps<'span'> {
  /** One dot per member, in order. */
  statuses: SignalStatus[];
}

/** A row of health dots: a collapsed group's members at a glance. */
export const SignalDots: FC<SignalDotsProps> = ({ statuses, className, ...props }) => {
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)} {...props}>
      {statuses.map((status, index) => (
        // Dots have no identity of their own; their order is the members'.
        // eslint-disable-next-line react/no-array-index-key
        <SignalHealthDot key={index} status={status} className="size-2" />
      ))}
    </span>
  );
};

export interface SignalNodeRowsProps extends ComponentProps<'ul'> {}

/** A node's members listed inside it: the cameras on a network, opened. */
export const SignalNodeRows: FC<SignalNodeRowsProps> = ({ className, ...props }) => {
  return <ul className={cn('flex flex-col gap-1.5 border-t border-border pt-2', className)} {...props} />;
};

export interface SignalNodeRowProps extends ComponentProps<'li'> {}

/** One member: an icon, a name, and its dot trailing. */
export const SignalNodeRow: FC<SignalNodeRowProps> = ({ className, ...props }) => {
  return (
    <li
      className={cn(
        'flex items-center gap-2 text-custom-12 text-foreground [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
        className
      )}
      {...props}
    />
  );
};

export interface SignalBarsProps extends ComponentProps<'span'> {
  /** How many of the three bars are full. */
  level: 0 | 1 | 2 | 3;
  status: SignalStatus;
}

const barColours = {
  ok: 'bg-emerald-500',
  degraded: 'bg-custom-warning',
  failing: 'bg-destructive',
  affected: 'bg-destructive/40',
  unknown: 'bg-muted-foreground/40'
} satisfies Record<SignalStatus, string>;

/** Health as three rising bars, the sketch's: how well a channel is receiving, not just whether. */
export const SignalBars: FC<SignalBarsProps> = ({ level, status, className, ...props }) => {
  return (
    <span aria-hidden="true" className={cn('inline-flex h-3 items-end gap-0.5', className)} {...props}>
      {[1, 2, 3].map(bar => (
        <span
          key={bar}
          className={cn('w-1 rounded-[1px]', bar <= level ? barColours[status] : 'bg-muted-foreground/15')}
          style={{ height: `${String(bar * 33)}%` }}
        />
      ))}
    </span>
  );
};

export interface SignalAspectProps extends ComponentProps<'span'> {
  width: number;
  height: number;
}

/** A broadcast's frame, drawn at its own aspect: wide for the full broadcast, tall for social. */
export const SignalAspect: FC<SignalAspectProps> = ({ width, height, className, ...props }) => {
  const scale = 18 / Math.max(width, height);
  return (
    <span aria-hidden="true" className={cn('flex size-5 shrink-0 items-center justify-center', className)} {...props}>
      <span
        className="rounded-[2px] border-[1.5px] border-current bg-current/15 text-custom-icon-stream group-data-off/node:text-muted-foreground group-data-[status=failing]/node:text-destructive"
        style={{ width: width * scale, height: height * scale }}
      />
    </span>
  );
};

export interface SignalLinksProps {
  links: SignalLink[];
  /** Ports at each end, as the sketch draws them. */
  ports?: boolean;
  /** Curves, or the topology's stepped right angles. */
  shape?: 'curve' | 'step';
  /**
   * For a map whose nodes move: the links keep to the nodes while they do, wipe in from the sources' side when the
   * map first draws, fade in and out as they come and go, and ease between health colours.
   */
  animated?: boolean;
}

/** How long links are re-measured every frame after a change, to keep to nodes that are still moving. */
const FOLLOW_MS = 1200;
/** How long the first draw of an animated map's links takes, start to finish. */
const INTRO_MS = 1800;

interface DrawnWireProps {
  wire: ComponentProps<'path'>;
  /** Dashed or flowing: it has a dash pattern of its own, so it fades in rather than being drawn. */
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

/**
 * The links between nodes, each from the right edge of whichever end is further left to the other's left edge, so
 * they follow the map's flow either way. Measured after layout, and again whenever a node or the map resizes.
 */
export const SignalLinks: FC<SignalLinksProps> = ({ links, ports = true, shape = 'curve', animated = false }) => {
  const { elements, containerRef, setLinks, isDimmed, version } = useSignalMap();
  const [routes, setRoutes] = useState<RoutedLink[]>([]);
  // The first draw takes its time; once it's done, links that arrive come in quicker.
  const [settled, setSettled] = useState(!animated);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), INTRO_MS);
    return () => clearTimeout(timer);
  }, []);

  // The map only needs the links' ends, to work out a highlighted path; set them only when those change.
  const ends = links.map(link => `${link.from}>${link.to}`).join(' ');
  useLayoutEffect(() => {
    setLinks(links);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ends, not the array
  }, [ends, setLinks]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let drawn: string | null = null;
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const next = links.flatMap((link): RoutedLink[] => {
        const from = elements.get(link.from);
        const to = elements.get(link.to);
        if (!from || !to) return [];
        const fromBox = from.getBoundingClientRect();
        const toBox = to.getBoundingClientRect();
        const vias = (link.via === undefined ? [] : [link.via].flat()).flatMap(id => {
          const element = elements.get(id);
          return element ? [element] : [];
        });
        const gather = vias.at(-1)?.dataset.gather as 'left' | 'right' | undefined;
        const boxes = vias.map(element => element.getBoundingClientRect());
        const lifted = vias.map(element => element.dataset.lifted !== undefined);
        if (boxes.length > 0) {
          return [{ link, ...routeViaRails(fromBox, toBox, boxes, origin, link.curved ? 'both' : gather, lifted) }];
        }
        return [{ link, ...routeLink(fromBox, toBox, origin, shape) }];
      });
      // Measured every frame while following, so nothing is set unless something moved.
      const signature = `${String(origin.width)}x${String(origin.height)} ${next.map(route => route.path).join(' ')}`;
      if (signature === drawn) return;
      drawn = signature;
      setRoutes(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const element of elements.values()) observer.observe(element);
    // Nodes easing into place move without resizing anything, so for a while after a change, follow them.
    let frame = 0;
    if (animated) {
      const until = performance.now() + FOLLOW_MS;
      const follow = () => {
        measure();
        if (performance.now() < until) frame = requestAnimationFrame(follow);
      };
      frame = requestAnimationFrame(follow);
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [links, elements, containerRef, shape, version, animated]);

  const dimmedRoute = (route: RoutedLink) => isDimmed(route.link.from) || isDimmed(route.link.to);
  const highlighting = routes.some(dimmedRoute);
  const easing = animated && 'transition-[stroke,opacity] duration-300';
  const wires = [...routes]
    .sort((a, b) => Number(dimmedRoute(b)) - Number(dimmedRoute(a)))
    .map(route => {
      const { link } = route;
      const dimmed = dimmedRoute(route);
      const status = link.status ?? 'ok';
      const dashed = link.off || status === 'failing' || status === 'affected';
      const key = `${link.from}-${link.to}`;
      const wire = {
        // Along a rail, a link's run is the rail's (its trunk), drawn as its own only when it's picked; its
        // health colours its own pieces, out to the rail and off it, not the rail everyone shares.
        d: route.stubs === undefined || (highlighting && !dimmed) ? route.path : route.stubs,
        fill: 'none',
        strokeWidth: dimmed ? 1 : 1.25,
        strokeDasharray: link.flowing ? '4 4' : dashed ? '3 3' : undefined,
        className: cn(
          link.off ? 'stroke-muted-foreground/40' : linkStroke[status],
          link.flowing && 'animate-[signal-flow_0.8s_linear_infinite]',
          dimmed && 'opacity-20',
          easing
        )
      };
      if (!animated) return <path key={key} {...wire} />;
      // On first draw the links run the way the signal does: out of the sources and along the rails, then on from
      // the broadcasts to the channels. One arriving later draws itself in a little quicker.
      const onward = route.stubs === undefined;
      const timing = settled
        ? { delay: 0.15, duration: 0.5 }
        : { delay: onward ? 1.05 : 0.45, duration: onward ? 0.6 : 0.75 };
      return <DrawnWire key={key} wire={wire} plain={link.flowing || dashed} {...timing} />;
    });
  const arrive = settled ? { duration: 0.3, delay: 0.3 } : { duration: 0.5, delay: 0.8 };
  const dots = uniquePorts(routes, dimmedRoute).map(port => {
    const dot = (
      <circle
        key={port.key}
        cx={port.x}
        cy={port.y}
        r={3}
        className={cn('fill-foreground/70 stroke-background', port.dimmed && 'opacity-20', easing)}
        strokeWidth={1.5}
      />
    );
    if (!animated) return dot;
    // Named for the link's end it marks, not where that is, so it keeps its place in the tree while it moves; and
    // it fades in as its link is drawn.
    return (
      <motion.g
        key={port.owner}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: arrive }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
      >
        {dot}
      </motion.g>
    );
  });
  const trunks = trunksOf(routes).map(trunk => {
    const line = (
      <path
        key={trunk.key}
        d={`M${trunk.x},${trunk.top}V${trunk.bottom}`}
        fill="none"
        strokeWidth={1.25}
        className={cn('stroke-foreground/35', highlighting && 'opacity-20', easing)}
      />
    );
    if (!animated) return line;
    return (
      <motion.g key={trunk.key} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: arrive }}>
        {line}
      </motion.g>
    );
  });
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 size-full overflow-visible">
        {trunks}
        {animated ? <AnimatePresence>{wires}</AnimatePresence> : wires}
        {ports && (animated ? <AnimatePresence>{dots}</AnimatePresence> : dots)}
      </svg>
      {routes.map(({ link, middle }) =>
        link.label === undefined ? null : (
          <div
            key={`label-${link.from}-${link.to}`}
            className={cn(
              'absolute z-20 -translate-x-1/2 -translate-y-1/2',
              (isDimmed(link.from) || isDimmed(link.to)) && 'opacity-25'
            )}
            style={{ left: middle.x, top: middle.y }}
          >
            {link.label}
          </div>
        )
      )}
      <style>{'@keyframes signal-flow { to { stroke-dashoffset: -8; } }'}</style>
    </>
  );
};

const linkStroke = {
  ok: 'stroke-foreground/35',
  unknown: 'stroke-foreground/20',
  degraded: 'stroke-custom-warning',
  failing: 'stroke-destructive',
  affected: 'stroke-destructive/40'
} satisfies Record<SignalStatus, string>;

interface RoutedLink {
  link: SignalLink;
  path: string;
  start: Point;
  end: Point;
  middle: Point;
  /** Where it meets a rail, for ports there too; each named for whose point on the rail it is. */
  joins?: (Point & { owner: string })[];
  /** Along rails: just the pieces out to and off each, and where it runs along them. */
  stubs?: string;
  runs?: Run[];
}

interface Run {
  x: number;
  top: number;
  bottom: number;
}

interface Point {
  x: number;
  y: number;
}

/** From the facing edges of two nodes, centred on each, as a horizontal S-curve or a stepped right angle. */
function routeLink(from: DOMRect, to: DOMRect, origin: DOMRect, shape: 'curve' | 'step') {
  const leftward = from.left > to.left;
  const startX = (leftward ? from.left - 8 : from.right + 8) - origin.left;
  const endX = (leftward ? to.right + 8 : to.left - 8) - origin.left;
  const startY = from.top + from.height / 2 - origin.top;
  const endY = to.top + to.height / 2 - origin.top;
  const middleX = (startX + endX) / 2;
  const path =
    shape === 'curve'
      ? `M${startX},${startY}C${middleX},${startY} ${middleX},${endY} ${endX},${endY}`
      : steppedPath(startX, startY, endX, endY);
  return {
    path,
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
    middle: { x: middleX, y: (startY + endY) / 2 }
  };
}

/**
 * Along a rail: a curve from one node into its group's join (a point on the rail), or straight across to the rail if
 * it has none; along the rail; and straight off to the other node. A group's links share its join, so it meets the
 * rail once, and the rail reads as one line with a tee for each thing on it.
 */
function routeViaRails(
  from: DOMRect,
  to: DOMRect,
  vias: DOMRect[],
  origin: DOMRect,
  gather?: 'left' | 'right' | 'both',
  /** Which of the joins sit where a curved link from their place would meet the rail, a little above them. */
  lifted: boolean[] = []
) {
  const centreX = (box: DOMRect) => box.left + box.width / 2 - origin.left;
  const centreY = (box: DOMRect) => box.top + box.height / 2 - origin.top;
  const facing = (node: DOMRect, x: number) => (centreX(node) > x ? node.left - 8 : node.right + 8) - origin.left;
  const rail = vias[vias.length - 1];
  const railX = centreX(rail);
  const start = { x: facing(from, centreX(vias[0])), y: centreY(from) };
  const end = { x: facing(to, railX), y: centreY(to) };
  // A rail that gathers one side: links to that side leave it a little above their nodes (never above its head), each
  // at its own point, curving down to them.
  const above = (node: Point) => ({ x: railX, y: Math.max(rail.top - origin.top, node.y - 48) });
  const gathers = (node: DOMRect) =>
    gather === 'both' || (gather !== undefined && (centreX(node) < railX ? 'left' : 'right') === gather);
  const curve = (a: Point, b: Point) => {
    const middle = (a.x + b.x) / 2;
    return `C${middle},${a.y} ${middle},${b.y} ${b.x},${b.y}`;
  };
  // Each point on the rail is named for whose it is, not which link found it: a broadcast's stays the same point
  // whichever sources happen to be wired to it.
  const joins: (Point & { owner: string })[] = [];
  let point = start;
  let own = `M${start.x},${start.y}`;
  if (gathers(from)) {
    point = above(start);
    own += curve(start, point);
    joins.push({ ...point, owner: 'from' });
  }
  for (const [index, join] of vias.slice(0, -1).entries()) {
    // A join sits on the rail, level with whatever marks it (a group's label).
    const next = lifted[index] ? above({ x: railX, y: centreY(join) }) : { x: railX, y: centreY(join) };
    // The map's usual S-curve, so a group's links fan out from its one point.
    own += curve(point, next);
    joins.push({ ...next, owner: `via-${String(index)}` });
    point = next;
  }
  // Straight to the rail, unless a join already put it there.
  if (point === start) {
    own += `H${railX}`;
    joins.push({ x: railX, y: point.y, owner: 'from' });
  }
  const leave = gathers(to) ? above(end) : { x: railX, y: end.y };
  joins.push({ ...leave, owner: 'to' });
  const off = gathers(to) ? `M${leave.x},${leave.y}${curve(leave, end)}` : `M${railX},${end.y}H${end.x}`;
  const run: Run = { x: railX, top: Math.min(point.y, leave.y), bottom: Math.max(point.y, leave.y) };
  const along = `M${railX},${point.y}V${leave.y}`;
  return {
    path: own + along + off,
    stubs: own + off,
    runs: [run],
    start,
    end,
    // A label sits on the wire's first piece, beside the thing it leaves: a source's wire to cut, say.
    middle: { x: (start.x + joins[0].x) / 2, y: start.y },
    joins
  };
}

function steppedPath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1}H${x2}`;
  const middle = (x1 + x2) / 2;
  const vertical = Math.sign(y2 - y1);
  const horizontal = Math.sign(x2 - x1);
  const corner = Math.min(6, Math.abs(y2 - y1) / 2, Math.abs(x2 - x1) / 2);
  return [
    `M${x1},${y1}`,
    `H${middle - corner * horizontal}`,
    `Q${middle},${y1} ${middle},${y1 + corner * vertical}`,
    `V${y2 - corner * vertical}`,
    `Q${middle},${y2} ${middle + corner * horizontal},${y2}`,
    `H${x2}`
  ].join('');
}

/** Ports where links end, faded only when every link through them is. */
function uniquePorts(routes: RoutedLink[], dimmed: (route: RoutedLink) => boolean) {
  const ports = new Map<string, { key: string; owner: string; x: number; y: number; dimmed: boolean }>();
  const owners = new Set<string>();
  for (const route of routes) {
    const { from, to, via } = route.link;
    const vias = via === undefined ? [] : [via].flat();
    // Named for the node (or join) each belongs to, so a port shared by many links is the same port whichever of
    // them come and go.
    const named = [
      { ...route.start, owner: `start:${from}` },
      { ...route.end, owner: `end:${to}` },
      ...(route.joins ?? []).map(join => ({
        ...join,
        owner:
          join.owner === 'from'
            ? `rail:${from}`
            : join.owner === 'to'
              ? `rail:${to}`
              : `join:${vias[Number(join.owner.slice(4))] ?? from}`
      }))
    ];
    for (const point of named) {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
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

/** Each rail's trunk: one line from the highest thing on it to the lowest. */
function trunksOf(routes: RoutedLink[]) {
  const trunks = new Map<number, Run & { key: string }>();
  for (const run of routes.flatMap(route => route.runs ?? [])) {
    const key = Math.round(run.x);
    const trunk = trunks.get(key) ?? { key: `trunk-${String(key)}`, x: run.x, top: run.top, bottom: run.bottom };
    trunk.top = Math.min(trunk.top, run.top);
    trunk.bottom = Math.max(trunk.bottom, run.bottom);
    trunks.set(key, trunk);
  }
  return [...trunks.values()];
}

export interface SignalLinkLabelProps extends ComponentProps<'span'> {}

/** A word on a link's midpoint, on the canvas so the line runs behind it: the gateway it passes through. */
export const SignalLinkLabel: FC<SignalLinkLabelProps> = ({ className, ...props }) => {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-custom-11 whitespace-nowrap text-custom-text-secondary [&_svg]:size-3',
        className
      )}
      {...props}
    />
  );
};

export interface SignalRailProps extends ComponentProps<'section'> {
  /** What links name it by, in `via`. */
  id: string;
  /** At its head, level with the columns' headers; the label shows on hover. */
  icon: ReactNode;
  label: ReactNode;
  /** A side whose links leave the rail a little above their nodes, curving down to them, instead of straight across. */
  gather?: 'left' | 'right';
}

/**
 * A gateway as a rail between two columns: a line the length of the map that links run along, instead of each
 * crossing to every node it meets. One per gateway; put several side by side.
 */
export const SignalRail: FC<SignalRailProps> = ({ id, icon, label, gather, className, ...props }) => {
  const map = use(SignalMapContext);
  const ref = map?.register(id);
  // Not positioned, so the links (drawn over the map) run over its line.
  return (
    <section className={cn('-mx-8 flex w-6 shrink-0 flex-col items-center gap-4', className)} {...props}>
      <Tooltip>
        <TooltipTrigger
          aria-label={typeof label === 'string' ? label : undefined}
          className="relative z-10 flex h-[15px] items-center text-muted-foreground hover:text-foreground [&_svg]:size-4"
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <div ref={ref} data-gather={gather} className="w-0 flex-1 border-l border-dashed border-border" />
    </section>
  );
};

export interface SignalJoinProps extends ComponentProps<'div'> {
  /** What links name it by, in `via`. */
  id: string;
  /**
   * Meet the rail a little above this, where a curved link from the same place does: for a group whose label keeps
   * its own wire to the rail, so its members fan out from the point that wire reaches.
   */
  lifted?: boolean;
}

/**
 * Where a group meets the rail: its members' links curve into one point on it, level with this. Invisible; position
 * it (absolutely) at the group's label.
 */
export const SignalJoin: FC<SignalJoinProps> = ({ id, lifted, className, ...props }) => {
  const map = use(SignalMapContext);
  const ref = map?.register(id);
  return (
    <div
      ref={ref}
      aria-hidden
      data-lifted={lifted || undefined}
      className={cn('pointer-events-none absolute size-0', className)}
      {...props}
    />
  );
};

// A path written as a line, for where there is no room for the map: a phone, a summary, a show's header.

export interface SignalChainProps extends ComponentProps<'div'> {}

/** Steps in a row, joined by arrows, wrapping as it must. */
export const SignalChain: FC<SignalChainProps> = ({ className, ...props }) => {
  return <div className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-1', className)} {...props} />;
};

export interface SignalChainStepProps extends ComponentProps<'span'> {
  status?: SignalStatus;
}

/** One step: a chip with its health dot. */
export const SignalChainStep: FC<SignalChainStepProps> = ({ status = 'ok', className, children, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-custom-12 whitespace-nowrap [&_svg]:size-3.5 [&_svg]:text-custom-icon-stream',
        status === 'failing' && 'border-dashed border-destructive bg-destructive-subtle text-destructive',
        status === 'affected' && 'border-dashed border-destructive/40 text-destructive/60',
        className
      )}
      {...props}
    >
      {children}
      <SignalHealthDot status={status} />
    </span>
  );
};

/** Between steps. */
export const SignalChainArrow: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return (
    <span aria-hidden="true" className={cn('text-custom-12 text-muted-foreground', className)} {...props}>
      ←
    </span>
  );
};

// Counts in place of the map, for a glance: each column as a number and how many of them are well.

export interface SignalTallyProps extends ComponentProps<'div'> {}

/** A column's count, its label and its health breakdown. */
export const SignalTally: FC<SignalTallyProps> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-28 flex-col gap-1', className)} {...props} />;
};

export interface SignalTallyValueProps extends ComponentProps<'span'> {}

export const SignalTallyValue: FC<SignalTallyValueProps> = ({ className, ...props }) => {
  return <span className={cn('text-custom-21 font-semibold tabular-nums', className)} {...props} />;
};

export interface SignalTallyBreakdownProps extends ComponentProps<'span'> {
  counts: Partial<Record<SignalStatus, number>>;
}

/** A segmented bar: green for well, amber degraded, red failing, grey not reported. */
export const SignalTallyBreakdown: FC<SignalTallyBreakdownProps> = ({ counts, className, ...props }) => {
  const order: SignalStatus[] = ['ok', 'degraded', 'failing', 'affected', 'unknown'];
  return (
    <span className={cn('flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full', className)} {...props}>
      {order.map(status => {
        const count = counts[status] ?? 0;
        return count > 0 ? <span key={status} className={barColours[status]} style={{ flex: count }} /> : null;
      })}
    </span>
  );
};
