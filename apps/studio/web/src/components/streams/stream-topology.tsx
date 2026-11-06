import { useLayoutEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { CloudIcon, HardDrivesIcon, NetworkIcon, VideoCameraIcon } from '@phosphor-icons/react';
import { cn } from '@conservationtv/ui/lib/utils';

import type { NodeKind, NodeStatus, Topology, TopologyNode } from '@/components/streams/topology';

/** A connector from a parent to its child, in its layout's own coordinates, and the port it leaves from. */
interface Connector {
  id: string;
  path: string;
  x: number;
  y: number;
  /** The node it leaves from, whose status its port takes; the connector takes its child's. */
  parentId: string;
}

/** Where a parent and child sit, relative to their layout: what a connector is routed between. */
interface Placement {
  parent: DOMRect;
  child: DOMRect;
  origin: DOMRect;
}

/** How far a connector's corners round. */
const CORNER = 6;
/** How far a connector drops from under its parent's icon, to the right of the parent's left edge. */
const DROP_PX = 14;
/** How far each step within a section is indented: past the connector's drop, so it turns into the child. */
const INDENT_REM = 1.75;

export interface StreamTopologyProps {
  topology: Topology;
  statuses: Map<string, NodeStatus>;
}

/**
 * The stream's source and exposures, each section (the network, the internet) a tree of its nodes in delivery order,
 * each node indented a step from what feeds it, and the sections side by side, joined across by their connectors.
 */
export const StreamTopology: FC<StreamTopologyProps> = ({ topology, statuses }) => {
  const { containerRef, register, connectors } = useConnectors(topology, routeBetween);
  return (
    <div className="overflow-x-auto">
      <div ref={containerRef} className="relative flex min-w-max gap-12">
        <Connectors connectors={connectors} statuses={statuses} />
        {topology.sections.map(section => (
          <section key={section.networkId ?? 'internet'} className="flex shrink-0 flex-col gap-2 last:flex-1">
            <SectionHeading label={section.label} network={section.networkId !== null} />
            {section.nodes.map(node => (
              <div
                key={node.id}
                className="flex items-center gap-1"
                style={{ paddingLeft: `${node.indent * INDENT_REM}rem` }}
              >
                <NodePill ref={register(node.id)} node={node} status={statuses.get(node.id) ?? 'unknown'} />
                {node.recording && <RecordingLabel status={statuses.get(node.id) ?? 'unknown'} />}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
};

/**
 * Connectors between the nodes the layout registers, measured from where they rendered and routed by `route`, so they
 * follow whatever width the labels give them.
 */
function useConnectors(topology: Topology, route: (placement: Placement) => ConnectorRoute) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pills = useRef(new Map<string, HTMLElement>());
  const [connectors, setConnectors] = useState<Connector[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const next = topology.nodes.flatMap((node): Connector[] => {
        // Only a node with a parent has a connector, and only once both have rendered.
        const from = node.parentId ? pills.current.get(node.parentId) : undefined;
        const to = pills.current.get(node.id);
        if (!node.parentId || !from || !to) return [];
        const routed = route({ parent: from.getBoundingClientRect(), child: to.getBoundingClientRect(), origin });
        return [{ id: node.id, parentId: node.parentId, ...routed }];
      });
      setConnectors(next);
    };
    measure();
    // Labels change width as the font loads, and the card as the window resizes.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const pill of pills.current.values()) observer.observe(pill);
    return () => observer.disconnect();
  }, [topology, route]);

  const register = (id: string) => (element: HTMLElement | null) => {
    if (element) pills.current.set(id, element);
    else pills.current.delete(id);
  };
  return { containerRef, register, connectors };
}

/** A connector's path, and the port it leaves its parent from. */
interface ConnectorRoute {
  path: string;
  x: number;
  y: number;
}

/** Across to a child in the next section over, otherwise down to a child indented beneath its parent. */
function routeBetween(placement: Placement): ConnectorRoute {
  return placement.child.left >= placement.parent.right ? routeAcross(placement) : routeDown(placement);
}

/** From the parent's right edge to the child's left: straight across on one row, otherwise stepping halfway. */
function routeAcross({ parent, child, origin }: Placement): ConnectorRoute {
  const x1 = parent.right - origin.left;
  const y1 = parent.top + parent.height / 2 - origin.top;
  const x2 = child.left - origin.left;
  const y2 = child.top + child.height / 2 - origin.top;
  return { path: connectorPath(x1, y1, x2, y2), x: x1, y: y1 };
}

/** From under the parent's icon, down to the child's row, then across into its left edge. */
function routeDown({ parent, child, origin }: Placement): ConnectorRoute {
  const x = parent.left + DROP_PX - origin.left;
  const y1 = parent.bottom - origin.top;
  const x2 = child.left - origin.left;
  const y2 = child.top + child.height / 2 - origin.top;
  const corner = Math.min(CORNER, (y2 - y1) / 2, (x2 - x) / 2);
  return { path: `M${x},${y1}V${y2 - corner}Q${x},${y2} ${x + corner},${y2}H${x2}`, x, y: y1 };
}

interface ConnectorsProps {
  connectors: Connector[];
  statuses: Map<string, NodeStatus>;
}

/** The connectors, each coloured by its child's status, with a port on each parent coloured by the parent's. */
const Connectors: FC<ConnectorsProps> = ({ connectors, statuses }) => {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
      {connectors.map(connector => {
        const status = statuses.get(connector.id) ?? 'unknown';
        return (
          <path
            key={connector.id}
            d={connector.path}
            fill="none"
            strokeWidth={1}
            className={connectorStroke[status]}
            strokeDasharray={status === 'failing' || status === 'affected' ? '2 3' : undefined}
          />
        );
      })}
      {uniqueBy(connectors, connector => `${connector.x},${connector.y}`).map(connector => (
        <circle
          key={`port-${connector.id}`}
          cx={connector.x}
          cy={connector.y}
          r={3.5}
          strokeWidth={1}
          className={cn('fill-background', connectorStroke[statuses.get(connector.parentId) ?? 'unknown'])}
        />
      ))}
    </svg>
  );
};

const connectorStroke = {
  ok: 'stroke-border',
  unknown: 'stroke-border',
  failing: 'stroke-destructive',
  affected: 'stroke-destructive/40'
} satisfies Record<NodeStatus, string>;

/** Straight across on one row; otherwise across to halfway, down, and across, with rounded corners. */
function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1}H${x2}`;
  const middle = x1 + (x2 - x1) / 2;
  const direction = Math.sign(y2 - y1);
  const corner = Math.min(CORNER, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
  return [
    `M${x1},${y1}`,
    `H${middle - corner}`,
    `Q${middle},${y1} ${middle},${y1 + corner * direction}`,
    `V${y2 - corner * direction}`,
    `Q${middle},${y2} ${middle + corner},${y2}`,
    `H${x2}`
  ].join('');
}

function uniqueBy<Item>(items: Item[], key: (item: Item) => string): Item[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

interface SectionHeadingProps {
  label: string;
  network: boolean;
}

/** A section's name, and a rule running to its edge that turns down at the end. */
const SectionHeading: FC<SectionHeadingProps> = ({ label, network }) => {
  return (
    <div className="flex items-center gap-2 pb-1 text-custom-13 text-foreground">
      {network && <NetworkIcon className="size-4 text-custom-icon-stream" aria-hidden="true" />}
      <span className="shrink-0">{label}</span>
      <span
        aria-hidden="true"
        className="ml-2 h-2 flex-1 translate-y-1 rounded-tr-sm border-t border-r border-border"
      />
    </div>
  );
};

const kindIcons = {
  camera: <VideoCameraIcon weight="fill" aria-hidden="true" />,
  server: <HardDrivesIcon aria-hidden="true" />,
  cloud: <CloudIcon aria-hidden="true" />
} satisfies Record<NodeKind, ReactNode>;

const statusDescriptions = {
  ok: 'healthy',
  unknown: 'not reported yet',
  failing: 'failing',
  affected: 'affected by a failure upstream'
} satisfies Record<NodeStatus, string>;

interface NodePillProps {
  ref: (element: HTMLElement | null) => void;
  node: TopologyNode;
  status: NodeStatus;
}

/** A node: dashed and red while failing, faded while something upstream fails. */
const NodePill: FC<NodePillProps> = ({ ref, node, status }) => {
  return (
    <div
      ref={ref}
      className={cn(
        'relative inline-flex h-8 items-center gap-2 rounded-lg border bg-card px-3 text-custom-13 whitespace-nowrap shadow-[0_0_6px_0_var(--custom-surface-shadow)] [&_svg]:size-4 [&_svg]:shrink-0',
        status === 'failing' && 'border-dashed border-destructive bg-destructive-subtle text-destructive shadow-none',
        status === 'affected' && 'border-dashed border-destructive/40 text-destructive/50 shadow-none',
        (status === 'ok' || status === 'unknown') && 'border-border text-foreground [&_svg]:text-custom-icon-stream'
      )}
    >
      {kindIcons[node.kind]}
      <span>{node.label}</span>
      <span className="sr-only">: {statusDescriptions[status]}</span>
    </div>
  );
};

interface RecordingLabelProps {
  status: NodeStatus;
}

/** Beside or under a recorded exposure: whether it is recording now, which it is not while it or anything feeding it fails. */
const RecordingLabel: FC<RecordingLabelProps> = ({ status }) => {
  const stopped = status === 'failing' || status === 'affected';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 pl-2 text-custom-10 font-semibold tracking-(--tracking-custom-label) uppercase',
        stopped ? 'text-destructive/60' : 'text-custom-recording'
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {stopped ? 'Not recording' : 'Recording'}
    </span>
  );
};
