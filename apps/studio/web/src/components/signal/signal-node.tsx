import type { ComponentProps, FC, ReactElement } from 'react';
import { motion } from 'motion/react';
import { cn } from '@conservationtv/ui/lib/utils';

import { StatusDot } from '@/components/common/status';
import {
  SignalItemContext,
  useSignalAnchor,
  useSignalItem,
  useSignalStanding,
  type SignalStanding
} from '@/components/signal/signal-context';
import { item, pressed, spring, tap } from '@/components/signal/signal-motion';
import { Swap } from '@/components/signal/signal-presence';
import { PRESSABLE, pressable } from '@/components/signal/signal-press';
import type { SignalStatus } from '@/components/signal/signal-system';

// One thing on the signal map, and the parts to compose inside it: its icon, its name, a line about it, its health.
// Links attach to its edges, wherever it rendered. It's an element like any other: given an `onClick`, it's pressable
// (what a thing on the view does is composed through <SignalThings>, and useSignalThing gives it its props).

type NodeVariant = 'plain' | 'card' | 'pill';

export interface SignalNodeProps extends ComponentProps<'div'> {
  /** What links name it by. */
  id: string;
  status?: SignalStatus;
  /** In place, but switched off. */
  off?: boolean;
  /** A row of text; a raised card; or a pill, as the stream topology draws them. */
  variant?: NodeVariant;
}

const nodeVariants = {
  plain: 'py-0.5',
  card: 'rounded-lg border border-border bg-card px-3 py-2 shadow-[0_0_6px_0_var(--custom-surface-shadow)]',
  pill: 'h-8 rounded-lg border border-border bg-card px-3 shadow-[0_0_6px_0_var(--custom-surface-shadow)]'
} satisfies Record<NodeVariant, string>;

const pickedVariants = {
  plain: 'bg-muted',
  card: '!border-foreground/25 !bg-muted',
  pill: '!border-foreground/25 !bg-muted'
} satisfies Record<NodeVariant, string>;

/** How its status shows on its outline; a plain row has none to show it on. */
function outlineOf(variant: NodeVariant, status: SignalStatus) {
  if (variant === 'plain') return false;
  if (status === 'failing') return 'border-dashed border-destructive bg-destructive-subtle shadow-none';
  if (status === 'affected') return 'border-dashed border-destructive/40 shadow-none';
  return status === 'degraded' && 'border-custom-warning/60';
}

interface NodeLook {
  variant: NodeVariant;
  status: SignalStatus;
  off: boolean;
  pressable: boolean;
  standing: SignalStanding;
  className: string | undefined;
}

/** The node's classes: its variant, then its state, then the caller's, then being picked over them all. */
function nodeClass({ variant, status, off, pressable: pressing, standing, className }: NodeLook) {
  return cn(
    'group/node relative flex w-full items-center gap-2 text-custom-13 whitespace-nowrap text-foreground transition-opacity',
    nodeVariants[variant],
    outlineOf(variant, status),
    status === 'affected' && 'text-destructive/60',
    off && 'border-dashed text-muted-foreground shadow-none',
    standing.dimmed && 'opacity-25',
    pressing && PRESSABLE,
    className,
    standing.picked && pickedVariants[variant]
  );
}

/**
 * One thing on the map. Compose its icon, title, meta and health inside. It fades back when something else is picked
 * and it isn't on that thing's path; it gives a little under a press, if it has one; and it comes in with its siblings
 * when it's one of a column's or an opened group's.
 */
export const SignalNode: FC<SignalNodeProps> = ({
  id,
  status = 'ok',
  off = false,
  variant = 'plain',
  onClick,
  onKeyDown,
  className,
  ...props
}) => {
  const anchor = useSignalAnchor(id);
  const standing = useSignalStanding(id);
  const isItem = useSignalItem();
  const pressing = pressable(onClick, onKeyDown);
  const node = (
    <SignalItemContext value={false}>
      <div
        ref={anchor}
        data-status={status}
        data-variant={variant}
        data-off={off || undefined}
        className={nodeClass({ variant, status, off, pressable: onClick !== undefined, standing, className })}
        // Its own handlers are in `pressing`; what else it's given (a link's role, say) has the last word.
        {...pressing}
        {...props}
      />
    </SignalItemContext>
  );
  return (
    <NodeBox pressable={onClick !== undefined} isItem={isItem}>
      {node}
    </NodeBox>
  );
};

interface NodeBoxProps {
  pressable: boolean;
  isItem: boolean;
  children: ReactElement;
}

/**
 * What moves, around a node, so its own opacity stays free for fading back off a picked path: it gives under a press,
 * if it has one; and one of a group's members slides to its new place when the order changes (something in the
 * group has stopped, say). Nothing, for a node that does neither.
 */
const NodeBox: FC<NodeBoxProps> = ({ pressable: pressing, isItem, children }) => {
  if (!pressing && !isItem) return children;
  return (
    <motion.div
      variants={isItem ? item : undefined}
      layout={isItem ? 'position' : undefined}
      whileTap={pressing ? pressed : undefined}
      transition={{ ...tap, layout: spring }}
    >
      {children}
    </motion.div>
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
  return <span className={cn('truncate group-data-[status=failing]/node:text-destructive', className)} {...props} />;
};

export interface SignalNodeMetaProps extends ComponentProps<'span'> {
  tone?: 'default' | 'warning' | 'destructive';
}

const metaTones = {
  default: 'text-custom-text-secondary',
  warning: 'text-custom-warning',
  destructive: 'text-destructive'
};

/** A line of detail under the title: its format, how many are watching, what's wrong with it. */
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
  tone?: 'recording' | 'destructive';
}

const flagTones = {
  recording: 'text-custom-recording',
  destructive: 'text-destructive'
};

/** A small capitalised word, with a dot before it: Recording, Not sending. */
export const SignalNodeFlag: FC<SignalNodeFlagProps> = ({ tone = 'recording', className, children, ...props }) => {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-custom-10 font-semibold tracking-(--tracking-custom-label) uppercase',
        flagTones[tone],
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
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

export interface SignalHealthProps {
  status: SignalStatus;
}

/** A health dot that pops when its status changes. */
export const SignalHealth: FC<SignalHealthProps> = ({ status }) => {
  return (
    <Swap id={status} kind="pop">
      <SignalHealthDot status={status} />
    </Swap>
  );
};

export interface SignalDotsProps extends ComponentProps<'span'> {
  /** One dot per member, in order. */
  statuses: SignalStatus[];
}

/** A row of health dots: a shut group's members at a glance. */
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
  unknown: 'bg-muted-foreground/40',
  idle: 'bg-muted-foreground/70',
  off: 'bg-muted-foreground/25'
} satisfies Record<SignalStatus, string>;

/** Health as three rising bars: how well a channel is receiving, not just whether. */
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
