import { useRef, useState, type ComponentProps, type FC, type ReactNode } from 'react';
import { AnimatePresence, motion, type HTMLMotionProps } from 'motion/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  SignalColumnGapContext,
  SignalItemContext,
  SignalMapContext,
  useSettled,
  useSignalAnchor,
  useSignalColumnGap,
  useSignalItem,
  useSignalMap,
  type SignalMapContextValue
} from '@/components/signal/signal-context';
import { drawing, item, quick, rail, spring } from '@/components/signal/signal-motion';

// The signal path on one screen: columns of nodes side by side, the gateways as rails between them, and the links
// drawn behind, measured from wherever the nodes rendered. Each is a part to compose.

type AnchorRef = (element: HTMLElement | null) => void;

/** What has a place on the map, and a count that goes up as places come and go. */
function useAnchors() {
  const [anchors] = useState(() => new Map<string, HTMLElement>());
  const [refs] = useState(() => new Map<string, AnchorRef>());
  const [version, setVersion] = useState(0);
  // One ref per id, kept, so a node re-rendering doesn't register again and have everything measured again.
  const anchor = (id: string): AnchorRef => {
    const existing = refs.get(id);
    if (existing) return existing;
    const ref: AnchorRef = element => {
      if (anchors.get(id) === (element ?? undefined)) return;
      if (element) anchors.set(id, element);
      else anchors.delete(id);
      setVersion(count => count + 1);
    };
    refs.set(id, ref);
    return ref;
  };
  return { anchor, anchors, version };
}

export interface SignalMapProps extends ComponentProps<'div'> {}

/** The map: its columns side by side, with the links drawn behind them. It scrolls sideways when it must. */
export const SignalMap: FC<SignalMapProps> = ({ className, children, ...props }) => {
  const container = useRef<HTMLDivElement>(null);
  const { anchor, anchors, version } = useAnchors();
  const settled = useSettled();
  const value: SignalMapContextValue = { anchor, anchors, container, version, settled };
  return (
    <SignalMapContext value={value}>
      <div className="overflow-x-auto">
        <div ref={container} className={cn('relative flex min-w-max items-stretch gap-20', className)} {...props}>
          {children}
        </div>
      </div>
    </SignalMapContext>
  );
};

export interface SignalColumnProps extends ComponentProps<'section'> {}

/** A column of the map: a header, then its nodes. */
export const SignalColumn: FC<SignalColumnProps> = ({ className, ...props }) => {
  return <section className={cn('relative z-10 flex shrink-0 flex-col gap-4', className)} {...props} />;
};

export interface SignalColumnHeaderProps extends ComponentProps<'header'> {}

/** A column's name, small and quiet; put a SignalColumnCount after it. */
export const SignalColumnHeader: FC<SignalColumnHeaderProps> = ({ className, ...props }) => {
  return (
    <header
      className={cn(
        'flex items-baseline gap-1.5 text-custom-10 font-semibold tracking-(--tracking-custom-label) text-muted-foreground uppercase',
        className
      )}
      {...props}
    />
  );
};

export interface SignalColumnCountProps extends ComponentProps<'span'> {}

/** How many, beside the column's name. */
export const SignalColumnCount: FC<SignalColumnCountProps> = ({ className, ...props }) => {
  return <span className={cn('font-normal text-muted-foreground', className)} {...props} />;
};

const columnGaps = { 3: 'gap-3', 4: 'gap-4', 5: 'gap-5' };

export interface SignalColumnContentProps extends HTMLMotionProps<'div'> {
  /** The space between its nodes, on the spacing scale. */
  gap?: keyof typeof columnGaps;
  /**
   * Where its first node comes in the map's first draw: its nodes come up one after another from there, a step
   * apart. The map's columns overlap a little, each starting before the last has finished.
   */
  order?: number;
  children?: ReactNode;
}

/** A column's nodes, stacked; on first draw they come up into place one after another. */
export const SignalColumnContent: FC<SignalColumnContentProps> = ({
  gap = 3,
  order = 0,
  className,
  children,
  ...props
}) => {
  return (
    <SignalColumnGapContext value={gap * 4}>
      <SignalItemContext value>
        <motion.div
          className={cn('flex flex-1 flex-col', columnGaps[gap], className)}
          variants={drawing(order)}
          initial="before"
          animate="drawn"
          {...props}
        >
          {children}
        </motion.div>
      </SignalItemContext>
    </SignalColumnGapContext>
  );
};

export interface SignalColumnItemProps {
  /** What it is: the same thing keeps one place in the column, whichever lane it's in. */
  id: string;
  className?: string;
  children: ReactNode;
}

/**
 * One of a column's things, wrapped so it slides to its new place when the column's order changes: up into the
 * column's lane when something goes wrong with it, and back down among the rest once it's right again.
 */
export const SignalColumnItem: FC<SignalColumnItemProps> = ({ id, className, children }) => {
  const isItem = useSignalItem();
  const { settled } = useSignalMap();
  return (
    <SignalItemContext value={false}>
      <motion.div
        layout="position"
        layoutId={`column-${id}`}
        variants={isItem ? item : undefined}
        // Moving between lanes mounts it afresh: once the map is drawn it arrives where it was, not from nothing.
        initial={settled ? false : undefined}
        transition={{ layout: spring }}
        className={cn('flex flex-col', className)}
      >
        {children}
      </motion.div>
    </SignalItemContext>
  );
};

export interface SignalLaneProps extends HTMLMotionProps<'section'> {
  children?: ReactNode;
}

/**
 * A lane at the head of a column, for what needs looking at, ruled off from the rest: put a SignalLaneHeader in it,
 * then the column's troubled things as SignalColumnItems. Render it only while there's something in it.
 */
export const SignalLane: FC<SignalLaneProps> = ({ className, style, children, ...props }) => {
  const isItem = useSignalItem();
  const { settled } = useSignalMap();
  const gap = useSignalColumnGap();
  return (
    <SignalItemContext value>
      <motion.section
        variants={isItem ? item : undefined}
        initial={settled ? false : undefined}
        style={{ gap, ...style }}
        className={cn('flex flex-col', className)}
        {...props}
      >
        {children}
        {/* A line between it and the rest, a gap below its last thing, sliding as the lane grows and shrinks; it
            fades in as the lane arrives, rather than arriving with it. */}
        <motion.div
          aria-hidden
          layout="position"
          className="h-px bg-border"
          initial={settled ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ ...quick, layout: spring }}
        />
      </motion.section>
    </SignalItemContext>
  );
};

export interface SignalLaneHeaderProps extends HTMLMotionProps<'header'> {}

/** The lane's name, as small as a column's; put a SignalColumnCount after it. */
export const SignalLaneHeader: FC<SignalLaneHeaderProps> = ({ className, ...props }) => {
  return (
    <motion.header
      layout="position"
      transition={{ layout: spring }}
      className={cn(
        'flex items-baseline gap-1.5 text-custom-10 font-semibold tracking-(--tracking-custom-label) text-destructive uppercase',
        className
      )}
      {...props}
    />
  );
};

export interface SignalRailsProps {
  children: ReactNode;
}

/** The map's rails, between two of its columns: one that turns up later slides in, and back out when it goes. */
export const SignalRails: FC<SignalRailsProps> = ({ children }) => {
  return <AnimatePresence initial>{children}</AnimatePresence>;
};

export interface SignalRailProps extends HTMLMotionProps<'section'> {
  /** What links name it by, in `via`. */
  id: string;
  /** A side whose links leave the rail a little above their nodes, curving down to them, instead of straight across. */
  gather?: 'left' | 'right';
  /** Always there: it only fades up with the page, where any other makes room for itself as it arrives. */
  permanent?: boolean;
  children?: ReactNode;
}

/**
 * A gateway as a rail between two columns: a line the length of the map that links run along, instead of each
 * crossing to every node it meets. One per gateway, side by side, inside SignalRails; put a SignalRailHead in it.
 */
export const SignalRail: FC<SignalRailProps> = ({ id, gather, permanent = false, className, children, ...props }) => {
  const anchor = useSignalAnchor(id);
  // Not positioned, so the links (drawn over the map) run over its line.
  return (
    <motion.section
      className={cn('-mx-8 flex w-6 shrink-0 flex-col items-center gap-4', className)}
      initial={permanent ? { ...rail.open, opacity: 0 } : rail.shut}
      animate={rail.open}
      exit={rail.shut}
      transition={spring}
      {...props}
    >
      {children}
      <div ref={anchor} data-gather={gather} className="w-0 flex-1 border-l border-dashed border-border" />
    </motion.section>
  );
};

export interface SignalRailHeadProps {
  /** What the rail is, said on hover. */
  label: string;
  /** Its icon, level with the columns' headers. */
  children: ReactNode;
}

/** A rail's head: an icon, and its name on hover. */
export const SignalRailHead: FC<SignalRailHeadProps> = ({ label, children }) => {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        className="relative z-10 flex h-[15px] items-center text-muted-foreground hover:text-foreground [&_svg]:size-4"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
  const anchor = useSignalAnchor(id);
  return (
    <div
      ref={anchor}
      aria-hidden
      data-lifted={lifted || undefined}
      className={cn('pointer-events-none absolute size-0', className)}
      {...props}
    />
  );
};
